import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { interpolate, interpolateString, InterpolationError } from '../src/config/interpolate.js';
import { validate, configSchema, ValidationError } from '../src/config/schema.js';
import { loadConfig } from '../src/config/load.js';
import { resolveMapping, findCollisions, slugifySegment, validatePath } from '../src/mapping.js';
import { parseCron, nextRun } from '../src/cron.js';
import { diffRefs, describeChanges, detectMoves } from '../src/diff.js';
import { memoryState } from '../src/state.js';
import { Job } from '../src/job.js';

test('interpolation: required, fallback, escape', () => {
  const env = { SET: 'value', EMPTY: '' };
  assert.equal(interpolateString('${SET}', 'a', env), 'value');
  assert.equal(interpolateString('${MISSING:-fb}', 'a', env), 'fb');
  assert.equal(interpolateString('${EMPTY:-fb}', 'a', env), 'fb', 'empty uses the fallback');
  assert.equal(interpolateString('$${SET}', 'a', env), '${SET}');
  assert.equal(interpolateString('pre-${SET}-post', 'a', env), 'pre-value-post');
});

test('interpolation: an unset required variable is fatal and names the key', () => {
  assert.throws(
    () => interpolate({ connections: { 'gh-work': { token: '${GH_WORK_TOKEN}' } } }, { env: {}, configPath: '/c.yaml' }),
    (err) => err instanceof InterpolationError && err.path === 'connections.gh-work.token' && /GH_WORK_TOKEN/.test(err.message),
  );
});

test('interpolation: single pass, an expansion is not rescanned', () => {
  assert.equal(interpolateString('${A}', 'a', { A: '${B}' }), '${B}');
});

test('interpolation: keys are never interpolated', () => {
  const { value } = interpolate({ '${NOPE}': 'x' }, { env: {} });
  assert.deepEqual(Object.keys(value), ['${NOPE}']);
});

test('interpolation: an Uptime Kuma push URL is a secret because of where it sits', async () => {
  const { redactedConfig } = await import('../src/config/load.js');
  const dumped = redactedConfig({
    uptime_kuma: { url: 'https://kuma.example.com/api/push/AbCdEf1234' },
    sources: [{ name: 's', uptime_kuma: { url: 'https://kuma.example.com/api/push/PerSource99' } }],
  });

  assert.equal(dumped.uptime_kuma.url, 'https://kuma.example.com/api/push/***');
  assert.equal(dumped.sources[0].uptime_kuma.url, 'https://kuma.example.com/api/push/***');
});

test('interpolation: the push token is scrubbed from logs, not just the dump', async () => {
  const { interpolate } = await import('../src/config/interpolate.js');
  const { redact } = await import('../src/logger.js');

  interpolate({ uptime_kuma: { url: '${KUMA}' } }, { env: { KUMA: 'https://kuma.example.com/api/push/SuperSecret1' } });
  assert.match(redact('push failed for https://kuma.example.com/api/push/SuperSecret1'), /\*\*\*/);
  assert.doesNotMatch(redact('push failed for https://kuma.example.com/api/push/SuperSecret1'), /SuperSecret1/);
});

test('schema: unknown keys are rejected with a suggestion', () => {
  const doc = baseDoc();
  doc.sources[0].include_archved = true;
  const err = catchError(() => validate(doc, configSchema));
  assert.ok(err instanceof ValidationError);
  const found = err.errors.find((e) => e.path === 'sources[0].include_archved');
  assert.ok(found, 'the unknown key is reported');
  assert.match(found.message, /include_archived/);
});

test('schema: string numbers from interpolation coerce', () => {
  const doc = baseDoc();
  doc.smtp.port = '2525';
  const out = validate(doc, configSchema);
  assert.equal(out.smtp.port, 2525);
});

test('schema: an invalid enum names the allowed values', () => {
  const doc = baseDoc();
  doc.sources[0].destination.structure = 'presrve';
  const err = catchError(() => validate(doc, configSchema));
  assert.ok(err instanceof ValidationError);
  assert.match(err.errors[0].message, /preserve, flatten, template/);
});

test('mapping: preserve, flatten and template', () => {
  const repo = repoRecord({ fullPath: 'userA/infra/network/router', repo: 'router', relativePath: 'infra/network', owner: 'network' });

  const preserve = resolveMapping(repo, sourceDef({ structure: 'preserve', namespace: 'mirror' }));
  assert.equal(preserve.path, 'mirror/infra/network/router');
  assert.deepEqual(preserve.subgroups, ['infra', 'network']);

  const flatten = resolveMapping(repo, sourceDef({ structure: 'flatten', namespace: 'mirror' }));
  assert.equal(flatten.path, 'mirror/infra-network-router');
  assert.deepEqual(flatten.subgroups, []);

  const template = resolveMapping(repo, sourceDef({ structure: 'template', namespace: 'mirror', path_template: 'acme-{repo}' }));
  assert.equal(template.path, 'mirror/acme-router');
});

test('mapping: only the first segment of `namespace` is the root', () => {
  const repo = repoRecord({ fullPath: 'userA/infra/router', repo: 'router', relativePath: 'infra' });
  const m = resolveMapping(repo, sourceDef({ structure: 'template', namespace: 'userA-mirror/infrastructure', path_template: '{repo}' }));
  assert.equal(m.path, 'userA-mirror/infrastructure/router');
  assert.equal(m.namespace, 'userA-mirror', 'the root, which is never created automatically');
  assert.deepEqual(m.subgroups, ['infrastructure'], 'everything below the root is auto-creatable');
});

test('mapping: visibility `original` resolves per repository', () => {
  const pub = repoRecord({ fullPath: 'userA/open', repo: 'open', visibility: 'public' });
  const priv = repoRecord({ fullPath: 'userA/closed', repo: 'closed', visibility: 'private' });
  const source = sourceDef({ structure: 'flatten', namespace: 'mirror', visibility: 'original' });

  assert.equal(resolveMapping(pub, source).visibility, 'public');
  assert.equal(resolveMapping(priv, source).visibility, 'private');
  assert.equal(resolveMapping(pub, source).visibilityMode, 'original');

  const fixed = sourceDef({ structure: 'flatten', namespace: 'mirror', visibility: 'private' });
  assert.equal(resolveMapping(pub, fixed).visibility, 'private');
});

test('mapping: with no namespace the source groups become top-level groups', () => {
  const nested = repoRecord({ fullPath: 'acme/infra/router', repo: 'router', relativePath: 'acme/infra' });
  const source = sourceDef({ structure: 'preserve', namespace: '' });

  const m = resolveMapping(nested, source);
  assert.equal(m.path, 'acme/infra/router');
  assert.equal(m.namespace, 'acme', 'the source top group is the root, and needs creating');
  assert.deepEqual(m.subgroups, ['infra']);

  const prefixed = resolveMapping(nested, sourceDef({ structure: 'preserve', namespace: '', path_prefix: 'src-' }));
  assert.equal(prefixed.path, 'src-acme/infra/router');
  assert.equal(prefixed.namespace, 'src-acme');
});

test('mapping: with no namespace a repository outside any group is rejected', () => {
  const flat = repoRecord({ fullPath: 'userA/scratch', repo: 'scratch', relativePath: '' });
  const result = resolveMapping(flat, sourceDef({ structure: 'preserve', namespace: '' }));
  assert.ok(result.error);
  assert.match(result.error, /top-level project/);
  assert.match(result.error, /namespace/);
});

test('mapping: rules match first and can skip', () => {
  const repo = repoRecord({ fullPath: 'userA/scratch/toy', repo: 'toy', relativePath: 'scratch' });
  const source = sourceDef({
    structure: 'preserve',
    namespace: 'mirror',
    rules: [{ match: '^userA/scratch/', skip: true }, { match: '.*', namespace: 'other' }],
  });
  const result = resolveMapping(repo, source);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /rule\[0\]/);
});

test('mapping: a rule path_template implies template structure', () => {
  const repo = repoRecord({ fullPath: 'userA/infra/router', repo: 'router', relativePath: 'infra' });
  const source = sourceDef({
    structure: 'preserve',
    namespace: 'mirror',
    rules: [{ match: '^userA/infra/(.*)$', namespace: 'mirror/infrastructure', path_template: '{repo}' }],
  });
  assert.equal(resolveMapping(repo, source).path, 'mirror/infrastructure/router');
});

test('mapping: rendered segments are slugified and validated', () => {
  assert.equal(slugifySegment('My Repo!'), 'My-Repo');
  assert.equal(slugifySegment('--weird--'), 'weird');
  assert.equal(slugifySegment('.hidden'), 'hidden');
  assert.match(validatePath('ns/repo.git'), /\.git or \.atom/);
  assert.equal(validatePath('ns/a..b'), '"ns/a..b" contains ".."');
  assert.equal(validatePath('ns/ok-name'), null);
});

test('mapping: two sources resolving to one path is a collision', () => {
  const a = resolveMapping(repoRecord({ fullPath: 'userA/utils', repo: 'utils' }), sourceDef({ name: 'src-a', structure: 'flatten', namespace: 'mirror' }));
  const b = resolveMapping(repoRecord({ fullPath: 'orgA/utils', repo: 'utils' }), sourceDef({ name: 'src-b', structure: 'flatten', namespace: 'mirror' }));
  const { collisions } = findCollisions([a, b], { 'gl-new': { host: 'gitlab.com' } });
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].path, 'mirror/utils');
  assert.equal(collisions[0].a.repo.fullPath, 'userA/utils');
  assert.equal(collisions[0].b.repo.fullPath, 'orgA/utils');
});

test('mapping: a destination equal to its own source on the same host is a self-mirror', () => {
  const repo = repoRecord({ fullPath: 'mirror/router', repo: 'router', host: 'gitlab.com' });
  const m = resolveMapping(repo, sourceDef({ structure: 'flatten', namespace: 'mirror' }));
  const { selfMirrors } = findCollisions([m], { 'gl-new': { host: 'gitlab.com' } });
  assert.equal(selfMirrors.length, 1);
});

test('pool: no pause keeps a continuous worker pool', async () => {
  const { pool } = await import('../src/sync/pool.js');

  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 9 }, (_, i) => i);
  const out = await pool(items, 3, async (i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, i === 0 ? 60 : 5));
    inFlight--;
    return i;
  }, { job: new Job() });

  assert.equal(out.length, 9);
  assert.equal(peak, 3, 'never exceeds the concurrency limit');
});

test('pool: a pause runs fixed batches and waits between them', async () => {
  const { pool } = await import('../src/sync/pool.js');

  const starts = [];
  const t0 = Date.now();
  const items = [0, 1, 2, 3];
  const out = await pool(items, 2, async (i) => {
    starts.push(Date.now() - t0);
    return i;
  }, { job: new Job(), pauseMs: 120 });

  assert.deepEqual(out, [0, 1, 2, 3]);
  assert.ok(starts[1] < 60, 'the first two run together');
  assert.ok(starts[2] >= 100, `the second batch waited, started at ${starts[2]}ms`);
});

test('pool: a pause survives an otherwise empty event loop', async () => {
  // This has to run in a bare child process. Inside the test runner there is
  // always other work pending, which is exactly what hid the bug where the
  // pause timer was unref'd and the process exited cleanly mid-run.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);

  const script = `
    import { pool } from '${process.cwd()}/src/sync/pool.js';
    import { Job } from '${process.cwd()}/src/job.js';
    const out = await pool([1, 2, 3, 4], 2, async (i) => i, { job: new Job(), pauseMs: 400 });
    console.log(JSON.stringify(out));
  `;

  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', script], { timeout: 15_000 });
  assert.equal(stdout.trim(), '[1,2,3,4]', 'every batch ran; the process did not exit during the pause');
});

test('pool: a batch that changed nothing is not waited out', async () => {
  const { pool } = await import('../src/sync/pool.js');

  const items = [
    { status: 'unchanged' },
    { status: 'unchanged' },
    { status: 'new' },
    { status: 'unchanged' },
    { status: 'unchanged' },
    { status: 'unchanged' },
  ];
  const paused = [];
  const t0 = Date.now();
  const starts = [];

  await pool(items, 2, async (item) => {
    starts.push(Date.now() - t0);
    return item;
  }, {
    job: new Job(),
    pauseMs: 300,
    pauseWhen: (batch) => batch.some((r) => r.status === 'new' || r.status === 'changed'),
    onPause: (batch) => paused.push(batch.map((r) => r.status).join('+')),
  });

  assert.deepEqual(paused, ['new+unchanged'], 'only the batch that did work was followed by a pause');
  assert.ok(starts[2] < 150, `the second batch started immediately, at ${starts[2]}ms`);
  assert.ok(starts[4] >= 250, `the third batch waited, started at ${starts[4]}ms`);
});

test('cron: parses and fires in the configured zone', () => {
  const at = nextRun(parseCron('0 3 * * *'), new Date('2026-09-02T12:00:00Z'), 'Europe/Berlin');
  assert.equal(at.toISOString(), '2026-09-03T01:00:00.000Z', '03:00 Berlin is 01:00 UTC in summer');

  const monday = nextRun(parseCron('0 8 * * mon'), new Date('2026-09-02T12:00:00Z'), 'UTC');
  assert.equal(monday.toISOString(), '2026-09-07T08:00:00.000Z');

  assert.throws(() => parseCron('0 3 * *'), /exactly 5 fields/);
  assert.throws(() => parseCron('99 3 * * *'), /out of range/);
});

test('cron: survives a spring-forward transition', () => {
  const at = nextRun(parseCron('30 2 * * *'), new Date('2026-03-28T12:00:00Z'), 'Europe/Berlin');
  assert.ok(at.getTime() > new Date('2026-03-28T12:00:00Z').getTime());
});

test('diff: classifies created, updated and deleted refs', () => {
  const before = new Map([['refs/heads/main', 'aaa'], ['refs/tags/v1', 'ttt']]);
  const after = new Map([['refs/heads/main', 'bbb'], ['refs/heads/feat', 'ccc']]);
  const d = diffRefs(before, after);
  assert.equal(d.branches.updated.length, 1);
  assert.equal(d.branches.created.length, 1);
  assert.equal(d.tags.deleted.length, 1);
  assert.equal(describeChanges(d), '1 branch created, 1 branch updated, 1 tag deleted');
});

test('diff: provider bookkeeping refs never count as a change', () => {
  const before = new Map([['refs/heads/main', 'aaa']]);
  const after = new Map([['refs/heads/main', 'aaa'], ['refs/merge-requests/7/head', 'xyz'], ['refs/pull/3/head', 'zzz']]);
  assert.equal(diffRefs(before, after).changed, false);
});

test('diff: a transfer is one move, not a disappearance plus an arrival', () => {
  const vanished = [{ repo: 'old/router', refs: { 'refs/heads/main': 'sha1' } }];
  const fresh = [{ repo: 'new/router', refs: { 'refs/heads/main': 'sha1' } }];
  const { moves, stillVanished, stillNew } = detectMoves(vanished, fresh);
  assert.equal(moves.length, 1);
  assert.equal(stillVanished.length, 0);
  assert.equal(stillNew.length, 0);
});

test('diff: same-named repositories with no shared commit are not a move', () => {
  const vanished = [{ repo: 'a/utils', refs: { 'refs/heads/main': 'sha1' } }];
  const fresh = [{ repo: 'b/utils', refs: { 'refs/heads/main': 'sha2' } }];
  assert.equal(detectMoves(vanished, fresh).moves.length, 0);
});

test('state: a repository record survives a reload of the store', async () => {
  const state = await memoryState();
  const source = await state.source('github');
  await source.setConnection('gh');
  await source.putRepo('a/b', {
    destination: 'gl:mirror/b',
    refs: { 'refs/heads/main': 'x' },
    wiki: { refs: { 'refs/heads/master': 'w' }, lastSuccess: '2026-01-01T00:00:00Z' },
    lastSuccess: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
    consecutiveFailures: 0,
    lastError: null,
    sizeBytes: 4096,
    usesLfs: true,
    createdByService: true,
  });

  await state.reload();
  const record = state.sources.github.repos['a/b'];
  assert.equal(state.sources.github.connection, 'gh');
  assert.equal(record.refs['refs/heads/main'], 'x');
  assert.equal(record.wiki.refs['refs/heads/master'], 'w');
  assert.equal(record.sizeBytes, 4096);
  assert.equal(record.usesLfs, true);
  assert.equal(record.createdByService, true);
  await state.close();
});

test('state: forgetting a source takes its repositories with it', async () => {
  const state = await memoryState();
  const source = await state.source('retired');
  await source.putRepo('old/thing', { destination: 'gl:mirror/thing', refs: {} });

  await state.forgetSource('retired');
  await state.reload();

  assert.equal(state.sources.retired, undefined);
  assert.equal((await state.dump()).repo.length, 0, 'the rows cascade');
  await state.close();
});

test('state: runs are trimmed to the retention limit, newest kept', async () => {
  const state = await memoryState();
  for (let i = 0; i < 5; i++) {
    await state.addRun({ startedAt: `2026-01-0${i + 1}T00:00:00Z`, durationMs: i, reason: 'test' }, { keep: 3 });
  }
  await state.reload();

  assert.equal(state.runs.length, 3);
  assert.equal(state.runs[0].startedAt, '2026-01-03T00:00:00Z');
  assert.equal(state.runs.at(-1).startedAt, '2026-01-05T00:00:00Z');
  await state.close();
});

test('job: stopping is per job, not per process', () => {
  const one = new Job({ reason: 'a' });
  const two = new Job({ reason: 'b' });
  one.stop();
  assert.equal(one.stopping, true);
  assert.equal(two.stopping, false, 'cancelling one job leaves the other running');
});

test('loadConfig: the database defaults to sqlite beside the data directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gbs-'));
  try {
    const file = path.join(dir, 'config.yml');
    await writeFile(file, YAML_DOC);
    const config = await loadConfig({ path: file, env: FULL_ENV });
    assert.equal(config.database.driver, 'sqlite');
    assert.equal(config.database.path, '/tmp/gbs/state.db');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: DB_* fills the database block and the file wins over it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gbs-'));
  try {
    const file = path.join(dir, 'config.yml');
    await writeFile(file, YAML_DOC);
    const fromEnv = await loadConfig({ path: file, env: { ...FULL_ENV, DB_PATH: '/srv/state.db' } });
    assert.equal(fromEnv.database.path, '/srv/state.db');

    await writeFile(file, `database:\n  path: /from/file.db\n${YAML_DOC}`);
    const fromFile = await loadConfig({ path: file, env: { ...FULL_ENV, DB_PATH: '/srv/state.db' } });
    assert.equal(fromFile.database.path, '/from/file.db');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: a postgres field on a sqlite database is named, not ignored', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gbs-'));
  try {
    const file = path.join(dir, 'config.yml');
    await writeFile(file, YAML_DOC);
    await assert.rejects(
      loadConfig({ path: file, env: { ...FULL_ENV, DB_HOST: 'db.example.com' } }),
      (err) => /database\.host/.test(err.message) && /postgres/.test(err.message),
    );
    await assert.rejects(
      loadConfig({ path: file, env: { ...FULL_ENV, DB_DRIVER: 'postgres' } }),
      (err) => /database\.host/.test(err.message) && /DB_HOST/.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: an unset token exits with the offending key named', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gbs-'));
  try {
    const file = path.join(dir, 'config.yml');
    await writeFile(file, YAML_DOC);
    await assert.rejects(
      loadConfig({ path: file, env: { ...FULL_ENV, GH_WORK_TOKEN: undefined } }),
      (err) => /connections\.gh-work\.token/.test(err.message) && /GH_WORK_TOKEN/.test(err.message),
    );
    const config = await loadConfig({ path: file, env: FULL_ENV });
    assert.equal(config.sources[0].destination.structure, 'flatten');
    assert.equal(config.sources[0].include_forks, false, 'defaults are pushed down onto sources');
    assert.equal(config.smtp.port, 2525);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: mail can be disabled with the smtp block still present and blank', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gbs-'));
  try {
    const file = path.join(dir, 'config.yml');
    await writeFile(file, YAML_DOC.replace('smtp:', 'smtp:\n  enabled: false'));
    const env = { GH_WORK_TOKEN: 'x'.repeat(12), GL_NEW_TOKEN: 'y'.repeat(12), SMTP_HOST: '', SMTP_PORT: '', SMTP_FROM: '', SMTP_TO: '' };
    const config = await loadConfig({ path: file, env });
    assert.equal(config.smtp.enabled, false);
    assert.deepEqual(config.smtp.to, [], 'blank recipients are dropped, never sent to ""');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: blank mail settings are still rejected while mail is enabled', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gbs-'));
  try {
    const file = path.join(dir, 'config.yml');
    await writeFile(file, YAML_DOC);
    const env = { GH_WORK_TOKEN: 'x'.repeat(12), GL_NEW_TOKEN: 'y'.repeat(12), SMTP_HOST: '', SMTP_PORT: '', SMTP_FROM: '', SMTP_TO: '' };
    await assert.rejects(
      loadConfig({ path: file, env }),
      (err) => /smtp\.host/.test(err.message) && /smtp\.to/.test(err.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: the timezone comes from TZ unless the config names one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gbs-'));
  try {
    const file = path.join(dir, 'config.yml');
    const env = { ...FULL_ENV, TZ: 'Europe/Vienna' };

    await writeFile(file, YAML_DOC);
    assert.equal((await loadConfig({ path: file, env })).timezone, 'Europe/Vienna');
    assert.equal((await loadConfig({ path: file, env: FULL_ENV })).timezone, 'UTC');

    await writeFile(file, 'timezone: Asia/Tokyo\n' + YAML_DOC);
    assert.equal((await loadConfig({ path: file, env })).timezone, 'Asia/Tokyo', 'the config wins');

    await writeFile(file, YAML_DOC);
    await assert.rejects(
      loadConfig({ path: file, env: { ...FULL_ENV, TZ: 'Europe/Wien' } }),
      /not a recognised IANA time zone/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig: a destination on a github connection is rejected', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gbs-'));
  try {
    const file = path.join(dir, 'config.yml');
    await writeFile(file, YAML_DOC.replace('connection: gl-new', 'connection: gh-work'));
    await assert.rejects(loadConfig({ path: file, env: FULL_ENV }), (err) => /a gitlab destination needs a gitlab connection/.test(err.message));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const FULL_ENV = { GH_WORK_TOKEN: 'ghp_example_token', GL_NEW_TOKEN: 'glpat_example_token', SMTP_HOST: 'smtp.example.com', SMTP_PORT: '2525', SMTP_FROM: 'a@example.com', SMTP_TO: 'b@example.com' };

const YAML_DOC = `
data_dir: /tmp/gbs
connections:
  gh-work:
    provider: github
    token: \${GH_WORK_TOKEN}
  gl-new:
    provider: gitlab
    host: gitlab.com
    token: \${GL_NEW_TOKEN}
smtp:
  host: \${SMTP_HOST}
  port: \${SMTP_PORT:-587}
  from: \${SMTP_FROM}
  to: [ "\${SMTP_TO}" ]
sources:
  - name: gh-me
    connection: gh-work
    scope:
      type: org
      login: acme
    destination:
      connection: gl-new
      namespace: userB
      structure: flatten
`;

function catchError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

function baseDoc() {
  return {
    connections: { c: { provider: 'gitlab', host: 'gitlab.com', token: 't' } },
    smtp: { host: 'h', from: 'f@x', to: ['t@x'] },
    sources: [
      { name: 's', connection: 'c', scope: { type: 'self' }, destination: { connection: 'c', namespace: 'ns' } },
    ],
  };
}

function repoRecord(over = {}) {
  return {
    source: 'src',
    provider: 'gitlab',
    host: 'gitlab.example.com',
    fullPath: 'userA/router',
    owner: 'userA',
    repo: 'router',
    relativePath: '',
    ...over,
  };
}

function sourceDef({ name = 'src', structure = 'preserve', namespace = 'mirror', path_template = '{repo}', rules = [], flatten_separator = '-', visibility = 'private', path_prefix = undefined } = {}) {
  return {
    name,
    connection: 'gl-old',
    rules,
    destination: {
      connection: 'gl-new',
      namespace,
      structure,
      path_template,
      flatten_separator,
      path_prefix,
      visibility,
      auto_create_namespaces: true,
      on_remap: 'report',
    },
  };
}
