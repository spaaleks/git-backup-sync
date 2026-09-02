import { log } from '../logger.js';
import { sleep } from '../connections.js';

export function resolveKuma(globalCfg, sourceCfg) {
  if (!globalCfg && !sourceCfg) return null;
  const merged = { ...(globalCfg ?? {}), ...(sourceCfg ?? {}) };
  if (merged.enabled === false || !merged.url) return null;
  return merged;
}

async function push(cfg, { status, msg, pingMs }) {
  const url = new URL(cfg.url);
  url.searchParams.set('status', status);
  url.searchParams.set('msg', String(msg).replace(/[\r\n]+/g, ' ').slice(0, 500));
  if (pingMs !== undefined && pingMs !== null) url.searchParams.set('ping', String(Math.round(pingMs)));

  const res = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout((cfg.timeout_seconds ?? 15) * 1000),
  });
  if (!res.ok) throw new Error(`uptime kuma ${res.status} ${res.statusText}`);
}

export async function send(cfg, payload, context = {}) {
  const attempts = (cfg.retries ?? 2) + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await push(cfg, payload);
      log.debug('uptime kuma pinged', { status: payload.status, ...context });
      return true;
    } catch (err) {
      const last = attempt === attempts;
      log[last ? 'warn' : 'debug']('uptime kuma push failed', { attempt, error: err.message, ...context });
      if (last) return false;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 10_000));
    }
  }
  return false;
}

export function runPayload(report) {
  const t = report.totals ?? {};
  const failed = Boolean(report.fatal) || (t.failed ?? 0) > 0 || (t.failedSources ?? 0) > 0;
  const updated = (t.new ?? 0) + (t.changed ?? 0) + (t.moved ?? 0);

  const msg = report.fatal
    ? `aborted: ${report.fatal.split('\n')[0]}`
    : `${updated} updated, ${t.unchanged ?? 0} unchanged, ${t.failed ?? 0} failed across ${t.sources ?? 0} sources`;

  return { status: failed ? 'down' : 'up', msg, pingMs: report.durationMs };
}

export function sourcePayload(sourceReport) {
  const c = sourceReport.counts;
  const failed = Boolean(sourceReport.error) || c.failed > 0;
  const msg = sourceReport.error
    ? `source failed: ${String(sourceReport.error).split('\n')[0]}`
    : `${c.new + c.changed + c.moved} updated, ${c.unchanged} unchanged, ${c.failed} failed`;
  return { status: failed ? 'down' : 'up', msg };
}
