import { child } from '../logger.js';
import { sourceState } from '../state.js';
import { syncRepo } from './repository.js';
import { emptySourceReport } from './report.js';
import { stopping } from './stop.js';
import { pool } from './pool.js';

export async function runSource({
  entry,
  config,
  connections,
  state,
  report,
  preflightErrors,
  resolver,
  mappingErrors,
  dryRun,
  lfsAvailable,
}) {
  const { source } = entry;
  const slog = child({ source: source.name });
  const sr = emptySourceReport(entry);
  sr.filtered = entry.filtered?.length ?? 0;
  sr.skipped = entry.skipped?.length ?? 0;

  const unreadable = (entry.filtered ?? []).filter((f) => f.kind === 'unreadable');
  if (unreadable.length) {
    sr.unreadable = unreadable.map((f) => ({ repo: f.repo.fullPath, reason: f.reason }));
    report.warnings.push(
      `source "${source.name}": ${unreadable.length} repositor${unreadable.length === 1 ? 'y' : 'ies'} cannot be ` +
        `cloned and ${unreadable.length === 1 ? 'is' : 'are'} not being backed up (${unreadable.map((f) => f.repo.fullPath).join(', ')})`,
    );
  }

  if (entry.disabled) return sr;

  if (entry.error) {
    sr.error = entry.error.message;
    const st = sourceState(state, source.name);
    st.lastError = entry.error.message;
    return sr;
  }

  if (preflightErrors.length) {
    sr.error = preflightErrors.join(' ');
    sr.preflight = preflightErrors;
    const st = sourceState(state, source.name);
    st.lastError = sr.error;
    slog.error('source failed pre-flight', { problems: preflightErrors });
    return sr;
  }

  for (const err of mappingErrors) {
    sr.repos.push({ repo: err.repo.fullPath, status: 'failed', error: err.message, destination: null });
    sr.counts.failed++;
  }

  const st = sourceState(state, source.name);
  st.connection = source.connection;

  const srcConn = connections[source.connection];
  const destConn = connections[source.destination.connection];
  const timeoutMs = config.git_timeout_minutes * 60_000;

  const pauseMs = (source.batch_pause_seconds ?? 0) * 1000;
  const minChanges = source.batch_pause_min_changes ?? 1;
  if (pauseMs > 0) {
    slog.info('pausing between batches that did work', {
      concurrency: config.concurrency,
      pauseSeconds: source.batch_pause_seconds,
      minChanges,
    });
  }

  const pauseWhen = (batch) => {
    if (batch.some((r) => r.status === 'new' || r.createdProject)) return true;
    const refChanges = batch.reduce((n, r) => n + (r.changes?.total ?? 0), 0);
    return refChanges >= minChanges;
  };

  const results = await pool(entry.mappings, config.concurrency, async (mapping) => {
    if (stopping()) return { repo: mapping.repo.fullPath, status: 'skipped-stopping', destination: mapping.path };
    return syncRepo({
      mapping,
      source,
      srcConn,
      destConn,
      resolver,
      state: st,
      config,
      report,
      dryRun,
      timeoutMs,
      lfsAvailable,
    });
  }, {
    pauseMs,
    pauseWhen,
    onPause: (batch) =>
      slog.debug('pausing after a batch that did work', {
        seconds: source.batch_pause_seconds,
        cloned: batch.filter((r) => r.status === 'new').length,
        changed: batch.filter((r) => r.status === 'changed').length,
      }),
  });

  for (const r of results) {
    if (!r) continue;
    sr.repos.push(r);
    if (r.status in sr.counts) sr.counts[r.status]++;
    if (r.remapped) sr.counts.remapped++;
  }

  const seen = new Set(entry.mappings.map((m) => m.repo.fullPath));
  for (const skippedRepo of entry.skipped ?? []) seen.add(skippedRepo.repo.fullPath);

  const filteredNow = new Map((entry.filtered ?? []).map((f) => [f.repo.fullPath, f.reason]));
  for (const fullPath of filteredNow.keys()) seen.add(fullPath);

  for (const [fullPath, record] of Object.entries(st.repos)) {
    if (filteredNow.has(fullPath)) {
      sr.repos.push({
        repo: fullPath,
        status: 'excluded',
        destination: record.destination,
        lastSuccess: record.lastSuccess,
        reason: filteredNow.get(fullPath),
        source: source.name,
      });
      sr.counts.excluded++;
      continue;
    }
    if (seen.has(fullPath)) continue;
    sr.repos.push({
      repo: fullPath,
      status: 'vanished',
      destination: record.destination,
      lastSuccess: record.lastSuccess,
      refs: record.refs,
      source: source.name,
    });
    sr.counts.vanished++;
  }

  st.lastRunAt = new Date().toISOString();
  st.lastError = null;
  return sr;
}
