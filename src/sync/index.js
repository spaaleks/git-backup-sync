import { log } from '../logger.js';
import { orphanedSources } from '../state.js';
import { openLock, LockBusyError } from '../lock.js';
import { hasGitLfs } from '../mirror.js';
import { Job } from '../job.js';
import { enumerateAll, resolveAll, preflight } from './preflight.js';
import { runSource } from './source.js';
import { pruneMirrors } from './prune.js';
import { emptySourceReport, classifyMoves, totalsOf } from './report.js';

export async function runSync({ config, connections, state, reason = 'scheduled', only = null, job, lock }) {
  const dryRun = config.dry_run;
  const startedAt = new Date();
  job ??= new Job({ reason, secrets: Object.values(connections).map((c) => c.token) });
  lock ??= await openLock(config, state.store);
  let release = () => {};

  try {
    release = await lock.acquire();
  } catch (err) {
    if (err instanceof LockBusyError) {
      log.warn('skipping this run, a sync is already in progress', { error: err.message });
      return { skipped: true, reason: err.message, startedAt: startedAt.toISOString() };
    }
    throw err;
  }

  const report = {
    reason,
    dryRun,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: 0,
    fatal: null,
    sources: [],
    createdGroups: [],
    createdProjects: [],
    warnings: [],
    pruned: [],
    orphaned: orphanedSources(state, config),
    disabled: config.sources.filter((s) => !s.enabled).map((s) => s.name),
    stopped: false,
  };

  try {
    log.info('sync run starting', { reason, dryRun, sources: config.sources.length });

    // Always enumerate every source, even when `only` narrows what gets synced:
    // the collision check is only meaningful across all of them at once.
    const enumerated = await enumerateAll(config, connections);
    const { mappings, errors: mappingErrors } = resolveAll(enumerated);

    const selected = only?.length ? new Set(only) : null;
    if (selected) {
      report.only = [...selected];
      log.info('running a subset of sources', { only: report.only, mappedAcrossAllSources: mappings.length });
    }

    const pf = await preflight({ config, connections, enumerated, mappings, dryRun });

    if (pf.fatal.length) {
      report.fatal = pf.fatal.join('\n\n');
      log.error('pre-flight aborted the run before any write', { problems: pf.fatal.length });
      report.sources = enumerated.map((e) => emptySourceReport(e));
      return finish(report, state, config, startedAt);
    }

    const lfsAvailable = config.sources.some((s) => s.mirror_lfs) ? await hasGitLfs() : false;
    if (config.sources.some((s) => s.mirror_lfs) && !lfsAvailable) {
      report.warnings.push('mirror_lfs is enabled but git-lfs is not installed in this image; LFS blobs will not be transferred');
    }

    for (const entry of enumerated) {
      if (selected && !selected.has(entry.source.name)) continue;
      const sourceReport = await runSource({
        entry,
        config,
        connections,
        state,
        report,
        preflightErrors: pf.sourceErrors.get(entry.source.name) || [],
        resolver: pf.resolvers.get(entry.source.destination.connection),
        mappingErrors: mappingErrors.filter((e) => e.source === entry.source.name),
        dryRun,
        lfsAvailable,
        job,
      });
      report.sources.push(sourceReport);
      if (job.stopping) {
        report.stopped = true;
        log.warn('stop requested, ending the run after the current source');
        break;
      }
    }

    await classifyMoves(report, state);
    if (config.prune_mirrors && !dryRun && !job.stopping && !selected) await pruneMirrors(config, state, report);
    return finish(report, state, config, startedAt);
  } catch (err) {
    log.error('sync run failed unexpectedly', { error: err.message, stack: err.stack });
    report.fatal = `unexpected error: ${err.message}`;
    return finish(report, state, config, startedAt);
  } finally {
    await release();
  }
}

async function finish(report, state, config, startedAt) {
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();
  report.totals = totalsOf(report);

  await state.addRun(
    {
      startedAt: report.startedAt,
      durationMs: report.durationMs,
      reason: report.reason,
      dryRun: report.dryRun,
      changed: report.totals.changed + report.totals.new + report.totals.moved,
      failed: report.totals.failed,
      fatal: report.fatal ? report.fatal.split('\n')[0] : null,
      bySource: Object.fromEntries(report.sources.map((s) => [s.name, { changed: s.counts.changed + s.counts.new, failed: s.counts.failed }])),
    },
    { keep: config.keep_runs },
  );

  log.info('sync run finished', {
    durationMs: report.durationMs,
    ...report.totals,
    fatal: Boolean(report.fatal),
  });
  return report;
}
