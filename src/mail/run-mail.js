import { describeChanges, listChanges } from '../diff.js';
import { formatBytes, formatDuration, indent, nextScheduled, pad } from './format.js';
import {
  ACCENT,
  badge,
  code,
  doc,
  escapeHtml,
  foot,
  h1,
  h2,
  h3,
  p as para,
  pre,
  quote,
  statusBadge,
  table,
} from './theme.js';

const NOTABLE = new Set(['new', 'changed', 'moved', 'moved-away', 'vanished', 'excluded']);

export function buildRunMail(report, config) {
  report = { ...report, logo: Boolean(config.smtp?.logo) };
  const t = report.totals ?? {};
  const subject = `${config.smtp.subject_prefix} ${runSubject(report)}`;
  const lines = [];

  lines.push(subject.replace(`${config.smtp.subject_prefix} `, ''));
  lines.push('='.repeat(72));
  lines.push(`started   ${report.startedAt}`);
  lines.push(`duration  ${formatDuration(report.durationMs)}`);
  lines.push(`trigger   ${report.reason}`);
  if (report.stopped) lines.push('note      the run was cut short by a shutdown signal');
  lines.push('');

  if (report.fatal) {
    lines.push('RUN ABORTED BEFORE ANY WRITE');
    lines.push('-'.repeat(72));
    lines.push(report.fatal);
    lines.push('');
  }

  for (const source of report.sources) {
    const notable = source.repos.filter((r) => NOTABLE.has(r.status) || r.remapped);
    const failed = source.repos.filter((r) => r.status === 'failed');
    if (!source.error && notable.length === 0 && failed.length === 0) continue;

    lines.push(`SOURCE ${source.name}  (${source.connection} -> ${source.destination})`);
    lines.push('-'.repeat(72));

    if (source.error) {
      lines.push(`  the whole source failed: ${indent(source.error, 4).trim()}`);
      lines.push('');
      continue;
    }

    for (const r of notable) {
      lines.push(`  ${r.repo}`);
      lines.push(`    -> ${r.destination}`);
      if (r.status === 'new') lines.push('    new: first sighting under this source');
      if (r.status === 'moved') lines.push(`    moved here from ${r.movedFrom.source}:${r.movedFrom.repo}`);
      if (r.status === 'moved-away') lines.push(`    moved to ${r.movedTo.source}:${r.movedTo.repo}`);
      if (r.status === 'excluded') {
        lines.push(`    no longer mirrored: ${r.reason}`);
        lines.push('    The source still has it. Nothing was deleted here or on the destination.');
        if (r.lastSuccess) lines.push(`    last successful sync ${r.lastSuccess}`);
      }
      if (r.status === 'vanished') {
        lines.push('    vanished: present in state, absent from the source now.');
        lines.push('    Nothing was deleted. The local mirror and the destination project are untouched.');
        if (r.lastSuccess) lines.push(`    last successful sync ${r.lastSuccess}`);
      }
      if (r.changes?.changed) {
        lines.push(`    ${describeChanges(r.changes)}`);
        for (const change of listChanges(r.changes)) lines.push(`      ${change}`);
      }
      if (r.createdProject) lines.push('    created the destination project');
      if (r.emptyRepo) lines.push('    the source repository is empty, nothing was pushed');
      if (r.disabledCi) lines.push('    disabled CI on the destination project');
      if (r.visibilityChanged) lines.push(`    changed visibility from ${r.visibilityChanged.from} to ${r.visibilityChanged.to}`);
      if (r.visibilityWarning) lines.push(`    visibility: ${r.visibilityWarning}`);
      if (r.metadata) {
        for (const [key, value] of Object.entries(r.metadata)) {
          lines.push(`    set ${key} to ${Array.isArray(value) ? value.join(', ') || '(none)' : JSON.stringify(value)}`);
        }
      }
      if (r.verification?.ok) lines.push(`    verified against the destination, ${r.verification.checked} refs match`);
      if (r.relaxedPushRules) {
        lines.push(
          r.relaxedPushRules.retrySucceeded
            ? '    relaxed the destination push rules and the push then succeeded'
            : '    relaxed the destination push rules, but the push still failed',
        );
        const before = Object.keys(r.relaxedPushRules.before ?? {});
        if (before.length) lines.push(`      rules turned off: ${before.join(', ')}`);
      }
      for (const group of r.createdGroups ?? []) lines.push(`    created destination group ${group}`);
      if (r.recloned) lines.push('    the local mirror was missing and has been cloned again');
      if (r.remapped) lines.push(`    remapped: ${r.remapped.from} -> ${r.remapped.to} (${remapAction(r.remapped)})`);
      if (r.wiki && r.wiki.status === 'changed') lines.push(`    wiki: ${describeChanges(r.wiki.changes)}`);
      if (r.wiki && r.wiki.status === 'failed') lines.push(`    wiki: failed, ${r.wiki.error}`);
      if (r.lfsWarning) lines.push(`    LFS: ${r.lfsWarning}`);
      lines.push('');
    }

    if (failed.length) {
      lines.push(`  failures in ${source.name}:`);
      for (const r of failed) {
        lines.push(`    ${r.repo} -> ${r.destination ?? '(unmapped)'}`);
        if (r.consecutiveFailures > 1) {
          lines.push(`      failing for ${r.consecutiveFailures} consecutive runs`);
        }
        lines.push(indent(r.error ?? 'unknown error', 6));
      }
      lines.push('');
    }
  }

  lines.push('PER SOURCE');
  lines.push('-'.repeat(72));
  for (const source of report.sources) {
    const c = source.counts;
    const bits = [];
    if (source.disabled) bits.push('disabled');
    if (source.error) bits.push('FAILED');
    for (const key of ['new', 'changed', 'moved', 'unchanged', 'failed', 'interrupted', 'vanished', 'remapped', 'planned']) {
      if (c[key]) bits.push(`${c[key]} ${key}`);
    }
    if (source.skipped) bits.push(`${source.skipped} skipped by rules`);
    lines.push(`  ${pad(source.name, 24)} ${bits.join(', ') || 'nothing to do'}`);
    const filtered = filteredNote(source, { shout: true });
    if (filtered) {
      lines.push(`${' '.repeat(27)}${filtered.count} filtered out of the source ${filtered.tail}`);
    }
  }
  lines.push('');

  if (report.createdGroups.length) {
    lines.push('DESTINATION GROUPS CREATED');
    lines.push('-'.repeat(72));
    for (const g of report.createdGroups) lines.push(`  ${g.connection}:${g.path}`);
    lines.push('');
  }

  if (report.pruned.length) {
    const bytes = report.pruned.reduce((n, p) => n + (p.bytes || 0), 0);
    lines.push('MIRROR DIRECTORIES PRUNED');
    lines.push('-'.repeat(72));
    lines.push('  Unreferenced leftovers only. A repository that vanished from its source keeps its mirror.');
    for (const p of report.pruned) lines.push(`  ${p.source}:${p.repo}${p.wiki ? ' (wiki)' : ''}  ${formatBytes(p.bytes)}`);
    lines.push(`  reclaimed ${formatBytes(bytes)}`);
    lines.push('');
  }

  if (report.warnings.length) {
    lines.push('WARNINGS');
    lines.push('-'.repeat(72));
    for (const w of report.warnings) lines.push(`  ${w}`);
    lines.push('');
  }

  if (report.orphaned.length) {
    lines.push('SOURCES IN STATE BUT NOT IN THE CONFIG');
    lines.push('-'.repeat(72));
    for (const o of report.orphaned) {
      lines.push(`  ${o.name}: ${o.repos} repositories tracked, last run ${o.lastRunAt ?? 'never'}. Mirrors and state are intact.`);
    }
    lines.push('');
  }

  lines.push(`totals: ${t.new ?? 0} new, ${t.changed ?? 0} changed, ${t.moved ?? 0} moved, ${t.unchanged ?? 0} unchanged, ${t.failed ?? 0} failed, ${t.vanished ?? 0} vanished`);
  const nextAt = nextScheduled(config);
  if (nextAt) lines.push(`next scheduled run: ${nextAt}`);

  const text = lines.join('\n');
  return { subject, text, html: renderRunHtml(report, config) };
}

function filteredNote(source, { shout = false } = {}) {
  const count = source.filtered ?? 0;
  if (!count) return null;

  const unreadable = source.unreadable?.length ?? 0;
  const byRule = count - unreadable;
  const word = shout ? 'UNREADABLE' : 'unreadable';

  let why;
  if (unreadable && byRule) why = `${unreadable} ${word}, ${byRule} by rule`;
  else if (unreadable) why = count === 1 ? word : `all ${word}`;
  else why = 'by rule';

  const excluded = source.counts?.excluded ?? 0;
  const note = excluded ? `${excluded === count ? 'all' : excluded} of them no longer mirrored` : '';
  return { count, tail: `(${why})${note ? `, ${note}` : ''}` };
}

function remapAction(remap) {
  if (remap.action === 'archived') return 'old project archived';
  if (remap.action === 'deleted') return 'old project deleted';
  if (remap.action === 'gone') return 'old project no longer exists';
  return remap.detail ? `old project left in place, ${remap.detail}` : 'old project left in place';
}

function runSubject(report) {
  const t = report.totals ?? {};
  if (report.fatal) {
    const first = report.fatal.split('\n')[0];
    return `RUN ABORTED: ${first.slice(0, 90)}`;
  }

  const parts = [];
  const updated = (t.new ?? 0) + (t.changed ?? 0) + (t.moved ?? 0);
  if (updated) parts.push(`${updated} repo${updated === 1 ? '' : 's'} updated`);
  if (t.vanished) parts.push(`${t.vanished} vanished`);
  if (t.excluded) parts.push(`${t.excluded} no longer mirrored`);
  if (t.remapped) parts.push(`${t.remapped} remapped`);
  if (t.failed) parts.push(`${t.failed} failed`);
  if (t.interrupted) parts.push(`${t.interrupted} cut short by shutdown`);

  const blame = blameFailure(report);
  if (blame) parts.push(blame);

  if (parts.length === 0) parts.push('nothing changed');
  return parts.join(', ');
}

function blameFailure(report) {
  const broken = report.sources.filter(
    (s) => !s.disabled && (s.error || (s.counts.failed > 0 && s.counts.failed === s.repos.length && s.repos.length > 0)),
  );
  if (broken.length === 0) return null;

  const healthy = report.sources.filter((s) => !s.disabled && !broken.includes(s) && s.repos.length > 0);

  const connections = new Set(broken.map((s) => s.connection));
  if (connections.size === 1) {
    const connection = [...connections][0];
    const usingSame = report.sources.filter((s) => !s.disabled && s.connection === connection);
    if (usingSame.length === broken.length && usingSame.length > 1) {
      return `every source on connection "${connection}" failed`;
    }
  }
  if (broken.length === 1 && healthy.length > 0) {
    return `all of source "${broken[0].name}" failed`;
  }
  return null;
}

export const LOGO_CID = 'gbs-logo';

export function renderRunHtml(report, config) {
  const t = report.totals ?? {};
  const title = runSubject(report);
  const out = [
    h1('Repository sync', `${report.startedAt} · ${formatDuration(report.durationMs)} · ${report.reason}`, report.logo ? LOGO_CID : null),
  ];

  if (report.fatal) {
    out.push(h2('Run aborted before any write'));
    out.push(pre(report.fatal));
  }

  const counts = ['new', 'changed', 'moved', 'unchanged', 'failed', 'interrupted', 'vanished', 'excluded', 'remapped']
    .filter((k) => (t[k] ?? 0) > 0)
    .map((k) => [statusBadge(k), String(t[k])]);
  if (counts.length) {
    out.push(h2('Summary'));
    out.push(table(['Outcome', 'Repositories'], counts));
  }

  const quiet = ['new', 'changed', 'moved', 'failed', 'vanished', 'excluded', 'remapped'].every((k) => !(t[k] ?? 0));
  if (quiet && !report.fatal) out.push(para('Nothing changed.'));

  for (const source of report.sources) {
    const notable = source.repos.filter((r) => NOTABLE.has(r.status) || r.remapped);
    const failed = source.repos.filter((r) => r.status === 'failed');
    if (!source.error && notable.length === 0 && failed.length === 0) continue;

    out.push(h2(source.name));
    out.push(para(`${escapeHtml(source.connection)} &rarr; ${escapeHtml(source.destination)}`));

    if (source.error) {
      out.push(pre(source.error));
      continue;
    }

    const rows = notable.map((r) => [
      statusBadge(r.status),
      code(r.repo),
      detailFor(r),
    ]);
    out.push(table(['', 'Repository', 'What happened'], rows));

    if (failed.length) {
      out.push(h3(`${failed.length} failed`));
      for (const r of failed) {
        out.push(
          para(
            code(r.repo) +
              (r.consecutiveFailures > 1
                ? ` ${badge(`${r.consecutiveFailures} runs in a row`, ACCENT)}`
                : ''),
          ),
        );
        out.push(pre(r.error ?? 'unknown error'));
      }
    }
  }

  const perSource = report.sources.map((s) => {
    const c = s.counts;
    const bits = [];
    if (s.disabled) bits.push('disabled');
    if (s.error) bits.push('FAILED');
    for (const key of ['new', 'changed', 'moved', 'unchanged', 'failed', 'vanished', 'remapped', 'planned']) {
      if (c[key]) bits.push(`${c[key]} ${key}`);
    }
    const filtered = filteredNote(s);
    return [
      code(s.name),
      escapeHtml(bits.join(', ') || 'nothing to do'),
      filtered ? escapeHtml(`${filtered.count} ${filtered.tail}`) : '&mdash;',
    ];
  });
  if (perSource.length) {
    out.push(h2('Per source'));
    out.push(table(['Source', 'Synced', 'Filtered out'], perSource));
  }

  if (report.createdGroups.length) {
    out.push(h2('Destination groups created'));
    out.push(table(['Group'], report.createdGroups.map((g) => [code(`${g.connection}:${g.path}`)])));
  }

  if (report.pruned.length) {
    const bytes = report.pruned.reduce((n, x) => n + (x.bytes || 0), 0);
    out.push(h2('Mirror directories pruned'));
    out.push(para(`Unreferenced leftovers only, ${escapeHtml(formatBytes(bytes))} reclaimed. A repository that vanished from its source keeps its mirror.`));
  }

  if (report.warnings.length) {
    out.push(h2('Warnings'));
    for (const w of report.warnings) out.push(quote(w));
  }

  if (report.orphaned.length) {
    out.push(h2('In state but not in the config'));
    out.push(
      table(
        ['Source', 'Repositories', 'Last run'],
        report.orphaned.map((o) => [code(o.name), String(o.repos), escapeHtml(o.lastRunAt ?? 'never')]),
      ),
    );
    out.push(para('Mirrors and state are intact.'));
  }

  const next = nextScheduled(config);
  out.push(foot(next ? `Next scheduled run ${escapeHtml(next)}` : 'No further runs scheduled'));

  return doc(title, out.join(''));
}

function detailFor(r) {
  const bits = [];
  if (r.status === 'new') bits.push('first sighting under this source');
  if (r.status === 'moved') bits.push(`moved here from ${escapeHtml(r.movedFrom.source)}:${escapeHtml(r.movedFrom.repo)}`);
  if (r.status === 'moved-away') bits.push(`moved to ${escapeHtml(r.movedTo.source)}:${escapeHtml(r.movedTo.repo)}`);
  if (r.status === 'vanished') bits.push('absent from the source now, nothing was deleted');
  if (r.status === 'excluded') bits.push(escapeHtml(r.reason ?? 'no longer mirrored'));
  if (r.changes?.changed) bits.push(escapeHtml(describeChanges(r.changes)));
  if (r.emptyRepo) bits.push('source repository is empty');
  if (r.createdProject) bits.push('created the destination project');
  for (const g of r.createdGroups ?? []) bits.push(`created group ${escapeHtml(g)}`);
  if (r.relaxedPushRules) bits.push(r.relaxedPushRules.retrySucceeded === false ? 'push rules relaxed, still rejected' : 'relaxed the destination push rules');
  if (r.disabledCi) bits.push('disabled CI');
  if (r.visibilityChanged) bits.push(`visibility ${escapeHtml(r.visibilityChanged.from)} &rarr; ${escapeHtml(r.visibilityChanged.to)}`);
  if (r.metadata) bits.push(`set ${Object.keys(r.metadata).join(', ')}`);
  if (r.verification?.ok) bits.push(`verified, ${r.verification.checked} refs match`);
  if (r.lfsWarning) bits.push(escapeHtml(r.lfsWarning));
  if (r.remapped) bits.push(`remapped from ${escapeHtml(r.remapped.from)}`);
  return bits.join('<br>') || '&mdash;';
}

