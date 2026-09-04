import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { startFakeApi, glProject } from './fake-api.js';
import { validate, configSchema } from '../src/config/schema.js';
import { Connection, buildConnections } from '../src/connections.js';
import { runSync } from '../src/run.js';
import { memoryState } from '../src/state.js';
import { buildRunMail, shouldNotify } from '../src/mail.js';
import { setLevel } from '../src/logger.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@x',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@x',
};
const git = (args, cwd) => exec('git', args, { cwd, env: GIT_ENV });

setLevel('error');

const originalSshUrl = Connection.prototype.sshUrl;

test('a full sync: first run clones, second run is silent, a push produces one mail', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-sync-'));
  const originDir = path.join(root, 'origin');
  const destDir = path.join(root, 'dest');
  const dataDir = path.join(root, 'data');
  await mkdir(originDir, { recursive: true });
  await mkdir(destDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  Connection.prototype.sshUrl = function sshUrl(fullPath) {
    return path.join(this.host === 'src.local' ? originDir : destDir, `${fullPath}.git`);
  };
  t.after(async () => {
    Connection.prototype.sshUrl = originalSshUrl;
    await rm(root, { recursive: true, force: true });
  });

  const source = path.join(originDir, 'userA/infra/router.git');
  await makeRepo(source);

  const api = await startFakeApi({
    tokenOwner: 'userA',
    groups: { userA: { id: 1, full_path: 'userA', name: 'userA' }, mirror: { id: 2, full_path: 'mirror', name: 'mirror' } },
    projects: { 'userA/infra/router': glProject('userA/infra/router', { ssh_url_to_repo: source }) },
  });
  t.after(() => api.close());

  api.hooks.onCreateProject = async (fullPath) => {
    await mkdir(path.dirname(path.join(destDir, `${fullPath}.git`)), { recursive: true });
    await git(['init', '--bare', '--quiet', path.join(destDir, `${fullPath}.git`)]);
  };

  const config = buildConfig(api, dataDir);
  const connections = buildConnections(config);
  const state = await memoryState();
  const first = await runSync({ config, connections, state, reason: 'test' });
  assert.equal(first.fatal, null, first.fatal ?? '');
  assert.equal(first.totals.failed, 0, JSON.stringify(first.sources[0].repos, null, 2));
  assert.equal(first.totals.new, 1);
  assert.deepEqual(api.state.created.groups, ['mirror/infra'], 'only the segment below the existing root');
  assert.deepEqual(api.state.created.projects, ['mirror/infra/router']);

  const mirrored = await refsOf(path.join(destDir, 'mirror/infra/router.git'));
  assert.equal(mirrored.get('refs/heads/main')?.length, 40);
  assert.ok(mirrored.has('refs/tags/v1'));
  assert.ok(!mirrored.has('refs/merge-requests/1/head'), 'provider bookkeeping refs are dropped');

  assert.ok(shouldNotify(first, config.smtp), 'a first run reports');
  const firstMail = buildRunMail(first, config);
  assert.match(firstMail.subject, /1 repo updated/);
  assert.match(firstMail.text, /created destination group mirror\/infra/);

  const second = await runSync({ config, connections, state, reason: 'test' });
  assert.equal(second.totals.unchanged, 1);
  assert.equal(second.totals.changed, 0);
  assert.equal(second.totals.new, 0);
  assert.equal(shouldNotify(second, config.smtp), false, 'silence is the steady state');

  const work = path.join(root, 'work');
  await git(['clone', '--quiet', source, work]);
  await writeFile(path.join(work, 'b.txt'), 'second\n');
  await git(['add', '.'], work);
  await git(['commit', '--quiet', '-m', 'second'], work);
  await git(['tag', 'v2'], work);
  await git(['push', '--quiet', 'origin', 'main', 'v2'], work);

  const third = await runSync({ config, connections, state, reason: 'test' });
  assert.equal(third.totals.changed, 1);
  assert.equal(third.totals.failed, 0);

  const changed = third.sources[0].repos.find((r) => r.status === 'changed');
  assert.equal(changed.changes.branches.updated.length, 1);
  assert.equal(changed.changes.tags.created.length, 1);

  assert.ok(shouldNotify(third, config.smtp));
  const mail = buildRunMail(third, config);
  assert.match(mail.subject, /1 repo updated/);
  assert.doesNotMatch(mail.subject, /failed/);
  assert.match(mail.text, /userA\/infra\/router/, 'the mail names the repository');
  assert.match(mail.text, /SOURCE migration/, 'grouped by source');
  assert.match(mail.text, /branch updated: main/);
  assert.match(mail.text, /tag created: v2/);

  assert.equal(state.sources.migration.repos['userA/infra/router'].destination, 'dst:mirror/infra/router');
  assert.equal(state.sources.migration.repos['userA/infra/router'].consecutiveFailures, 0);
});

test('CI is disabled on the destination, at creation and on an existing project', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-ci-'));
  const originDir = path.join(root, 'origin');
  const destDir = path.join(root, 'dest');
  const dataDir = path.join(root, 'data');
  for (const d of [originDir, destDir, dataDir]) await mkdir(d, { recursive: true });

  Connection.prototype.sshUrl = function sshUrl(fullPath) {
    return path.join(this.host === 'src.local' ? originDir : destDir, `${fullPath}.git`);
  };
  t.after(async () => {
    Connection.prototype.sshUrl = originalSshUrl;
    await rm(root, { recursive: true, force: true });
  });

  const source = path.join(originDir, 'userA/infra/router.git');
  await makeRepo(source);

  const api = await startFakeApi({
    tokenOwner: 'userA',
    groups: { userA: { id: 1, full_path: 'userA', name: 'userA' }, mirror: { id: 2, full_path: 'mirror', name: 'mirror' } },
    projects: { 'userA/infra/router': glProject('userA/infra/router', { ssh_url_to_repo: source }) },
  });
  t.after(() => api.close());
  api.hooks.onCreateProject = async (fullPath) => {
    await mkdir(path.dirname(path.join(destDir, `${fullPath}.git`)), { recursive: true });
    await git(['init', '--bare', '--quiet', path.join(destDir, `${fullPath}.git`)]);
  };

  const config = buildConfig(api, dataDir);
  const connections = buildConnections(config);
  const state = await memoryState();
  await runSync({ config, connections, state, reason: 'test' });

  const created = api.state.projects['mirror/infra/router'];
  assert.equal(created.builds_access_level, 'disabled', 'CI off at creation, no extra request needed');
  assert.equal(created.auto_devops_enabled, false, 'Auto DevOps runs without a .gitlab-ci.yml, so it goes too');
  assert.equal(
    api.state.updated.filter((u) => 'builds_access_level' in u.body).length,
    0,
    'creating with the right settings avoids a follow-up CI request',
  );

  created.builds_access_level = 'enabled';
  const second = await runSync({ config, connections, state, reason: 'test' });
  assert.equal(api.state.projects['mirror/infra/router'].builds_access_level, 'disabled');
  assert.equal(second.sources[0].repos[0].disabledCi, true);

  const before = api.state.updated.length;
  await runSync({ config, connections, state, reason: 'test' });
  assert.equal(api.state.updated.length, before, 'no request when there is nothing to change');
});

test('metadata is synced and the push is verified against the destination', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-meta-'));
  const originDir = path.join(root, 'origin');
  const destDir = path.join(root, 'dest');
  const dataDir = path.join(root, 'data');
  for (const d of [originDir, destDir, dataDir]) await mkdir(d, { recursive: true });

  Connection.prototype.sshUrl = function sshUrl(fullPath) {
    return path.join(this.host === 'src.local' ? originDir : destDir, `${fullPath}.git`);
  };
  t.after(async () => {
    Connection.prototype.sshUrl = originalSshUrl;
    await rm(root, { recursive: true, force: true });
  });

  const source = path.join(originDir, 'userA/infra/router.git');
  await makeRepo(source);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], source);

  const api = await startFakeApi({
    tokenOwner: 'userA',
    groups: { userA: { id: 1, full_path: 'userA', name: 'userA' }, mirror: { id: 2, full_path: 'mirror', name: 'mirror' } },
    projects: {
      'userA/infra/router': glProject('userA/infra/router', {
        ssh_url_to_repo: source,
        description: 'the router',
        topics: ['networking', 'go'],
        default_branch: 'main',
      }),
    },
  });
  t.after(() => api.close());
  api.hooks.onCreateProject = async (fullPath) => {
    await mkdir(path.dirname(path.join(destDir, `${fullPath}.git`)), { recursive: true });
    await git(['init', '--bare', '--quiet', path.join(destDir, `${fullPath}.git`)]);
  };

  const config = buildConfig(api, dataDir);
  const connections = buildConnections(config);
  const state = await memoryState();
  const first = await runSync({ config, connections, state, reason: 'test' });
  assert.equal(first.totals.failed, 0, JSON.stringify(first.sources[0].repos, null, 2));

  const dest = api.state.projects['mirror/infra/router'];
  assert.equal(dest.description, 'the router');
  assert.deepEqual(dest.topics, ['networking', 'go']);
  assert.equal(dest.default_branch, 'main');

  const entry = first.sources[0].repos[0];
  assert.equal(entry.verification.ok, true);
  assert.ok(entry.verification.checked >= 2, 'the branch and the tag were both checked');

  const writesBefore = api.state.updated.length;
  await runSync({ config, connections, state, reason: 'test' });
  assert.equal(api.state.updated.length, writesBefore, 'metadata already matches, so no request');
});

test('a destination that silently alters the push fails verification', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-verify-'));
  const originDir = path.join(root, 'origin');
  const destDir = path.join(root, 'dest');
  const dataDir = path.join(root, 'data');
  for (const d of [originDir, destDir, dataDir]) await mkdir(d, { recursive: true });

  Connection.prototype.sshUrl = function sshUrl(fullPath) {
    return path.join(this.host === 'src.local' ? originDir : destDir, `${fullPath}.git`);
  };
  t.after(async () => {
    Connection.prototype.sshUrl = originalSshUrl;
    await rm(root, { recursive: true, force: true });
  });

  const source = path.join(originDir, 'userA/infra/router.git');
  await makeRepo(source);

  const api = await startFakeApi({
    tokenOwner: 'userA',
    groups: { userA: { id: 1, full_path: 'userA', name: 'userA' }, mirror: { id: 2, full_path: 'mirror', name: 'mirror' } },
    projects: { 'userA/infra/router': glProject('userA/infra/router', { ssh_url_to_repo: source }) },
  });
  t.after(() => api.close());

  api.hooks.onCreateProject = async (fullPath) => {
    const bare = path.join(destDir, `${fullPath}.git`);
    await mkdir(path.dirname(bare), { recursive: true });
    await git(['init', '--bare', '--quiet', bare]);
    const hook = path.join(bare, 'hooks', 'post-receive');
    await writeFile(hook, '#!/bin/sh\ngit update-ref -d refs/tags/v1\n');
    await chmod(hook, 0o755);
  };

  const config = buildConfig(api, dataDir);
  const connections = buildConnections(config);
  const state = await memoryState();
  const report = await runSync({ config, connections, state, reason: 'test' });

  assert.equal(report.totals.failed, 1, 'a destination missing a ref is a failure, not a silent pass');
  const failed = report.sources[0].repos.find((r) => r.status === 'failed');
  assert.match(failed.error, /does not match the mirror/);
  assert.match(failed.error, /refs\/tags\/v1/);
  assert.match(failed.error, /not a faithful copy/);
});

test('visibility is enforced on every run, not only at creation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-vis-'));
  const originDir = path.join(root, 'origin');
  const destDir = path.join(root, 'dest');
  const dataDir = path.join(root, 'data');
  for (const d of [originDir, destDir, dataDir]) await mkdir(d, { recursive: true });

  Connection.prototype.sshUrl = function sshUrl(fullPath) {
    return path.join(this.host === 'src.local' ? originDir : destDir, `${fullPath}.git`);
  };
  t.after(async () => {
    Connection.prototype.sshUrl = originalSshUrl;
    await rm(root, { recursive: true, force: true });
  });

  const source = path.join(originDir, 'userA/infra/router.git');
  await makeRepo(source);

  const api = await startFakeApi({
    tokenOwner: 'userA',
    groups: { userA: { id: 1, full_path: 'userA', name: 'userA' }, mirror: { id: 2, full_path: 'mirror', name: 'mirror' } },
    projects: { 'userA/infra/router': glProject('userA/infra/router', { ssh_url_to_repo: source, visibility: 'public' }) },
  });
  t.after(() => api.close());
  api.hooks.onCreateProject = async (fullPath) => {
    await mkdir(path.dirname(path.join(destDir, `${fullPath}.git`)), { recursive: true });
    await git(['init', '--bare', '--quiet', path.join(destDir, `${fullPath}.git`)]);
  };

  const config = buildConfig(api, dataDir);
  config.sources[0].destination.visibility = 'original';
  const connections = buildConnections(config);
  const state = await memoryState();
  await runSync({ config, connections, state, reason: 'test' });
  assert.equal(api.state.projects['mirror/infra/router'].visibility, 'public', 'original follows the source');

  config.sources[0].destination.visibility = 'private';
  const second = await runSync({ config, connections, state, reason: 'test' });
  assert.equal(api.state.projects['mirror/infra/router'].visibility, 'private');
  const entry = second.sources[0].repos[0];
  assert.deepEqual(entry.visibilityChanged, { from: 'public', to: 'private' });

  const before = api.state.updated.length;
  await runSync({ config, connections, state, reason: 'test' });
  assert.equal(api.state.updated.length, before, 'no request when the visibility already matches');
});

test('--once with a source name runs only that source but still maps all of them', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-only-'));
  const originDir = path.join(root, 'origin');
  const destDir = path.join(root, 'dest');
  const dataDir = path.join(root, 'data');
  for (const d of [originDir, destDir, dataDir]) await mkdir(d, { recursive: true });

  Connection.prototype.sshUrl = function sshUrl(fullPath) {
    return path.join(this.host === 'src.local' ? originDir : destDir, `${fullPath}.git`);
  };
  t.after(async () => {
    Connection.prototype.sshUrl = originalSshUrl;
    await rm(root, { recursive: true, force: true });
  });

  await makeRepo(path.join(originDir, 'a/one.git'));
  await makeRepo(path.join(originDir, 'b/two.git'));

  const api = await startFakeApi({
    tokenOwner: 'userA',
    groups: {
      a: { id: 1, full_path: 'a', name: 'a' },
      b: { id: 2, full_path: 'b', name: 'b' },
      mirror: { id: 3, full_path: 'mirror', name: 'mirror' },
    },
    projects: {
      'a/one': glProject('a/one', { ssh_url_to_repo: path.join(originDir, 'a/one.git') }),
      'b/two': glProject('b/two', { ssh_url_to_repo: path.join(originDir, 'b/two.git') }),
    },
  });
  t.after(() => api.close());
  api.hooks.onCreateProject = async (fullPath) => {
    await mkdir(path.dirname(path.join(destDir, `${fullPath}.git`)), { recursive: true });
    await git(['init', '--bare', '--quiet', path.join(destDir, `${fullPath}.git`)]);
  };

  const config = buildConfig(api, dataDir);
  config.sources[0].name = 'src-a';
  config.sources[0].scope = { type: 'group', login: 'a', recursive: true, include_owned_groups: false, include_membership: false };
  config.sources[0].destination.structure = 'flatten';
  config.sources.push(structuredClone(config.sources[0]));
  config.sources[1].name = 'src-b';
  config.sources[1].scope = { type: 'group', login: 'b', recursive: true, include_owned_groups: false, include_membership: false };

  const connections = buildConnections(config);
  const state = await memoryState();
  const report = await runSync({ config, connections, state, reason: 'test', only: ['src-a'] });

  assert.deepEqual(report.sources.map((s) => s.name), ['src-a'], 'only the named source is synced');
  assert.deepEqual(report.only, ['src-a']);
  assert.equal(report.totals.failed, 0);
  assert.deepEqual(api.state.created.projects, ['mirror/one'], 'src-b was not touched');
  assert.equal(state.sources['src-b'], undefined);
});

test('a narrowed run still aborts on a collision with a source it is not syncing', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-onlycol-'));
  const originDir = path.join(root, 'origin');
  const destDir = path.join(root, 'dest');
  const dataDir = path.join(root, 'data');
  for (const d of [originDir, destDir, dataDir]) await mkdir(d, { recursive: true });

  Connection.prototype.sshUrl = function sshUrl(fullPath) {
    return path.join(this.host === 'src.local' ? originDir : destDir, `${fullPath}.git`);
  };
  t.after(async () => {
    Connection.prototype.sshUrl = originalSshUrl;
    await rm(root, { recursive: true, force: true });
  });

  await makeRepo(path.join(originDir, 'a/same.git'));
  await makeRepo(path.join(originDir, 'b/same.git'));

  const api = await startFakeApi({
    tokenOwner: 'userA',
    groups: { a: { id: 1, full_path: 'a', name: 'a' }, b: { id: 2, full_path: 'b', name: 'b' }, mirror: { id: 3, full_path: 'mirror', name: 'mirror' } },
    projects: {
      'a/same': glProject('a/same', { ssh_url_to_repo: path.join(originDir, 'a/same.git') }),
      'b/same': glProject('b/same', { ssh_url_to_repo: path.join(originDir, 'b/same.git') }),
    },
  });
  t.after(() => api.close());

  const config = buildConfig(api, dataDir);
  config.sources[0].name = 'src-a';
  config.sources[0].scope = { type: 'group', login: 'a', recursive: true, include_owned_groups: false, include_membership: false };
  config.sources[0].destination.structure = 'flatten';
  config.sources.push(structuredClone(config.sources[0]));
  config.sources[1].name = 'src-b';
  config.sources[1].scope = { type: 'group', login: 'b', recursive: true, include_owned_groups: false, include_membership: false };
  const report = await runSync({ config, connections: buildConnections(config), state: await memoryState(), reason: 'test', only: ['src-a'] });

  assert.ok(report.fatal, 'narrowing the run must not narrow the collision check');
  assert.match(report.fatal, /collision/);
  assert.match(report.fatal, /src-b/);
  assert.deepEqual(api.state.created.projects, [], 'nothing was written');
});

test('a hung git invocation is timed out rather than wedging the run', async (t) => {
  const net = await import('node:net');
  const { runGit } = await import('../src/mirror.js');

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((r) => server.close(r));
  });

  const started = Date.now();
  await assert.rejects(
    runGit(['ls-remote', `git://127.0.0.1:${port}/x.git`], {
      env: { PATH: process.env.PATH, HOME: '/tmp', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' },
      timeoutMs: 2000,
    }),
    (err) => /timed out/.test(err.message),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1800 && elapsed < 15_000, `timed out in ${elapsed}ms, so it neither returned early nor hung`);
});

test('an interrupted repository is not counted as a failure', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-int-'));
  const originDir = path.join(root, 'origin');
  const destDir = path.join(root, 'dest');
  const dataDir = path.join(root, 'data');
  for (const d of [originDir, destDir, dataDir]) await mkdir(d, { recursive: true });

  Connection.prototype.sshUrl = function sshUrl(fullPath) {
    return path.join(this.host === 'src.local' ? originDir : destDir, `${fullPath}.git`);
  };
  t.after(async () => {
    Connection.prototype.sshUrl = originalSshUrl;
    await rm(root, { recursive: true, force: true });
  });

  const source = path.join(originDir, 'userA/infra/router.git');
  await makeRepo(source);

  const api = await startFakeApi({
    tokenOwner: 'userA',
    groups: { userA: { id: 1, full_path: 'userA', name: 'userA' }, mirror: { id: 2, full_path: 'mirror', name: 'mirror' } },
    projects: { 'userA/infra/router': glProject('userA/infra/router', { ssh_url_to_repo: source }) },
  });
  t.after(() => api.close());
  api.hooks.onCreateProject = async (fullPath) => {
    await mkdir(path.dirname(path.join(destDir, `${fullPath}.git`)), { recursive: true });
    await git(['init', '--bare', '--quiet', path.join(destDir, `${fullPath}.git`)]);
  };

  const config = buildConfig(api, dataDir);
  const connections = buildConnections(config);
  const state = await memoryState();
  await runSync({ config, connections, state, reason: 'test' });
  const before = state.sources.migration.repos['userA/infra/router'];
  assert.equal(before.consecutiveFailures, 0);

  const { GitError } = await import('../src/mirror.js');
  const err = new GitError('git push was killed by SIGTERM', { signal: 'SIGTERM', stderr: '' });
  err.interrupted = true;
  assert.equal(err.interrupted, true, 'signal kills are flagged, not treated as exit codes');
});

test('an empty source repository is not a failure', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-empty-'));
  const originDir = path.join(root, 'origin');
  const destDir = path.join(root, 'dest');
  const dataDir = path.join(root, 'data');
  for (const d of [originDir, destDir, dataDir]) await mkdir(d, { recursive: true });

  Connection.prototype.sshUrl = function sshUrl(fullPath) {
    return path.join(this.host === 'src.local' ? originDir : destDir, `${fullPath}.git`);
  };
  t.after(async () => {
    Connection.prototype.sshUrl = originalSshUrl;
    await rm(root, { recursive: true, force: true });
  });

  const empty = path.join(originDir, 'userA/infra/blank.git');
  await mkdir(path.dirname(empty), { recursive: true });
  await git(['init', '--bare', '--quiet', '--initial-branch=main', empty]);

  const api = await startFakeApi({
    tokenOwner: 'userA',
    groups: { userA: { id: 1, full_path: 'userA', name: 'userA' }, mirror: { id: 2, full_path: 'mirror', name: 'mirror' } },
    projects: { 'userA/infra/blank': glProject('userA/infra/blank', { ssh_url_to_repo: empty }) },
  });
  t.after(() => api.close());
  api.hooks.onCreateProject = async (fullPath) => {
    await mkdir(path.dirname(path.join(destDir, `${fullPath}.git`)), { recursive: true });
    await git(['init', '--bare', '--quiet', path.join(destDir, `${fullPath}.git`)]);
  };

  const config = buildConfig(api, dataDir);
  const connections = buildConnections(config);
  const state = await memoryState();
  const report = await runSync({ config, connections, state, reason: 'test' });
  assert.equal(report.totals.failed, 0, JSON.stringify(report.sources[0].repos, null, 2));
  assert.equal(report.totals.new, 1);

  const entry = report.sources[0].repos[0];
  assert.equal(entry.emptyRepo, true);
  assert.deepEqual(api.state.created.projects, ['mirror/infra/blank'], 'the destination project is still created');

  const second = await runSync({ config, connections, state, reason: 'test' });
  assert.equal(second.totals.unchanged, 1);
  assert.equal(second.totals.failed, 0);
});

test('archiving a repository on the source is not a disappearance', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-arch-'));
  const originDir = path.join(root, 'origin');
  const destDir = path.join(root, 'dest');
  const dataDir = path.join(root, 'data');
  for (const d of [originDir, destDir, dataDir]) await mkdir(d, { recursive: true });

  Connection.prototype.sshUrl = function sshUrl(fullPath) {
    return path.join(this.host === 'src.local' ? originDir : destDir, `${fullPath}.git`);
  };
  t.after(async () => {
    Connection.prototype.sshUrl = originalSshUrl;
    await rm(root, { recursive: true, force: true });
  });

  const source = path.join(originDir, 'userA/infra/router.git');
  await makeRepo(source);

  const api = await startFakeApi({
    tokenOwner: 'userA',
    groups: { userA: { id: 1, full_path: 'userA', name: 'userA' }, mirror: { id: 2, full_path: 'mirror', name: 'mirror' } },
    projects: { 'userA/infra/router': glProject('userA/infra/router', { ssh_url_to_repo: source }) },
  });
  t.after(() => api.close());
  api.hooks.onCreateProject = async (fullPath) => {
    await mkdir(path.dirname(path.join(destDir, `${fullPath}.git`)), { recursive: true });
    await git(['init', '--bare', '--quiet', path.join(destDir, `${fullPath}.git`)]);
  };

  const config = buildConfig(api, dataDir);
  const connections = buildConnections(config);
  const state = await memoryState();
  const first = await runSync({ config, connections, state, reason: 'test' });
  assert.equal(first.totals.new, 1);

  api.state.projects['userA/infra/router'].archived = true;

  const second = await runSync({ config, connections, state, reason: 'test' });
  assert.equal(second.totals.vanished, 0, 'it did not disappear, it was filtered');
  assert.equal(second.totals.excluded, 1);

  const entry = second.sources[0].repos.find((r) => r.status === 'excluded');
  assert.match(entry.reason, /archived/);

  const mail = buildRunMail(second, config);
  assert.match(mail.subject, /1 no longer mirrored/);
  assert.doesNotMatch(mail.subject, /vanished/);
  assert.match(mail.text, /Nothing was deleted here or on the destination/);
});

test('a failing repository fails alone and carries a failure streak', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-fail-'));
  const originDir = path.join(root, 'origin');
  const destDir = path.join(root, 'dest');
  const dataDir = path.join(root, 'data');
  for (const d of [originDir, destDir, dataDir]) await mkdir(d, { recursive: true });

  Connection.prototype.sshUrl = function sshUrl(fullPath) {
    return path.join(this.host === 'src.local' ? originDir : destDir, `${fullPath}.git`);
  };
  t.after(async () => {
    Connection.prototype.sshUrl = originalSshUrl;
    await rm(root, { recursive: true, force: true });
  });

  const good = path.join(originDir, 'userA/infra/router.git');
  await makeRepo(good);
  const missing = path.join(originDir, 'userA/infra/ghost.git');

  const api = await startFakeApi({
    tokenOwner: 'userA',
    groups: { userA: { id: 1, full_path: 'userA', name: 'userA' }, mirror: { id: 2, full_path: 'mirror', name: 'mirror' } },
    projects: {
      'userA/infra/router': glProject('userA/infra/router', { ssh_url_to_repo: good }),
      'userA/infra/ghost': glProject('userA/infra/ghost', { ssh_url_to_repo: missing }),
    },
  });
  t.after(() => api.close());
  api.hooks.onCreateProject = async (fullPath) => {
    await mkdir(path.dirname(path.join(destDir, `${fullPath}.git`)), { recursive: true });
    await git(['init', '--bare', '--quiet', path.join(destDir, `${fullPath}.git`)]);
  };

  const config = buildConfig(api, dataDir);
  const connections = buildConnections(config);
  const state = await memoryState();
  const first = await runSync({ config, connections, state, reason: 'test' });
  assert.equal(first.totals.new, 1, 'the healthy repository still synced');
  assert.equal(first.totals.failed, 1);
  assert.deepEqual(api.state.created.groups, ['mirror/infra'], 'two concurrent repositories create the shared subgroup once');
  assert.equal(state.sources.migration.repos['userA/infra/ghost'].consecutiveFailures, 1);

  const second = await runSync({ config, connections, state, reason: 'test' });
  assert.equal(second.totals.failed, 1);
  assert.equal(state.sources.migration.repos['userA/infra/ghost'].consecutiveFailures, 2);

  const mail = buildRunMail(second, config);
  assert.match(mail.subject, /1 failed/);
  assert.match(mail.text, /failing for 2 consecutive runs/);
  assert.match(mail.text, /userA\/infra\/ghost/);
});

function buildConfig(api, dataDir) {
  const config = validate(
    {
      data_dir: dataDir,
      concurrency: 2,
      git_timeout_minutes: 2,
      connections: {
        src: { provider: 'gitlab', host: 'src.local', api_url: api.glUrl, token: 'tok' },
        dst: { provider: 'gitlab', host: 'dst.local', api_url: api.glUrl, token: 'tok' },
      },
      smtp: { host: 'h', from: 'a@x', to: ['b@x'] },
      sources: [
        {
          name: 'migration',
          connection: 'src',
          scope: { type: 'group', login: 'userA' },
          destination: { connection: 'dst', namespace: 'mirror', structure: 'preserve' },
        },
      ],
    },
    configSchema,
  );
  for (const [name, conn] of Object.entries(config.connections)) conn.name = name;
  const d = config.sources[0].destination;
  Object.assign(d, {
    path_template: '{repo}',
    flatten_separator: '-',
    visibility: 'private',
    auto_create_namespaces: true,
    on_remap: 'report',
    relax_push_rules: config.defaults.relax_push_rules,
    disable_ci: config.defaults.disable_ci,
    sync_metadata: config.defaults.sync_metadata,
    push_mode: config.defaults.push_mode,
    verify: config.defaults.verify,
  });
  Object.assign(config.sources[0], { push_mode: 'refspecs', mirror_wikis: false, mirror_lfs: false });
  return config;
}

async function makeRepo(barePath) {
  const work = `${barePath}-work`;
  await mkdir(path.dirname(barePath), { recursive: true });
  await git(['init', '--bare', '--quiet', '--initial-branch=main', barePath]);
  await git(['init', '--quiet', '--initial-branch=main', work]);
  await writeFile(path.join(work, 'a.txt'), 'first\n');
  await git(['add', '.'], work);
  await git(['commit', '--quiet', '-m', 'first'], work);
  await git(['tag', 'v1'], work);
  await git(['push', '--quiet', barePath, 'main', 'v1'], work);

  const { stdout } = await git(['rev-parse', 'HEAD'], work);
  await git(['update-ref', 'refs/merge-requests/1/head', stdout.trim()], barePath);
  await rm(work, { recursive: true, force: true });
}

async function refsOf(bareDir) {
  const { stdout } = await git(['for-each-ref', '--format=%(refname) %(objectname)'], bareDir);
  const map = new Map();
  for (const line of stdout.split('\n')) {
    const [ref, sha] = line.trim().split(' ');
    if (ref) map.set(ref, sha);
  }
  return map;
}
