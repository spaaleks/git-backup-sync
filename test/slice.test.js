import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { planSeed, seedPush } from '../src/mirror.js';
import { validate, configSchema } from '../src/config/schema.js';
import { buildConnections } from '../src/connections.js';
import { runSync } from '../src/run.js';
import { memoryState } from '../src/state.js';
import { setLevel } from '../src/logger.js';
import { parseGitUrl } from '../src/providers/git.js';

const exec = promisify(execFile);
const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME || '/tmp',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@x',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@x',
  LC_ALL: 'C',
};
const git = (args, cwd) => exec('git', args, { cwd, env: GIT_ENV });

setLevel('error');

const context = (over = {}) => ({
  env: GIT_ENV,
  timeoutMs: 120_000,
  slice: { enabled: true, thresholdBytes: 1 },
  ...over,
});

async function makeRepo(barePath, { commits = 40, bytes = 0 } = {}) {
  const work = `${barePath}-work`;
  await mkdir(path.dirname(barePath), { recursive: true });
  await git(['init', '--bare', '--quiet', '--initial-branch=main', barePath]);
  await git(['init', '--quiet', '--initial-branch=main', work]);
  for (let i = 0; i < commits; i++) {
    await writeFile(path.join(work, 'a.txt'), `commit ${i}\n`);
    if (bytes) await writeFile(path.join(work, `blob-${i}.bin`), randomBytes(bytes));
    await git(['add', '.'], work);
    await git(['commit', '--quiet', '-m', `c${i}`], work);
  }
  await git(['push', '--quiet', barePath, 'main'], work);
  await rm(work, { recursive: true, force: true });
  return barePath;
}

const emptyBare = async (p) => {
  await git(['init', '--bare', '--quiet', '--initial-branch=main', p]);
  return p;
};
const tip = async (repo, ref = 'refs/heads/main') => (await git(['rev-parse', ref], repo)).stdout.trim();

test('a push under the threshold is not sliced', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-slice-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const src = await makeRepo(path.join(root, 'src.git'), { commits: 5 });
  const dest = await emptyBare(path.join(root, 'dest.git'));

  const plan = await planSeed(src, dest, context({ slice: { enabled: true, thresholdBytes: 1024 ** 3 } }));
  assert.equal(plan, null);
});

test('a large history is delivered in slices and each slice stays on the destination', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-slice-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const src = await makeRepo(path.join(root, 'src.git'), { commits: 40 });
  const dest = await emptyBare(path.join(root, 'dest.git'));

  const seeded = await seedPush(src, dest, context());
  assert.equal(seeded.commits, 40);
  assert.ok(seeded.slices > 1, `expected more than one slice, got ${seeded.slices}`);
  assert.equal(seeded.branch, 'refs/heads/main');
  assert.equal(await tip(dest), await tip(src));
});

test('seeding resumes from what the destination already has', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-slice-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const src = await makeRepo(path.join(root, 'src.git'), { commits: 40 });
  const dest = await emptyBare(path.join(root, 'dest.git'));

  const halfway = (await git(['rev-parse', 'main~20'], src)).stdout.trim();
  await git(['push', '--quiet', dest, `${halfway}:refs/heads/main`], src);

  const plan = await planSeed(src, dest, context());
  assert.equal(plan.revs.length, 20);

  const seeded = await seedPush(src, dest, context());
  assert.equal(seeded.commits, 20);
  assert.equal(await tip(dest), await tip(src));

  assert.equal(await planSeed(src, dest, context()), null);
});

test('a slice that cannot fit the timeout is halved, and one commit that still does not fit says so', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-slice-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const src = await makeRepo(path.join(root, 'src.git'), { commits: 40 });
  const dest = await emptyBare(path.join(root, 'dest.git'));
  const hook = path.join(dest, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });

  let halvings = 0;
  const log = { info() {}, warn() {}, debug: () => { halvings++; } };

  await assert.rejects(seedPush(src, dest, context({ timeoutMs: 1500, log })), (err) => {
    assert.match(err.message, /timed out/);
    assert.match(err.message, /git_timeout_minutes/);
    return true;
  });
  assert.ok(halvings >= 2, `expected the slice to be halved, got ${halvings}`);
});

test('a run slices a large first push and the backup still verifies', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-slice-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const src = await makeRepo(path.join(root, 'origin/acme/big.git'), { commits: 12, bytes: 200 * 1024 });
  const out = path.join(root, 'backup');

  const config = validate(
    {
      data_dir: path.join(root, 'data'),
      concurrency: 1,
      git_timeout_minutes: 2,
      slice_threshold_mb: 1,
      connections: { anon: { provider: 'git' } },
      smtp: { enabled: false },
      sources: [
        {
          name: 'links',
          connection: 'anon',
          scope: { type: 'urls', urls: [src] },
          destination: { type: 'directory', path: out, format: 'bare', structure: 'preserve' },
        },
      ],
    },
    configSchema,
  );
  for (const [name, conn] of Object.entries(config.connections)) conn.name = name;
  Object.assign(config.sources[0].destination, {
    path_template: '{repo}',
    flatten_separator: '-',
    on_remap: 'report',
    push_mode: 'refspecs',
    verify: 'push',
  });

  const report = await runSync({ config, connections: buildConnections(config), state: await memoryState(), reason: 'test' });
  const repo = report.sources[0].repos[0];

  assert.equal(report.totals.failed, 0, JSON.stringify(report.sources[0].repos, null, 2));
  assert.ok(repo.seeded, 'the push was sliced');
  assert.ok(repo.seeded.slices > 1, `expected more than one slice, got ${repo.seeded.slices}`);
  assert.ok(repo.verification.ok, 'the destination verified');

  const target = path.join(out, `${parseGitUrl(src).fullPath}.git`);
  assert.ok((await stat(path.join(target, 'HEAD'))).isFile());
  assert.equal(await tip(target), await tip(src));
});
