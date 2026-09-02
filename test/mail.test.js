import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRunMail } from '../src/mail/run-mail.js';
import { buildHeartbeatMail } from '../src/mail/heartbeat.js';
import { escapeHtml, badge, table, bar, statusBadge, shortStatus } from '../src/mail/theme.js';
import { formatDuration, formatBytes } from '../src/mail/format.js';

const CONFIG = {
  smtp: { subject_prefix: '[repo-sync]' },
  schedule: { sync: '0 3 * * *' },
  timezone: 'UTC',
  sources: [{ name: 'gh', enabled: true, destination: { connection: 'gl', namespace: 'mirror' } }],
};

const changes = (over = {}) => ({
  branches: { created: [], updated: [], deleted: [] },
  tags: { created: [], updated: [], deleted: [] },
  notes: { created: [], updated: [], deleted: [] },
  total: 0,
  changed: false,
  ...over,
});

function report(over = {}) {
  const counts = {
    new: 0, changed: 0, unchanged: 0, failed: 0, interrupted: 0,
    vanished: 0, excluded: 0, moved: 0, remapped: 0, planned: 0, ...over.counts,
  };
  return {
    reason: 'scheduled',
    startedAt: '2026-09-03T03:00:00Z',
    durationMs: 41_234,
    fatal: null,
    totals: { ...counts, sources: 1, failedSources: 0 },
    sources: [
      {
        name: 'gh',
        connection: 'gh-personal',
        destination: 'gl:mirror',
        filtered: 0,
        counts,
        repos: over.repos ?? [],
        error: over.sourceError ?? null,
        unreadable: over.unreadable,
      },
    ],
    createdGroups: [], createdProjects: [], warnings: [], pruned: [], orphaned: [], disabled: [],
    ...over.report,
  };
}

const busy = () =>
  report({
    counts: { new: 1, changed: 1, unchanged: 15, failed: 1, excluded: 1 },
    repos: [
      { repo: 'acme/router', status: 'new', createdProject: true, createdGroups: ['mirror/infra'],
        changes: changes({ branches: { created: [{ name: 'main' }], updated: [], deleted: [] }, total: 1, changed: true }),
        verification: { ok: true, checked: 3 } },
      { repo: 'acme/switch', status: 'changed',
        changes: changes({ tags: { created: [{ name: 'v2' }], updated: [], deleted: [] }, total: 1, changed: true }) },
      { repo: 'acme/old', status: 'excluded', reason: 'is archived and include_archived is false' },
      { repo: 'acme/broken', status: 'failed', error: 'git push exited with 1\nremote rejected', consecutiveFailures: 3 },
    ],
  });

test('the report is one self-contained document with no external assets', () => {
  const html = buildRunMail(busy(), CONFIG).html;
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<link|<script|<style/);
  assert.match(html, /style="/);
});

test('anything from a source is escaped before it reaches the mail', () => {
  const evil = report({
    counts: { failed: 1 },
    repos: [{ repo: '<img src=x onerror=alert(1)>', status: 'failed', error: '<script>evil</script>', consecutiveFailures: 1 }],
  });
  const html = buildRunMail(evil, CONFIG).html;
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>evil/);
  assert.match(html, /&lt;img src=x/);
});

test('escaping covers quotes, so a value cannot break out of an attribute', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#x27;');
});

test('a quiet run says so plainly and renders no empty tables', () => {
  const html = buildRunMail(report({ counts: { unchanged: 18 } }), CONFIG).html;
  assert.match(html, /Nothing changed/);
  assert.match(html, />Summary</);
  for (const heading of ['Warnings', 'Destination groups created', 'Currently failing']) {
    assert.doesNotMatch(html, new RegExp(`>${heading}<`), heading);
  }
});

test('an aborted run leads with the reason rather than burying it', () => {
  const aborted = report({ report: { fatal: '2 destination path collisions\n  mirror/utils\n    <- a/utils' } });
  const mail = buildRunMail(aborted, CONFIG);
  assert.match(mail.subject, /RUN ABORTED/);
  assert.match(mail.html, /Run aborted before any write/);
  assert.match(mail.html, /destination path collisions/);
});

test('a failure carries its streak and its git output', () => {
  const html = buildRunMail(busy(), CONFIG).html;
  assert.match(html, /acme\/broken/);
  assert.match(html, /3 runs in a row/);
  assert.match(html, /remote rejected/);
});

test('the html and the text agree on every count', () => {
  const mail = buildRunMail(busy(), CONFIG);
  for (const value of ['15', 'acme/router', 'acme/broken']) {
    assert.ok(mail.html.includes(value), `html is missing ${value}`);
    assert.ok(mail.text.includes(value), `text is missing ${value}`);
  }
});

test('the subject says what happened before the mail is opened', () => {
  assert.match(buildRunMail(busy(), CONFIG).subject, /^\[repo-sync\] 2 repos updated, 1 no longer mirrored, 1 failed$/);
  assert.match(buildRunMail(report({ counts: { unchanged: 5 } }), CONFIG).subject, /nothing changed$/);
});

test('the logo is referenced by content id, never remotely or as a data URI', async () => {
  const { LOGO_CID } = await import('../src/mail/run-mail.js');
  const withLogo = buildRunMail(busy(), { ...CONFIG, smtp: { ...CONFIG.smtp, logo: 'assets/logo.png' } }).html;
  assert.match(withLogo, new RegExp(`src="cid:${LOGO_CID}"`));
  assert.doesNotMatch(withLogo, /src="data:/);
  assert.doesNotMatch(withLogo, /src="https?:/);
});

test('no logo configured means no image tag, rather than a broken one', () => {
  assert.doesNotMatch(buildRunMail(busy(), CONFIG).html, /<img/);
});

test('an empty table renders nothing at all', () => {
  assert.equal(table(['A'], []), '');
  assert.match(table(['A'], [['1']]), /<table/);
});

test('a badge cannot be used to inject markup', () => {
  assert.match(badge('<b>x</b>'), /&lt;b&gt;x&lt;\/b&gt;/);
});

test('every status has a short form and a colour, including unknown ones', () => {
  assert.match(statusBadge('failed'), />FAIL</);
  assert.match(statusBadge('new'), />NEW</);
  assert.equal(shortStatus('something_new'), 'SOMET');
});

test('every colour lives in the theme, so one change reaches the whole mail', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const stray = [];
  for (const file of await readdir('src/mail')) {
    if (file === 'theme.js') continue;
    const text = await readFile(`src/mail/${file}`, 'utf8');
    for (const m of text.matchAll(/#[0-9a-fA-F]{6}/g)) stray.push(`${file}: ${m[0]}`);
  }
  assert.deepEqual(stray, [], 'colours belong in theme.js, not inlined at the call site');
});

test('a bar is always visible, even for a single repository', () => {
  assert.match(bar(1, 500), /width:2px/);
  assert.match(bar(500, 500), /width:160px/);
  assert.match(bar(0, 0), /width:2px/);
});

test('durations and sizes read the way a person would say them', () => {
  assert.equal(formatDuration(7_000), '7s');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(3_700_000), '1h 1m');
  assert.equal(formatDuration(undefined), 'unknown');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KiB');
});

test('the heartbeat reports every source, connection and failing repository', async () => {
  const state = {
    sources: {
      gh: {
        lastRunAt: '2026-09-03T03:00:00Z',
        repos: {
          'acme/ok': { lastSuccess: '2026-09-03T03:00:00Z', consecutiveFailures: 0, sizeBytes: 2048 },
          'acme/bad': { lastSuccess: null, consecutiveFailures: 4, sizeBytes: 0, lastError: 'permission denied' },
        },
      },
      gone: { lastRunAt: null, repos: {} },
    },
    runs: [{ startedAt: '2026-09-03T03:00:00Z', durationMs: 5000, changed: 1, failed: 1, fatal: null }],
  };
  const connections = {
    gl: { name: 'gl', provider: 'gitlab', host: 'gitlab.example.com', probe: async () => ({ ok: true, latencyMs: 42, login: 'someone', rate: { remaining: 1900, limit: 2000 }, tokenExpiresAt: null }) },
    down: { name: 'down', provider: 'github', host: 'github.com', probe: async () => ({ ok: false, error: 'HTTP 401 Bad credentials' }) },
  };

  const mail = await buildHeartbeatMail({ config: CONFIG, state, connections, uptimeMs: 3_600_000 });

  assert.match(mail.subject, /heartbeat: 2 repositories tracked/);
  assert.match(mail.html, /^<!doctype html>/);
  assert.match(mail.html, /Its absence is itself the alert/);
  assert.match(mail.html, /acme\/bad/);
  assert.match(mail.html, /permission denied/);
  assert.match(mail.html, /HTTP 401 Bad credentials/);
  assert.match(mail.html, />orphaned</, 'a source in state but not in config is flagged');
  assert.match(mail.html, /1900 of 2000/);
  assert.match(mail.html, />Never synced successfully</);
});

test('the heartbeat probes each connection once, not once per rendering', async () => {
  let probes = 0;
  const connections = {
    gl: { name: 'gl', provider: 'gitlab', host: 'h', probe: async () => { probes++; return { ok: true, latencyMs: 1 }; } },
  };
  await buildHeartbeatMail({ config: CONFIG, state: { sources: {}, runs: [] }, connections, uptimeMs: 1000 });
  assert.equal(probes, 1);
});
