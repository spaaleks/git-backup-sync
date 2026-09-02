import { firstLine, formatBytes, formatDuration, nextScheduled, pad } from './format.js';
import { ACCENT, OK, WARN, badge, code, doc, escapeHtml, foot, h1, h2, p as para, table } from './theme.js';

export async function buildHeartbeatMail({ config, state, connections, uptimeMs }) {
  const probes = [];
  for (const connection of Object.values(connections)) {
    probes.push({ connection, probe: await connection.probe() });
  }

  const lines = [];
  const subject = `${config.smtp.subject_prefix} heartbeat: ${countTracked(state)} repositories tracked across ${Object.keys(state.sources).length} sources`;

  lines.push('This is the scheduled "still alive" mail. Its absence is itself the alert:');
  lines.push('if this stops arriving, the service is not running.');
  lines.push('');
  lines.push(`generated ${new Date().toISOString()}`);
  lines.push(`container uptime ${formatDuration(uptimeMs)}`);
  const nextAt = nextScheduled(config);
  if (nextAt) lines.push(`next scheduled sync ${nextAt}`);
  lines.push('');

  lines.push('SOURCES');
  lines.push('-'.repeat(72));
  const configured = new Map(config.sources.map((s) => [s.name, s]));
  for (const [name, source] of Object.entries(state.sources)) {
    const cfg = configured.get(name);
    const repos = Object.values(source.repos || {});
    const bytes = repos.reduce((n, r) => n + (r.sizeBytes || 0), 0);
    const status = !cfg ? 'ORPHANED (in state, not in config)' : cfg.enabled ? '' : 'DISABLED';
    lines.push(`  ${name}${status ? `  [${status}]` : ''}`);
    lines.push(`    repositories tracked  ${repos.length}`);
    lines.push(`    last run              ${source.lastRunAt ?? 'never'}`);
    lines.push(`    disk usage            ${formatBytes(bytes)}`);
    if (cfg) lines.push(`    destination           ${cfg.destination.connection}:${cfg.destination.namespace}`);
    if (source.lastError) lines.push(`    last source error     ${firstLine(source.lastError)}`);
    lines.push('');
  }

  for (const source of config.sources) {
    if (state.sources[source.name]) continue;
    lines.push(`  ${source.name}  [never run]`);
    lines.push(`    destination           ${source.destination.connection}:${source.destination.namespace}`);
    lines.push('');
  }

  lines.push('CONNECTIONS');
  lines.push('-'.repeat(72));
  for (const { connection, probe } of probes) {
    lines.push(`  ${pad(connection.name, 16)} ${connection.provider} ${connection.host}`);
    if (probe.ok) {
      lines.push(`    reachable, ${probe.latencyMs} ms, token owner ${probe.login ?? 'unknown'}`);
      if (probe.rate?.remaining !== null && probe.rate?.remaining !== undefined) {
        lines.push(`    rate limit headroom ${probe.rate.remaining}${probe.rate.limit ? ` of ${probe.rate.limit}` : ''}`);
      }
      lines.push(`    token expires ${probe.tokenExpiresAt ?? 'not exposed by this API'}`);
    } else {
      lines.push(`    UNREACHABLE: ${firstLine(probe.error)}`);
    }
    lines.push('');
  }

  const failing = [];
  const neverSynced = [];
  for (const [name, source] of Object.entries(state.sources)) {
    for (const [repo, record] of Object.entries(source.repos || {})) {
      if (record.consecutiveFailures > 0) failing.push({ name, repo, record });
      if (!record.lastSuccess) neverSynced.push({ name, repo });
    }
  }

  if (failing.length) {
    lines.push('CURRENTLY FAILING');
    lines.push('-'.repeat(72));
    failing.sort((a, b) => b.record.consecutiveFailures - a.record.consecutiveFailures);
    for (const f of failing) {
      lines.push(`  ${f.name}:${f.repo}  ${f.record.consecutiveFailures} consecutive failures`);
      lines.push(`    ${firstLine(f.record.lastError)}`);
    }
    lines.push('');
  }

  if (neverSynced.length) {
    lines.push('NEVER SYNCED SUCCESSFULLY');
    lines.push('-'.repeat(72));
    for (const n of neverSynced) lines.push(`  ${n.name}:${n.repo}`);
    lines.push('');
  }

  const runs = (state.runs || []).slice(-10).reverse();
  if (runs.length) {
    lines.push('RECENT RUNS');
    lines.push('-'.repeat(72));
    for (const run of runs) {
      const outcome = run.fatal ? `ABORTED: ${run.fatal}` : `${run.changed} changed, ${run.failed} failed`;
      lines.push(`  ${run.startedAt}  ${pad(formatDuration(run.durationMs), 10)} ${outcome}`);
    }
    lines.push('');
  }

  const disabled = config.sources.filter((s) => !s.enabled);
  if (disabled.length) {
    lines.push(`sources disabled in the config: ${disabled.map((s) => s.name).join(', ')}`);
  }

  const text = lines.join('\n');
  return { subject, text, html: renderHeartbeatHtml({ config, state, probes, uptimeMs, logo: Boolean(config.smtp?.logo) }) };
}

function countTracked(state) {
  return Object.values(state.sources).reduce((n, s) => n + Object.keys(s.repos || {}).length, 0);
}

export const LOGO_CID = 'gbs-logo';

function renderHeartbeatHtml({ config, state, probes, uptimeMs, logo = false }) {
  const out = [
    h1('Still alive', `${new Date().toISOString()} · up ${formatDuration(uptimeMs)}`, logo ? LOGO_CID : null),
    para('Its absence is itself the alert: if this stops arriving, the service is not running.'),
  ];

  const configured = new Map(config.sources.map((s) => [s.name, s]));
  const sourceRows = [];
  for (const [name, source] of Object.entries(state.sources)) {
    const cfg = configured.get(name);
    const repos = Object.values(source.repos || {});
    const bytes = repos.reduce((n, r) => n + (r.sizeBytes || 0), 0);
    sourceRows.push([
      code(name) + (cfg ? (cfg.enabled ? '' : ' ' + badge('disabled')) : ' ' + badge('orphaned', WARN)),
      String(repos.length),
      escapeHtml(source.lastRunAt ?? 'never'),
      escapeHtml(formatBytes(bytes)),
      cfg ? code(destinationOf(cfg)) : '&mdash;',
    ]);
  }
  for (const source of config.sources) {
    if (state.sources[source.name]) continue;
    sourceRows.push([code(source.name) + ' ' + badge('never run'), '0', 'never', '0 B', code(destinationOf(source))]);
  }
  if (sourceRows.length) {
    out.push(h2('Sources'));
    out.push(table(['Source', 'Repositories', 'Last run', 'Disk', 'Destination'], sourceRows));
  }

  out.push(h2('Connections'));
  out.push(
    table(
      ['Connection', 'Host', 'Status', 'Rate limit', 'Token expires'],
      probes.map(({ connection, probe }) => [
        code(connection.name),
        escapeHtml(`${connection.provider} ${connection.host ?? ''}`.trim()),
        probe.ok
          ? badge('ok', OK) + escapeHtml(` ${probe.latencyMs} ms${probe.login ? `, ${probe.login}` : ''}`)
          : badge('unreachable', ACCENT) + ' ' + escapeHtml(firstLine(probe.error)),
        probe.rate?.remaining === null || probe.rate?.remaining === undefined
          ? '&mdash;'
          : escapeHtml(`${probe.rate.remaining}${probe.rate.limit ? ` of ${probe.rate.limit}` : ''}`),
        escapeHtml(probe.tokenExpiresAt ?? 'not exposed'),
      ]),
    ),
  );

  const failing = [];
  const never = [];
  for (const [name, source] of Object.entries(state.sources)) {
    for (const [repo, record] of Object.entries(source.repos || {})) {
      if (record.consecutiveFailures > 0) failing.push({ name, repo, record });
      if (!record.lastSuccess) never.push({ name, repo });
    }
  }

  if (failing.length) {
    failing.sort((a, b) => b.record.consecutiveFailures - a.record.consecutiveFailures);
    out.push(h2('Currently failing'));
    out.push(
      table(
        ['Repository', 'Runs', 'Last error'],
        failing.map((f) => [
          code(`${f.name}:${f.repo}`),
          badge(String(f.record.consecutiveFailures), f.record.consecutiveFailures > 3 ? ACCENT : WARN),
          escapeHtml(firstLine(f.record.lastError)),
        ]),
      ),
    );
  }

  if (never.length) {
    out.push(h2('Never synced successfully'));
    out.push(table(['Repository'], never.map((n) => [code(`${n.name}:${n.repo}`)])));
  }

  const runs = (state.runs || []).slice(-10).reverse();
  if (runs.length) {
    out.push(h2('Recent runs'));
    out.push(
      table(
        ['Started', 'Duration', 'Outcome'],
        runs.map((run) => [
          escapeHtml(run.startedAt),
          escapeHtml(formatDuration(run.durationMs)),
          run.fatal
            ? badge('aborted', ACCENT) + ' ' + escapeHtml(run.fatal)
            : escapeHtml(`${run.changed} changed, ${run.failed} failed`),
        ]),
      ),
    );
  }

  const disabled = config.sources.filter((s) => !s.enabled);
  if (disabled.length) out.push(para(`Disabled in the config: ${escapeHtml(disabled.map((s) => s.name).join(', '))}`));

  const next = nextScheduled(config);
  out.push(foot(next ? `Next scheduled sync ${escapeHtml(next)}` : 'No further runs scheduled'));

  return doc('Still alive', out.join(''));
}

function destinationOf(source) {
  const d = source.destination;
  if (d.type === 'directory') return `dir:${d.path}`;
  return `${d.connection}:${d.namespace ?? '(top level)'}`;
}
