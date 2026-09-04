import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { render, startMetricsServer } from '../src/metrics.js';
import { Notifier } from '../src/notify/index.js';
import { resolveNtfy } from '../src/notify/ntfy.js';
import { resolveKuma } from '../src/notify/kuma.js';
import { validate, configSchema } from '../src/config/schema.js';
import { setLevel } from '../src/logger.js';

setLevel('error');

async function receiver() {
  const got = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got.push({ url: new URL(req.url, 'http://x'), headers: req.headers, body });
      res.writeHead(200);
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { got, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

function buildReport(over = {}) {
  const counts = { new: 1, changed: 0, unchanged: 5, failed: 0, vanished: 0, excluded: 0, moved: 0, remapped: 0, planned: 0, ...over.counts };
  return {
    dryRun: false,
    fatal: null,
    durationMs: 1234,
    startedAt: new Date().toISOString(),
    totals: { ...counts, sources: 1, failedSources: over.failedSources ?? 0 },
    sources: [{ name: 's1', connection: 'c', destination: 'c:ns', counts, repos: over.repos ?? [], error: over.sourceError ?? null }],
    createdGroups: [], createdProjects: [], warnings: [], pruned: [], orphaned: [], disabled: [],
    ...over.report,
  };
}

function buildConfig(base, over = {}) {
  return validate(
    {
      connections: { c: { provider: 'gitlab', host: 'h', token: 'tok' } },
      smtp: { enabled: false },
      ntfy: { url: base, topic: 'global', ...over.ntfy },
      uptime_kuma: { url: `${base}/api/push/global`, ...over.kuma },
      sources: [
        {
          name: 's1',
          connection: 'c',
          scope: { type: 'self' },
          destination: { connection: 'c', namespace: 'ns' },
          ...over.source,
        },
      ],
    },
    configSchema,
  );
}

test('a per-source block inherits the global one without overriding it', () => {
  const merged = resolveNtfy({ url: 'https://ntfy.example.com', topic: 'global', token: 'secret' }, { topic: 'just-this-one' });
  assert.equal(merged.url, 'https://ntfy.example.com', 'the source did not set url, so the global one stands');
  assert.equal(merged.token, 'secret');
  assert.equal(merged.topic, 'just-this-one');

  assert.equal(resolveNtfy({ topic: 'g' }, { enabled: false }), null);
  assert.equal(resolveNtfy(null, null), null);
  assert.equal(resolveKuma({ url: 'https://k/a' }, { url: 'https://k/b' }).url, 'https://k/b');
});

test('Uptime Kuma is pushed even when nothing changed, because that is the point', async (t) => {
  const r = await receiver();
  t.after(() => r.close());

  const config = buildConfig(r.base, { ntfy: { enabled: false } });
  await new Notifier(config).runFinished(buildReport({ counts: { new: 0, changed: 0, unchanged: 18 } }));

  const pushes = r.got.filter((g) => g.url.pathname.startsWith('/api/push/'));
  assert.equal(pushes.length, 1, 'a quiet run still pings the dead man switch');
  assert.equal(pushes[0].url.searchParams.get('status'), 'up');
  assert.match(pushes[0].url.searchParams.get('msg'), /18 unchanged/);
  assert.equal(pushes[0].url.searchParams.get('ping'), '1234');
});

test('ntfy stays quiet when nothing changed and shouts when something failed', async (t) => {
  const r = await receiver();
  t.after(() => r.close());

  const config = buildConfig(r.base, { kuma: { enabled: false } });
  const notifier = new Notifier(config);

  await notifier.runFinished(buildReport({ counts: { new: 0, changed: 0, unchanged: 18 } }));
  assert.equal(r.got.length, 0, 'silence is the steady state');

  await notifier.runFinished(
    buildReport({
      counts: { new: 0, changed: 0, unchanged: 17, failed: 1 },
      repos: [{ repo: 'a/b', status: 'failed', error: 'git push exited with 1\nremote rejected' }],
    }),
    { sources: {}, runs: [] },
  );
  assert.equal(r.got.length, 1);
  assert.equal(r.got[0].headers.priority, '4', 'failures raise the priority');
  assert.match(r.got[0].headers.title, /1 failed/);
  assert.match(r.got[0].body, /a\/b/);
});

test('a per-source topic gets its own message, and the global topic is not sent twice', async (t) => {
  const r = await receiver();
  t.after(() => r.close());

  const config = buildConfig(r.base, {
    kuma: { enabled: false },
    source: { ntfy: { topic: 'just-s1' } },
  });
  await new Notifier(config).runFinished(
    buildReport({ counts: { new: 2, changed: 0, unchanged: 3 }, repos: [{ repo: 'a/b', status: 'new' }] }),
    { sources: {}, runs: [] },
  );

  const topics = r.got.map((g) => g.url.pathname.slice(1)).sort();
  assert.deepEqual(topics, ['global', 'just-s1']);
});

test('a source that reuses the global topic is not notified twice', async (t) => {
  const r = await receiver();
  t.after(() => r.close());

  const config = buildConfig(r.base, { kuma: { enabled: false }, source: { ntfy: { priority: 'low' } } });
  await new Notifier(config).runFinished(
    buildReport({ counts: { new: 2, changed: 0, unchanged: 3 }, repos: [{ repo: 'a/b', status: 'new' }] }),
    { sources: {}, runs: [] },
  );
  assert.equal(r.got.length, 1, 'same topic, so one message');
});

test('a notification failure never propagates', async (t) => {
  const dead = createServer((req, res) => {
    res.writeHead(500);
    res.end('nope');
  });
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${dead.address().port}`;
  t.after(() => new Promise((r) => dead.close(r)));

  const config = buildConfig(base, { ntfy: { retries: 0 }, kuma: { retries: 0 } });
  await new Notifier(config).runFinished(buildReport({ counts: { new: 1, changed: 0, unchanged: 0 } }));
  assert.ok(true);
});

test('metrics render and serve', async (t) => {
  const config = validate(
    {
      connections: { c: { provider: 'gitlab', host: 'h', token: 'tok' } },
      smtp: { enabled: false },
      sources: [{ name: 's1', connection: 'c', scope: { type: 'self' }, destination: { connection: 'c', namespace: 'ns' } }],
    },
    configSchema,
  );
  const state = {
    sources: {
      s1: {
        lastRunAt: '2026-09-02T03:00:00Z',
        repos: {
          'a/ok': { lastSuccess: '2026-09-02T03:00:00Z', consecutiveFailures: 0, sizeBytes: 1024 },
          'a/bad': { lastSuccess: null, consecutiveFailures: 4, sizeBytes: 0 },
        },
      },
      gone: { lastRunAt: null, repos: {} },
    },
    runs: [{ startedAt: '2026-09-02T03:00:00Z', durationMs: 5000, changed: 1, failed: 1, fatal: null }],
    lastHeartbeatAt: null,
  };

  const text = render({ config, state, lastReport: null, startedAt: Date.now() });
  assert.match(text, /gbs_source_repos\{source="s1"\} 2/);
  assert.match(text, /gbs_source_repos_failing\{source="s1"\} 1/);
  assert.match(text, /gbs_repo_consecutive_failures\{source="s1",repo="a\/bad"\} 4/);
  assert.match(text, /gbs_source_orphaned\{source="gone"\} 1/, 'a source in state but not in config is flagged');
  assert.match(text, /gbs_source_orphaned\{source="s1"\} 0/);
  assert.match(text, /gbs_last_run_ok 0/, 'the last run had a failure');
  assert.match(text, /# TYPE gbs_source_repos gauge/);

  const server = startMetricsServer(
    { enabled: true, host: '127.0.0.1', port: 0, path: '/metrics' },
    () => ({ config, state, lastReport: null, startedAt: Date.now(), health: { healthy: true, detail: 'fine' } }),
  );
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  t.after(() => server.close());

  const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(metrics.status, 200);
  assert.match(metrics.headers.get('content-type'), /text\/plain/);
  assert.match(await metrics.text(), /gbs_up 1/);

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.text()).trim(), 'fine');

  assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
});
