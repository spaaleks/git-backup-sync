import { createServer } from 'node:http';
import { log } from './logger.js';
import { parseCron, nextRun } from './cron.js';

const PREFIX = 'gbs';

class Text {
  constructor() {
    this.lines = [];
  }

  metric(name, help, type, samples) {
    if (samples.length === 0) return this;
    this.lines.push(`# HELP ${PREFIX}_${name} ${help}`);
    this.lines.push(`# TYPE ${PREFIX}_${name} ${type}`);
    for (const { labels, value } of samples) {
      this.lines.push(`${PREFIX}_${name}${renderLabels(labels)} ${value}`);
    }
    return this;
  }

  toString() {
    return this.lines.join('\n') + '\n';
  }
}

function renderLabels(labels) {
  if (!labels) return '';
  const parts = Object.entries(labels)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

const seconds = (iso) => (iso ? Math.floor(new Date(iso).getTime() / 1000) : null);

export function render({ config, state, lastReport, startedAt, version = '1.0.0' }) {
  const t = new Text();
  const now = Math.floor(Date.now() / 1000);

  t.metric('build_info', 'Build information.', 'gauge', [{ labels: { version }, value: 1 }]);
  t.metric('up', 'Always 1 while the scheduler is serving metrics.', 'gauge', [{ value: 1 }]);
  t.metric('start_time_seconds', 'Unix time the process started.', 'gauge', [
    { value: Math.floor(startedAt / 1000) },
  ]);

  const runs = state.runs ?? [];
  const last = runs.at(-1);
  if (last) {
    t.metric('last_run_start_seconds', 'Unix time the last run started.', 'gauge', [{ value: seconds(last.startedAt) }]);
    t.metric('last_run_duration_seconds', 'Duration of the last run.', 'gauge', [
      { value: (last.durationMs ?? 0) / 1000 },
    ]);
    t.metric('last_run_age_seconds', 'Seconds since the last run started. Alert on this.', 'gauge', [
      { value: now - (seconds(last.startedAt) ?? now) },
    ]);
    t.metric('last_run_ok', 'Whether the last run completed without an abort or any failure.', 'gauge', [
      { value: !last.fatal && (last.failed ?? 0) === 0 ? 1 : 0 },
    ]);
  }
  t.metric('runs_total', 'Runs recorded in state.', 'gauge', [{ value: runs.length }]);

  if (lastReport?.totals) {
    t.metric(
      'last_run_repos',
      'Repositories in the last run by outcome.',
      'gauge',
      Object.entries(lastReport.totals)
        .filter(([key]) => ['new', 'changed', 'unchanged', 'failed', 'vanished', 'excluded', 'moved', 'remapped'].includes(key))
        .map(([status, value]) => ({ labels: { status }, value })),
    );
  }

  const configured = new Map((config.sources ?? []).map((s) => [s.name, s]));
  const tracked = [];
  const failing = [];
  const lastRun = [];
  const lastSuccess = [];
  const bytes = [];
  const repoFailures = [];
  const orphaned = [];

  for (const [name, source] of Object.entries(state.sources ?? {})) {
    const repos = Object.entries(source.repos ?? {});
    tracked.push({ labels: { source: name }, value: repos.length });
    failing.push({ labels: { source: name }, value: repos.filter(([, r]) => r.consecutiveFailures > 0).length });
    bytes.push({ labels: { source: name }, value: repos.reduce((n, [, r]) => n + (r.sizeBytes || 0), 0) });
    orphaned.push({ labels: { source: name }, value: configured.has(name) ? 0 : 1 });

    const runAt = seconds(source.lastRunAt);
    if (runAt) lastRun.push({ labels: { source: name }, value: runAt });

    const successes = repos.map(([, r]) => seconds(r.lastSuccess)).filter(Boolean);
    if (successes.length) lastSuccess.push({ labels: { source: name }, value: Math.max(...successes) });

    for (const [repo, record] of repos) {
      if (record.consecutiveFailures > 0) {
        repoFailures.push({ labels: { source: name, repo }, value: record.consecutiveFailures });
      }
    }
  }

  t.metric('source_repos', 'Repositories tracked per source.', 'gauge', tracked);
  t.metric('source_repos_failing', 'Repositories currently failing per source.', 'gauge', failing);
  t.metric('source_last_run_seconds', 'Unix time each source last ran.', 'gauge', lastRun);
  t.metric('source_last_success_seconds', 'Unix time of the newest successful repository sync per source.', 'gauge', lastSuccess);
  t.metric('source_bytes', 'On-disk mirror size per source.', 'gauge', bytes);
  t.metric('source_orphaned', 'Source present in state but absent from the config.', 'gauge', orphaned);
  t.metric('repo_consecutive_failures', 'Consecutive failures per repository. Only failing repositories are exported.', 'gauge', repoFailures);

  const enabled = (config.sources ?? []).map((s) => ({ labels: { source: s.name }, value: s.enabled ? 1 : 0 }));
  t.metric('source_enabled', 'Whether a configured source is enabled.', 'gauge', enabled);

  try {
    const at = nextRun(parseCron(config.schedule.sync), new Date(), config.timezone);
    if (at) t.metric('next_run_seconds', 'Unix time of the next scheduled sync.', 'gauge', [{ value: Math.floor(at.getTime() / 1000) }]);
  } catch {
  }

  const heartbeat = seconds(state.lastHeartbeatAt);
  if (heartbeat) t.metric('last_heartbeat_seconds', 'Unix time the last heartbeat mail was sent.', 'gauge', [{ value: heartbeat }]);

  return t.toString();
}

export function startMetricsServer(cfg, provide) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === (cfg.path || '/metrics')) {
      let body;
      try {
        body = render(provide());
      } catch (err) {
        log.error('could not render metrics', { error: err.message });
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('error rendering metrics\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(body);
      return;
    }

    if (url.pathname === '/health') {
      const { healthy, detail } = provide().health ?? { healthy: true, detail: 'no health information' };
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'text/plain' });
      res.end(`${detail}\n`);
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`git-backup-sync\n${cfg.path || '/metrics'}\n/health\n`);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
  });

  server.on('error', (err) => log.error('metrics server error', { error: err.message }));
  server.listen(cfg.port, cfg.host, () => {
    log.info('metrics server listening', { host: cfg.host, port: cfg.port, path: cfg.path });
  });
  server.unref();
  return server;
}
