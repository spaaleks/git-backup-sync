import test from 'node:test';
import assert from 'node:assert/strict';

import { startFakeApi, glProject, ghRepo } from './fake-api.js';
import { validate, configSchema } from '../src/config/schema.js';
import { buildConnections } from '../src/connections.js';
import { enumerateAll, resolveAll, preflight } from '../src/run.js';
import { NamespaceResolver } from '../src/namespaces.js';

async function setup(fixture, buildDoc) {
  const api = await startFakeApi(fixture);
  const doc = buildDoc(api);
  const config = validate(doc, configSchema);
  for (const [name, conn] of Object.entries(config.connections)) conn.name = name;
  for (const source of config.sources) {
    const d = source.destination;
    d.structure ??= 'preserve';
    d.path_template ??= '{repo}';
    d.flatten_separator ??= '-';
    d.visibility ??= 'private';
    d.auto_create_namespaces ??= true;
    d.on_remap ??= 'report';
  }
  const connections = buildConnections(config);
  return { api, config, connections };
}

function glConn(api, over = {}) {
  return { provider: 'gitlab', host: 'gitlab.example.com', api_url: api.glUrl, token: 'tok', ...over };
}
function ghConn(api, over = {}) {
  return { provider: 'github', host: 'github.com', api_url: api.ghUrl, token: 'tok', ...over };
}
const SMTP = { host: 'h', from: 'a@x', to: ['b@x'], enabled: false };

async function runPreflight({ config, connections }) {
  const enumerated = await enumerateAll(config, connections);
  const { mappings } = resolveAll(enumerated);
  const pf = await preflight({ config, connections, enumerated, mappings, dryRun: true });
  return { enumerated, mappings, pf };
}

test('a project whose repository feature is off is skipped, not cloned and failed', async (t) => {
  const { api, config, connections } = await setup(
    {
      tokenOwner: 'userA',
      groups: { acme: { id: 1, full_path: 'acme', name: 'acme' }, mirror: { id: 2, full_path: 'mirror', name: 'mirror' } },
      projects: {
        'acme/normal': glProject('acme/normal', { repository_access_level: 'enabled' }),
        'acme/no-repo': glProject('acme/no-repo', { repository_access_level: 'disabled' }),
        'acme/guest-only': glProject('acme/guest-only', { permissions: { group_access: { access_level: 10 } } }),
      },
    },
    (api) => ({
      data_dir: '/tmp/x',
      connections: { src: glConn(api), dst: glConn(api) },
      smtp: SMTP,
      sources: [
        { name: 'acme', connection: 'src', scope: { type: 'group', login: 'acme' }, destination: { connection: 'dst', namespace: 'mirror', structure: 'flatten' } },
      ],
    }),
  );
  t.after(() => api.close());

  const { enumerated, mappings } = await runPreflight({ config, connections });

  assert.deepEqual(mappings.map((m) => m.repo.fullPath), ['acme/normal'], 'only the clonable one is mapped');

  const skipped = enumerated[0].filtered.filter((f) => f.kind === 'unreadable');
  assert.equal(skipped.length, 2);
  assert.match(skipped.find((f) => f.repo.repo === 'no-repo').reason, /repository feature is disabled/);
  assert.match(skipped.find((f) => f.repo.repo === 'guest-only').reason, /access level 10.*below Reporter/);
});

test('a missing or over-permissive ssh key fails pre-flight with a usable message', async (t) => {
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;

  const dir = await mkdtemp(path.join(tmpdir(), 'gbs-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const loose = path.join(dir, 'loose');
  await writeFile(loose, 'not really a key');
  await chmod(loose, 0o644);

  const tight = path.join(dir, 'tight');
  await writeFile(tight, 'not really a key');
  await chmod(tight, 0o400);

  const { checkSshKey } = await import('../src/connections.js');

  const missing = await checkSshKey({ sshKey: path.join(dir, 'nope') });
  assert.equal(missing.ok, false);
  assert.match(missing.problem, /does not exist/);
  assert.match(missing.problem, /mounted into the container/);

  const tooOpen = await checkSshKey({ sshKey: loose });
  assert.equal(tooOpen.ok, false);
  assert.match(tooOpen.problem, /0644/);
  assert.match(tooOpen.problem, /chmod 400/);

  assert.equal((await checkSshKey({ sshKey: tight })).ok, true);
  assert.equal((await checkSshKey({ sshKey: null })).ok, true, 'no key configured is not a problem');
});

test('criterion 2: two sources resolving to one destination path abort pre-flight', async (t) => {
  const { api, config, connections } = await setup(
    {
      tokenOwner: 'userA',
      groups: { mirror: { id: 5, full_path: 'mirror', name: 'mirror' }, orgA: { id: 6, full_path: 'orgA', name: 'orgA' } },
      projects: { 'userA/utils': glProject('userA/utils'), 'orgA/utils': glProject('orgA/utils') },
    },
    (api) => ({
      data_dir: '/tmp/x',
      connections: { src: glConn(api), dst: glConn(api) },
      smtp: SMTP,
      sources: [
        { name: 'personal', connection: 'src', scope: { type: 'user', login: 'userA' }, destination: { connection: 'dst', namespace: 'mirror', structure: 'flatten' } },
        { name: 'org', connection: 'src', scope: { type: 'group', login: 'orgA' }, destination: { connection: 'dst', namespace: 'mirror', structure: 'flatten' } },
      ],
    }),
  );
  t.after(() => api.close());

  const { pf } = await runPreflight({ config, connections });
  assert.equal(pf.collisions.length, 1);
  assert.equal(pf.fatal.length, 1);
  assert.match(pf.fatal[0], /collision/);
  assert.match(pf.fatal[0], /userA\/utils/);
  assert.match(pf.fatal[0], /orgA\/utils/);
  assert.match(pf.fatal[0], /path_template/, 'the message suggests the fix');
  assert.deepEqual(api.state.created, { groups: [], projects: [] }, 'nothing was written');
});

test('criterion 3: a destination resolving to its own source path aborts pre-flight', async (t) => {
  const { api, config, connections } = await setup(
    {
      tokenOwner: 'userA',
      groups: { mirror: { id: 5, full_path: 'mirror', name: 'mirror' } },
      projects: { 'mirror/router': glProject('mirror/router') },
    },
    (api) => ({
      data_dir: '/tmp/x',
      connections: { src: glConn(api), dst: glConn(api) },
      smtp: SMTP,
      sources: [
        { name: 'loop', connection: 'src', scope: { type: 'group', login: 'mirror' }, destination: { connection: 'dst', namespace: 'mirror', structure: 'preserve' } },
      ],
    }),
  );
  t.after(() => api.close());

  const { pf } = await runPreflight({ config, connections });
  assert.equal(pf.selfMirrors.length, 1);
  assert.ok(pf.fatal.some((f) => /same host/.test(f) || /catastrophic/.test(f)));
});

test('criterion 4: preserve into a personal namespace is rejected, naming the subgroup limitation', async (t) => {
  const { api, config, connections } = await setup(
    {
      tokenOwner: 'userB',
      users: { userB: { id: 1 } },
      groups: { userA: { id: 7, full_path: 'userA', name: 'userA' } },
      projects: { 'userA/infra/router': glProject('userA/infra/router') },
    },
    (api) => ({
      data_dir: '/tmp/x',
      connections: { src: glConn(api), dst: glConn(api) },
      smtp: SMTP,
      sources: [
        { name: 'nested', connection: 'src', scope: { type: 'group', login: 'userA' }, destination: { connection: 'dst', namespace: 'userB', structure: 'preserve' } },
      ],
    }),
  );
  t.after(() => api.close());

  const { pf } = await runPreflight({ config, connections });
  const messages = pf.sourceErrors.get('nested') ?? [];
  assert.ok(messages.length > 0, 'the source is rejected');
  assert.match(messages[0], /personal namespace/);
  assert.match(messages[0], /cannot contain subgroups/);
  assert.match(messages[0], /flatten.*template/);
  assert.deepEqual(api.state.created, { groups: [], projects: [] }, 'nothing was written');
});

test('criterion 6: only the segments below an existing root are created', async (t) => {
  const api = await startFakeApi({
    tokenOwner: 'userA',
    groups: { 'userA-mirror': { id: 9, full_path: 'userA-mirror', name: 'userA-mirror' } },
  });
  t.after(() => api.close());

  const connections = buildConnections(
    validate(
      { connections: { dst: glConn(api) }, smtp: SMTP, sources: [{ name: 's', connection: 'dst', scope: { type: 'self' }, destination: { connection: 'dst', namespace: 'x' } }] },
      configSchema,
    ),
  );
  const resolver = new NamespaceResolver(connections.dst);

  const result = await resolver.ensure('userA-mirror', ['infra', 'network'], { visibility: 'private', autoCreate: true });
  assert.deepEqual(result.created, ['userA-mirror/infra', 'userA-mirror/infra/network']);
  assert.deepEqual(api.state.created.groups, ['userA-mirror/infra', 'userA-mirror/infra/network']);

  const before = api.state.created.groups.length;
  await resolver.ensure('userA-mirror', ['infra', 'network'], { visibility: 'private', autoCreate: true });
  assert.equal(api.state.created.groups.length, before, 'the resolver cache prevents duplicate creates');
});

test('criterion 6b: a missing root namespace is refused rather than created', async (t) => {
  const api = await startFakeApi({ tokenOwner: 'userA', groups: {} });
  t.after(() => api.close());

  const connections = buildConnections(
    validate(
      { connections: { dst: glConn(api) }, smtp: SMTP, sources: [{ name: 's', connection: 'dst', scope: { type: 'self' }, destination: { connection: 'dst', namespace: 'x' } }] },
      configSchema,
    ),
  );
  const resolver = new NamespaceResolver(connections.dst);
  await assert.rejects(
    resolver.ensure('typo-mirror', ['infra'], { visibility: 'private', autoCreate: true }),
    /create_root_namespace/,
  );
  assert.deepEqual(api.state.created.groups, [], 'a typo does not leave a stray top-level group behind');
});

test('create_root_namespace makes the top-level group, once, even under concurrency', async (t) => {
  const api = await startFakeApi({ tokenOwner: 'userA', groups: {} });
  t.after(() => api.close());

  const connections = buildConnections(
    validate(
      { connections: { dst: glConn(api) }, smtp: SMTP, sources: [{ name: 's', connection: 'dst', scope: { type: 'self' }, destination: { connection: 'dst', namespace: 'x' } }] },
      configSchema,
    ),
  );
  const resolver = new NamespaceResolver(connections.dst);
  const opts = { visibility: 'private', autoCreate: true, createRoot: true };

  const results = await Promise.all([
    resolver.ensure('mirror-root', ['alpha'], opts),
    resolver.ensure('mirror-root', ['beta', 'one'], opts),
    resolver.ensure('mirror-root', ['beta', 'two'], opts),
  ]);

  assert.deepEqual(
    api.state.created.groups.filter((g) => g === 'mirror-root'),
    ['mirror-root'],
    'the root is created exactly once',
  );
  assert.deepEqual(api.state.created.groups.sort(), [
    'mirror-root',
    'mirror-root/alpha',
    'mirror-root/beta',
    'mirror-root/beta/one',
    'mirror-root/beta/two',
  ]);
  for (const r of results) assert.ok(r.id, 'every caller gets a usable namespace id');
});

test('criterion 7: userA + orgA into one namespace with distinct templates does not collide', async (t) => {
  const { api, config, connections } = await setup(
    {
      tokenOwner: 'userA',
      users: { userB: { id: 2 } },
      ghRepos: { 'userA/utils': ghRepo('userA/utils'), 'acme-corp/utils': ghRepo('acme-corp/utils') },
    },
    (api) => ({
      data_dir: '/tmp/x',
      connections: { gh: ghConn(api), dst: glConn(api) },
      smtp: SMTP,
      sources: [
        { name: 'gh-me', connection: 'gh', scope: { type: 'user', login: 'userA' }, destination: { connection: 'dst', namespace: 'userB', structure: 'flatten' } },
        { name: 'gh-acme', connection: 'gh', scope: { type: 'org', login: 'acme-corp' }, destination: { connection: 'dst', namespace: 'userB', structure: 'template', path_template: 'acme-{repo}' } },
      ],
    }),
  );
  t.after(() => api.close());

  const { mappings, pf } = await runPreflight({ config, connections });
  assert.deepEqual(
    mappings.map((m) => m.path).sort(),
    ['userB/acme-utils', 'userB/utils'],
  );
  assert.equal(pf.collisions.length, 0);
  assert.equal(pf.fatal.length, 0);
});

test('a GitLab user scope with include_owned_groups walks the whole tree', async (t) => {
  const { api, config, connections } = await setup(
    {
      tokenOwner: 'userA',
      groups: {
        'userA-mirror': { id: 9, full_path: 'userA-mirror', name: 'userA-mirror' },
        acme: { id: 10, full_path: 'acme', name: 'acme' },
        'acme/infra': { id: 11, full_path: 'acme/infra', name: 'infra' },
      },
      projects: {
        'userA/personal-tool': glProject('userA/personal-tool'),
        'acme/infra/router': glProject('acme/infra/router'),
      },
    },
    (api) => ({
      data_dir: '/tmp/x',
      connections: { src: glConn(api), dst: glConn(api) },
      smtp: SMTP,
      sources: [
        {
          name: 'migration',
          connection: 'src',
          scope: { type: 'user', login: 'userA', include_owned_groups: true },
          destination: { connection: 'dst', namespace: 'userA-mirror', structure: 'preserve' },
        },
      ],
    }),
  );
  t.after(() => api.close());

  const { mappings } = await runPreflight({ config, connections });
  const paths = mappings.map((m) => m.path).sort();
  assert.deepEqual(paths, ['userA-mirror/acme/infra/router', 'userA-mirror/personal-tool']);
});
