import { log } from '../logger.js';
import { sleep } from '../connections.js';
import { describeChanges } from '../diff.js';

const PRIORITIES = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };

export function resolveNtfy(globalCfg, sourceCfg) {
  if (!globalCfg && !sourceCfg) return null;
  const merged = { ...(globalCfg ?? {}), ...(sourceCfg ?? {}) };
  if (merged.enabled === false || !merged.topic) return null;
  return merged;
}

async function post(cfg, { title, message, priority, tags }) {
  const base = (cfg.url || 'https://ntfy.sh').replace(/\/+$/, '');
  const headers = {
    Title: sanitizeHeader(title),
    Priority: String(PRIORITIES[priority] ?? PRIORITIES.default),
    Markdown: 'no',
  };
  if (tags?.length) headers.Tags = tags.join(',');
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  else if (cfg.username) headers.Authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password ?? ''}`).toString('base64')}`;

  const res = await fetch(`${base}/${encodeURIComponent(cfg.topic)}`, {
    method: 'POST',
    headers,
    body: message,
    signal: AbortSignal.timeout((cfg.timeout_seconds ?? 15) * 1000),
  });
  if (!res.ok) throw new Error(`ntfy ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
}

async function send(cfg, payload, context) {
  const attempts = (cfg.retries ?? 2) + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await post(cfg, payload);
      log.info('ntfy sent', { topic: cfg.topic, ...context });
      return true;
    } catch (err) {
      const last = attempt === attempts;
      log[last ? 'error' : 'warn']('ntfy delivery failed', { topic: cfg.topic, attempt, error: err.message });
      if (last) {
        log.error('undelivered ntfy message', { topic: cfg.topic, title: payload.title, body: payload.message });
        return false;
      }
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000));
    }
  }
  return false;
}

function shouldSend(cfg, { hasChange, hasFailure }) {
  const on = new Set(cfg.notify_on ?? ['changes', 'failures']);
  if (on.has('always')) return true;
  if (hasFailure && on.has('failures')) return true;
  if (hasChange && on.has('changes')) return true;
  return false;
}

export async function notifyRun(cfg, report) {
  const t = report.totals ?? {};
  const hasFailure = Boolean(report.fatal) || (t.failed ?? 0) > 0 || (t.failedSources ?? 0) > 0;
  const hasChange = (t.new ?? 0) + (t.changed ?? 0) + (t.moved ?? 0) + (t.vanished ?? 0) + (t.excluded ?? 0) + (t.remapped ?? 0) > 0;
  if (!shouldSend(cfg, { hasChange, hasFailure })) return false;

  const updated = (t.new ?? 0) + (t.changed ?? 0) + (t.moved ?? 0);
  const title = report.fatal
    ? 'repo sync aborted'
    : hasFailure
      ? `repo sync: ${t.failed ?? 0} failed`
      : `repo sync: ${updated} updated`;

  const body = [];
  if (report.fatal) body.push(report.fatal.split('\n')[0]);
  for (const source of report.sources) {
    const c = source.counts;
    const bits = [];
    if (source.error) bits.push('SOURCE FAILED');
    for (const key of ['new', 'changed', 'moved', 'failed', 'vanished', 'excluded']) {
      if (c[key]) bits.push(`${c[key]} ${key}`);
    }
    if (bits.length) body.push(`${source.name}: ${bits.join(', ')}`);
  }
  for (const source of report.sources) {
    for (const r of source.repos.filter((x) => x.status === 'failed').slice(0, 5)) {
      body.push(`! ${r.repo}: ${firstLine(r.error)}`);
    }
  }
  if (body.length === 0) body.push('nothing changed');

  return send(
    cfg,
    {
      title,
      message: body.join('\n').slice(0, 4000),
      priority: hasFailure ? (cfg.failure_priority ?? 'high') : (cfg.priority ?? 'default'),
      tags: hasFailure ? (cfg.failure_tags ?? ['rotating_light']) : (cfg.tags ?? ['floppy_disk']),
    },
    { scope: 'run' },
  );
}

export async function notifySource(cfg, sourceReport) {
  const c = sourceReport.counts;
  const hasFailure = Boolean(sourceReport.error) || c.failed > 0;
  const hasChange = c.new + c.changed + c.moved + c.vanished + c.excluded + c.remapped > 0;
  if (!shouldSend(cfg, { hasChange, hasFailure })) return false;

  const body = [];
  if (sourceReport.error) body.push(`source failed: ${firstLine(sourceReport.error)}`);
  for (const r of sourceReport.repos) {
    if (r.status === 'failed') body.push(`! ${r.repo}: ${firstLine(r.error)}`);
    else if (r.status === 'changed') body.push(`~ ${r.repo}: ${describeChanges(r.changes)}`);
    else if (r.status === 'new') body.push(`+ ${r.repo}`);
    else if (r.status === 'vanished') body.push(`? ${r.repo} vanished from the source`);
    else if (r.status === 'excluded') body.push(`- ${r.repo} no longer mirrored`);
  }

  return send(
    cfg,
    {
      title: `${sourceReport.name}: ${hasFailure ? `${c.failed || 'source'} failed` : `${c.new + c.changed + c.moved} updated`}`,
      message: (body.join('\n') || 'nothing changed').slice(0, 4000),
      priority: hasFailure ? (cfg.failure_priority ?? 'high') : (cfg.priority ?? 'default'),
      tags: hasFailure ? (cfg.failure_tags ?? ['rotating_light']) : (cfg.tags ?? ['floppy_disk']),
    },
    { scope: 'source', source: sourceReport.name },
  );
}

function sanitizeHeader(value) {
  return String(value).replace(/[\r\n]+/g, ' ').slice(0, 200);
}

function firstLine(text) {
  return String(text || '').split('\n').find((l) => l.trim()) ?? '';
}
