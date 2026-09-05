
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { validate, configSchema } from '../src/config/schema.js';
import { buildConnections } from '../src/connections.js';
import { runSync } from '../src/run.js';
import { memoryState, openState } from '../src/state.js';
import { setLevel } from '../src/logger.js';
import { parseGitUrl } from '../src/providers/git.js';

const derived = (url) => parseGitUrl(url).fullPath;

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

async function makeRepo(barePath, file = 'a.txt') {
  const work = `${barePath}-work`;
  await mkdir(path.dirname(barePath), { recursive: true });
  await git(['init', '--bare', '--quiet', '--initial-branch=main', barePath]);
  await git(['init', '--quiet', '--initial-branch=main', work]);
  await writeFile(path.join(work, file), 'hello\n');
  await git(['add', '.'], work);
  await git(['commit', '--quiet', '-m', 'first'], work);
  await git(['tag', 'v1'], work);
  await git(['push', '--quiet', barePath, 'main', 'v1'], work);
  await rm(work, { recursive: true, force: true });
}

function buildConfig({ dataDir, out, urls, format }) {
  const config = validate(
    {
      data_dir: dataDir,
      concurrency: 2,
      git_timeout_minutes: 2,
      connections: { anon: { provider: 'git' } },
      smtp: { enabled: false },
      sources: [
        {
          name: 'links',
          connection: 'anon',
          scope: { type: 'urls', urls },
          destination: { type: 'directory', path: out, format, structure: 'preserve' },
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
  config.sources[0].batch_pause_seconds = 0;
  return config;
}

test('a url list with no credentials mirrors into bare repositories', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-dir-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const src = path.join(root, 'origin/acme/infra/router.git');
  await makeRepo(src);
  const out = path.join(root, 'backup');

  const config = buildConfig({ dataDir: path.join(root, 'data'), out, urls: [src], format: 'bare' });
  const report = await runSync({ config, connections: buildConnections(config), state: await memoryState(), reason: 'test' });

  assert.equal(report.totals.failed, 0, JSON.stringify(report.sources[0].repos, null, 2));
  assert.equal(report.totals.new, 1);

  const target = path.join(out, `${derived(src)}.git`);
  assert.ok((await stat(path.join(target, 'HEAD'))).isFile(), 'a bare repository was created');

  const { stdout } = await git(['for-each-ref', '--format=%(refname)'], target);
  assert.match(stdout, /refs\/heads\/main/);
  assert.match(stdout, /refs\/tags\/v1/);

  const restored = path.join(root, 'restored');
  await git(['clone', '--quiet', target, restored]);
  assert.equal(await readFile(path.join(restored, 'a.txt'), 'utf8'), 'hello\n');

  const second = await runSync({ config, connections: buildConnections(config), state: await memoryState(), reason: 'test' });
  assert.equal(second.totals.failed, 0);
});

test('the state store on disk survives a restart', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const src = path.join(root, 'origin/acme/infra/router.git');
  await makeRepo(src);
  const dataDir = path.join(root, 'data');
  const config = buildConfig({ dataDir, out: path.join(root, 'backup'), urls: [src], format: 'bare' });
  const database = { driver: 'sqlite', path: path.join(dataDir, 'nested', 'state.db') };

  const first = await openState(database);
  const report = await runSync({ config, connections: buildConnections(config), state: first, reason: 'test' });
  assert.equal(report.totals.new, 1, JSON.stringify(report.sources[0].repos, null, 2));
  await first.close();

  const reopened = await openState(database);
  const record = reopened.sources.links.repos[derived(src)];
  assert.ok(record, 'the repository was committed as it finished, not at the end of the run');
  assert.equal(record.consecutiveFailures, 0);
  assert.equal(Object.keys(record.refs).length, 2);
  assert.equal(reopened.runs.length, 1);
  assert.equal(reopened.sources.links.connection, 'anon');

  const second = await runSync({ config, connections: buildConnections(config), state: reopened, reason: 'test' });
  assert.equal(second.totals.unchanged, 1, 'the reopened store is recognised, not treated as a first run');
  await reopened.close();
});

test('a worktree destination leaves browsable files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-wt-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const src = path.join(root, 'origin/acme/tool.git');
  await makeRepo(src, 'README.md');
  const out = path.join(root, 'files');

  const config = buildConfig({ dataDir: path.join(root, 'data'), out, urls: [src], format: 'worktree' });
  const report = await runSync({ config, connections: buildConnections(config), state: await memoryState(), reason: 'test' });

  assert.equal(report.totals.failed, 0, JSON.stringify(report.sources[0].repos, null, 2));
  const checkout = path.join(out, derived(src));
  assert.equal(await readFile(path.join(checkout, 'README.md'), 'utf8'), 'hello\n', 'the files are just there');

  const again = await runSync({ config, connections: buildConnections(config), state: await memoryState(), reason: 'test' });
  assert.equal(again.totals.failed, 0);
});

test('an inline destination pins one repository to one path', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const a = path.join(root, 'origin/one.git');
  const b = path.join(root, 'origin/two.git');
  await makeRepo(a);
  await makeRepo(b);

  const out = path.join(root, 'backup');
  const urls = [a, { url: b, destination: 'renamed/elsewhere/two' }];
  const config = buildConfig({ dataDir: path.join(root, 'data'), out, urls, format: 'bare' });
  const report = await runSync({ config, connections: buildConnections(config), state: await memoryState(), reason: 'test' });

  assert.equal(report.totals.failed, 0, JSON.stringify(report.sources[0].repos, null, 2));
  assert.equal(report.totals.new, 2);
  assert.ok((await stat(path.join(out, `${derived(a)}.git`, 'HEAD'))).isFile(), 'unpinned keeps the source path');
  assert.ok((await stat(path.join(out, 'renamed/elsewhere/two.git/HEAD'))).isFile(), 'pinned went where it was told');
});

test('two urls pinned to the same target abort pre-flight', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-dup-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const a = path.join(root, 'origin/one.git');
  const b = path.join(root, 'origin/two.git');
  await makeRepo(a);
  await makeRepo(b);

  const out = path.join(root, 'backup');
  const config = buildConfig({
    dataDir: path.join(root, 'data'),
    out,
    urls: [
      { url: a, destination: 'same/place' },
      { url: b, destination: 'same/place' },
    ],
    format: 'bare',
  });
  const report = await runSync({ config, connections: buildConnections(config), state: await memoryState(), reason: 'test' });

  assert.ok(report.fatal, 'the collision check applies to folders too');
  assert.match(report.fatal, /collision/);
});
