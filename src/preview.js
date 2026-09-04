import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { log } from './logger.js';
import { loadState, orphanedSources } from './state.js';
import { buildConnections } from './connections.js';
import { Notifier } from './notify/index.js';
import { buildRunMail, buildHeartbeatMail } from './mail.js';
import { totalsOf } from './run.js';

function reportFromState(config, state) {
  const lastRun = (state.runs ?? []).at(-1);
  const sources = [];

  for (const source of config.sources) {
    const stored = state.sources[source.name] ?? { repos: {} };
    const counts = { new: 0, changed: 0, unchanged: 0, failed: 0, interrupted: 0, vanished: 0, excluded: 0, moved: 0, remapped: 0, planned: 0 };
    const repos = [];

    for (const [fullPath, record] of Object.entries(stored.repos ?? {})) {
      const status = record.consecutiveFailures > 0 ? 'failed' : record.lastSuccess ? 'unchanged' : 'new';
      counts[status]++;
      repos.push({
        repo: fullPath,
        source: source.name,
        destination: record.destination,
        status,
        changes: null,
        error: record.lastError,
        consecutiveFailures: record.consecutiveFailures ?? 0,
        createdGroups: [],
      });
    }

    sources.push({
      name: source.name,
      connection: source.connection,
      destination:
        source.destination.type === 'directory'
          ? `dir:${source.destination.path}`
          : `${source.destination.connection}:${source.destination.namespace ?? '(top level)'}`,
      disabled: !source.enabled,
      error: stored.lastError ?? null,
      repos,
      filtered: 0,
      skipped: 0,
      counts,
    });
  }

  const report = {
    reason: 'preview',
    dryRun: false,
    startedAt: lastRun?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: lastRun?.durationMs ?? 0,
    fatal: null,
    sources,
    createdGroups: [],
    createdProjects: [],
    warnings: ['This report was rendered from stored state for template preview. No repository was contacted.'],
    pruned: [],
    orphaned: orphanedSources(state, config),
    disabled: config.sources.filter((s) => !s.enabled).map((s) => s.name),
    stopped: false,
  };
  report.totals = totalsOf(report);
  return report;
}

export async function previewMail(config, { htmlPath = null, kind = 'run' } = {}) {
  const state = await loadState(config.data_dir);
  const connections = buildConnections(config);

  const message =
    kind === 'heartbeat'
      ? await buildHeartbeatMail({ config, state, connections, uptimeMs: 3_600_000 })
      : buildRunMail(reportFromState(config, state), config);

  if (htmlPath) {
    await mkdir(path.dirname(htmlPath), { recursive: true });
    await writeFile(htmlPath, message.html);
    log.print(`wrote ${htmlPath}`);
  }

  const notifier = new Notifier(config);
  if (!notifier.transport) {
    log.print('smtp is not enabled, so nothing was sent');
    return htmlPath ? 0 : 1;
  }

  const { send } = await import('./mail/transport.js');
  const ok = await send(notifier.transport, config.smtp, notifier.withLogo(message));
  log.print(ok ? `sent: ${message.subject}` : 'delivery failed, see the log');
  return ok ? 0 : 1;
}
