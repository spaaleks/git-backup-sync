import { detectMoves } from '../diff.js';

export function emptySourceReport(entry) {
  return {
    name: entry.source.name,
    connection: entry.source.connection,
    destination: `${entry.source.destination.connection}:${entry.source.destination.namespace}`,
    disabled: Boolean(entry.disabled),
    error: entry.error ? entry.error.message : null,
    repos: [],
    filtered: entry.filtered?.length ?? 0,
    skipped: entry.skipped?.length ?? 0,
    counts: emptyCounts(),
  };
}

export function emptyCounts() {
  return { new: 0, changed: 0, unchanged: 0, failed: 0, interrupted: 0, vanished: 0, excluded: 0, moved: 0, remapped: 0, planned: 0 };
}

export function classifyMoves(report, state) {
  const vanished = [];
  const fresh = [];

  for (const sr of report.sources) {
    for (const r of sr.repos) {
      if (r.status === 'vanished') vanished.push({ ...r, sourceReport: sr });
      if (r.status === 'new') {
        const st = state.sources[sr.name]?.repos?.[r.repo];
        fresh.push({ ...r, refs: st?.refs ?? {}, sourceReport: sr });
      }
    }
  }
  if (vanished.length === 0 || fresh.length === 0) return;

  const { moves } = detectMoves(vanished, fresh);
  for (const move of moves) {
    const fromReport = move.from.sourceReport;
    const toReport = move.to.sourceReport;

    const vanishedEntry = fromReport.repos.find((r) => r === move.from || (r.repo === move.from.repo && r.status === 'vanished'));
    if (vanishedEntry) {
      vanishedEntry.status = 'moved-away';
      vanishedEntry.movedTo = { source: toReport.name, repo: move.to.repo };
      fromReport.counts.vanished--;
    }

    const newEntry = toReport.repos.find((r) => r.repo === move.to.repo && r.status === 'new');
    if (newEntry) {
      newEntry.status = 'moved';
      newEntry.movedFrom = { source: fromReport.name, repo: move.from.repo };
      toReport.counts.new--;
      toReport.counts.moved++;
    }
  }

  for (const move of moves) {
    const st = state.sources[move.from.sourceReport.name];
    if (st?.repos) delete st.repos[move.from.repo];
  }
}

export function totalsOf(report) {
  const totals = { ...emptyCounts(), sources: report.sources.length, failedSources: 0, createdGroups: report.createdGroups.length, createdProjects: report.createdProjects.length };
  for (const s of report.sources) {
    if (s.error) totals.failedSources++;
    for (const key of Object.keys(s.counts)) totals[key] += s.counts[key];
  }
  totals.total = report.sources.reduce((n, s) => n + s.repos.length, 0);
  return totals;
}
