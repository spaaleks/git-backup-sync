
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { startFakeApi, glProject } from './fake-api.js';
import { validate, configSchema } from '../src/config/schema.js';
import { loadConfig } from '../src/config/load.js';
import { Connection, buildConnections } from '../src/connections.js';
import { runSync } from '../src/run.js';
import { memoryState } from '../src/state.js';
import { resolveMapping } from '../src/mapping.js';
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

async function makeRepo(barePath) {
  const work = `${barePath}-work`;
  await mkdir(path.dirname(barePath), { recursive: true });
  await git(['init', '--bare', '--quiet', '--initial-branch=main', barePath]);
  await git(['init', '--quiet', '--initial-branch=main', work]);
  await writeFile(path.join(work, 'a.txt'), 'hello\n');
  await git(['add', '.'], work);
  await git(['commit', '--quiet', '-m', 'first'], work);
  await git(['tag', 'v1'], work);
  await git(['push', '--quiet', barePath, 'main', 'v1'], work);
  await rm(work, { recursive: true, force: true });
}

function destSource(over = {}) {
  return {
    name: 'gl',
    connection: 'src',
    rules: [],
    destination: {
      type: 'github',
      connection: 'dst',
      namespace: 'acme-org',
      structure: 'flatten',
      path_template: '{repo}',
      flatten_separator: '-',
      visibility: 'private',
      on_remap: 'report',
      disable_ci: true,
      sync_metadata: true,
      push_mode: 'refspecs',
      verify: 'push',
      ...over,
    },
  };
}

const glRepo = (over = {}) => ({
  source: 'gl',
  provider: 'gitlab',
  host: 'gitlab.example.com',
  fullPath: 'acme/infra/router',
  owner: 'infra',
  repo: 'router',
  relativePath: 'acme/infra',
  visibility: 'private',
  description: 'the router',
  topics: ['Networking'],
  defaultBranch: 'main',
  ...over,
});

test('mapping: GitHub cannot nest, so a nested source must flatten', () => {
  const flat = resolveMapping(glRepo(), destSource());
  assert.equal(flat.path, 'acme-org/acme-infra-router');
  assert.equal(flat.type, 'github');
  assert.deepEqual(flat.subgroups, []);

  const nested = resolveMapping(glRepo(), destSource({ structure: 'preserve' }));
  assert.ok(nested.error, 'preserve into GitHub is rejected');
  assert.match(nested.error, /cannot be nested/);
  assert.match(nested.error, /flatten.*template/);
});

test('config: a github destination is checked for the things GitHub lacks', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gbs-ghcfg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.yml');

  const doc = (dest) => `
connections:
  gl: {provider: gitlab, host: gitlab.example.com, token: t}
  gh: {provider: github, token: t}
sources:
  - name: s
    connection: gl
    scope: {type: group, login: acme}
    destination: {type: github, ${dest}}
`;

  await writeFile(file, doc('connection: gl, namespace: acme-org, structure: flatten'));
  await assert.rejects(loadConfig({ path: file, env: {} }), /a github destination needs a github connection/);

  await writeFile(file, doc('connection: gh, structure: flatten'));
  await assert.rejects(loadConfig({ path: file, env: {} }), /names the user or organisation/);

  await writeFile(file, doc('connection: gh, namespace: acme/team, structure: flatten'));
  await assert.rejects(loadConfig({ path: file, env: {} }), /GitHub has no nested namespaces/);

  await writeFile(file, doc('connection: gh, namespace: acme-org, structure: flatten, visibility: internal'));
  await assert.rejects(loadConfig({ path: file, env: {} }), /internal` is GitLab-only/);

  await writeFile(file, doc('connection: gh, namespace: acme-org, structure: flatten, create_root_namespace: true'));
  await assert.rejects(loadConfig({ path: file, env: {} }), /no meaning for `type: github`/);

  await writeFile(file, doc('connection: gh, namespace: acme-org, structure: flatten'));
  const config = await loadConfig({ path: file, env: {} });
  assert.equal(config.sources[0].destination.type, 'github');
});

test('a GitLab source mirrors into a GitHub organisation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gbs-gh-'));
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

  const source = path.join(originDir, 'acme/infra/router.git');
  await makeRepo(source);

  const api = await startFakeApi({
    tokenOwner: 'someone',
    ghOrgs: ['acme-org'],
    groups: { acme: { id: 1, full_path: 'acme', name: 'acme' } },
    projects: {
      'acme/infra/router': glProject('acme/infra/router', {
        ssh_url_to_repo: source,
        description: 'the router',
        topics: ['Networking'],
      }),
    },
  });
  t.after(() => api.close());
  api.hooks.onCreateProject = async (fullPath) => {
    await mkdir(path.dirname(path.join(destDir, `${fullPath}.git`)), { recursive: true });
    await git(['init', '--bare', '--quiet', path.join(destDir, `${fullPath}.git`)]);
  };

  const config = validate(
    {
      data_dir: dataDir,
      git_timeout_minutes: 2,
      connections: {
        src: { provider: 'gitlab', host: 'src.local', api_url: api.glUrl, token: 't' },
        dst: { provider: 'github', host: 'dst.local', api_url: api.ghUrl, token: 't' },
      },
      smtp: { enabled: false },
      sources: [
        {
          name: 'gl',
          connection: 'src',
          scope: { type: 'group', login: 'acme' },
          destination: { type: 'github', connection: 'dst', namespace: 'acme-org', structure: 'flatten' },
        },
      ],
    },
    configSchema,
  );
  for (const [name, conn] of Object.entries(config.connections)) conn.name = name;
  Object.assign(config.sources[0].destination, {
    path_template: '{repo}',
    flatten_separator: '-',
    visibility: 'private',
    on_remap: 'report',
    disable_ci: config.defaults.disable_ci,
    sync_metadata: config.defaults.sync_metadata,
    push_mode: config.defaults.push_mode,
    verify: config.defaults.verify,
  });
  config.sources[0].batch_pause_seconds = 0;
  const report = await runSync({ config, connections: buildConnections(config), state: await memoryState(), reason: 'test' });

  assert.equal(report.totals.failed, 0, JSON.stringify(report.sources[0].repos, null, 2));
  assert.equal(report.totals.new, 1);
  assert.deepEqual(api.state.created.projects, ['acme-org/infra-router']);

  const created = api.state.ghRepos['acme-org/infra-router'];
  assert.equal(created.private, true, 'private by default');
  assert.equal(created.description, 'the router', 'description copied');
  assert.equal(created.default_branch, 'main', 'default branch set after the push');
  assert.deepEqual(created.topics, ['networking'], 'topics lowercased, as GitHub requires');
  assert.equal(created.actions_enabled, false, 'Actions disabled so a mirrored workflow does not run');

  const { stdout } = await git(['for-each-ref', '--format=%(refname)'], path.join(destDir, 'acme-org/infra-router.git'));
  assert.match(stdout, /refs\/heads\/main/);
  assert.match(stdout, /refs\/tags\/v1/);

  const before = api.state.updated.length;
  const second = await runSync({ config, connections: buildConnections(config), state: await memoryState(), reason: 'test' });
  assert.equal(second.totals.failed, 0);
  assert.equal(api.state.updated.length, before, 'metadata already matches');
});

test('pre-flight refuses another user\'s account before writing anything', async (t) => {
  const api = await startFakeApi({ tokenOwner: 'someone', ghUsers: ['stranger'] });
  t.after(() => api.close());

  const githubDest = await import('../src/destinations/github.js');
  const connections = buildConnections(
    validate(
      {
        connections: { dst: { provider: 'github', host: 'github.com', api_url: api.ghUrl, token: 't' } },
        smtp: { enabled: false },
        sources: [{ name: 's', connection: 'dst', scope: { type: 'self' }, destination: { connection: 'dst', namespace: 'x' } }],
      },
      configSchema,
    ),
  );

  const stranger = await githubDest.check(connections.dst, 'stranger');
  assert.equal(stranger.ok, false);
  assert.match(stranger.reason, /personal account of another user/);

  const missing = await githubDest.check(connections.dst, 'nope-does-not-exist');
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /was not found/);

  assert.equal((await githubDest.check(connections.dst, 'someone')).ok, true, 'the token owner is fine');
});
