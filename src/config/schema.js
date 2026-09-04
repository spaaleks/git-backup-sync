import { S } from './validator.js';

export { S, validate, ValidationError } from './validator.js';

const CRON = S.string({
  nonEmpty: true,
  pattern: /^\s*\S+(\s+\S+){4}\s*$/,
  patternMessage: 'must be a 5-field cron expression, e.g. "0 3 * * *"',
});

const rule = S.object({
  match: S.string({ required: true, nonEmpty: true, regex: true }),
  skip: S.boolean(),
  namespace: S.string({ nonEmpty: true }),
  structure: S.string({ enum: ['preserve', 'flatten', 'template'] }),
  path_template: S.string({ nonEmpty: true }),
  flatten_separator: S.string({ nonEmpty: true }),
  path_prefix: S.string({ nonEmpty: true }),
  visibility: S.string({ enum: ['private', 'internal', 'public', 'original'] }),
});

const destination = S.object({
  type: S.string({ enum: ['gitlab', 'github', 'directory'], default: 'gitlab' }),
  connection: S.string({ nonEmpty: true }),
  path: S.string({ nonEmpty: true }),
  format: S.string({ enum: ['bare', 'worktree'], default: 'bare' }),
  namespace: S.string(),
  structure: S.string({ enum: ['preserve', 'flatten', 'template'] }),
  path_template: S.string({ nonEmpty: true }),
  flatten_separator: S.string({ nonEmpty: true }),
  path_prefix: S.string({ nonEmpty: true }),
  visibility: S.string({ enum: ['private', 'internal', 'public', 'original'] }),
  auto_create_namespaces: S.boolean(),
  create_root_namespace: S.boolean(),
  on_remap: S.string({ enum: ['report', 'archive', 'delete'] }),
  relax_push_rules: S.boolean(),
  disable_ci: S.boolean(),
  sync_metadata: S.boolean(),
  push_mode: S.string({ enum: ['refspecs', 'mirror'] }),
  verify: S.string({ enum: ['push', 'always', 'off'] }),
});

const urlEntry = S.object({
  url: S.string({ required: true, nonEmpty: true }),
  destination: S.string({ nonEmpty: true }),
  name: S.string({ nonEmpty: true }),
});

const scope = S.object({
  type: S.string({ required: true, enum: ['self', 'user', 'org', 'group', 'projects', 'repos', 'urls'] }),
  login: S.string({ nonEmpty: true }),
  recursive: S.boolean({ default: true }),
  include_owned_groups: S.boolean({ default: false }),
  include_membership: S.boolean({ default: false }),
  projects: S.array(S.string({ nonEmpty: true })),
  repos: S.array(S.string({ nonEmpty: true })),
  urls: S.array(S.union([S.string({ nonEmpty: true }), urlEntry])),
});

const PRIORITY = ['min', 'low', 'default', 'high', 'urgent'];

function ntfyBlock({ defaults }) {
  const d = (value) => (defaults ? { default: value } : {});
  return S.object({
    enabled: S.boolean(d(true)),
    url: S.string({ nonEmpty: true, ...d('https://ntfy.sh') }),
    topic: S.string({ nonEmpty: true }),
    token: S.string(),
    username: S.string(),
    password: S.string(),
    priority: S.string({ enum: PRIORITY, ...d('default') }),
    failure_priority: S.string({ enum: PRIORITY, ...d('high') }),
    tags: S.array(S.string({ nonEmpty: true })),
    failure_tags: S.array(S.string({ nonEmpty: true })),
    notify_on: S.array(S.string({ enum: ['changes', 'failures', 'always'] }), d(['changes', 'failures'])),
    retries: S.number({ integer: true, min: 0, max: 10, ...d(2) }),
    timeout_seconds: S.number({ min: 1, max: 120, ...d(15) }),
  });
}

function kumaBlock({ defaults }) {
  const d = (value) => (defaults ? { default: value } : {});
  return S.object({
    enabled: S.boolean(d(true)),
    url: S.string({ nonEmpty: true }),
    retries: S.number({ integer: true, min: 0, max: 10, ...d(2) }),
    timeout_seconds: S.number({ min: 1, max: 120, ...d(15) }),
  });
}

const source = S.object({
  name: S.string({ required: true, nonEmpty: true, pattern: /^[A-Za-z0-9._-]+$/, patternMessage: 'may contain only letters, digits, dot, dash and underscore (it is a state key)' }),
  connection: S.string({ required: true, nonEmpty: true }),
  enabled: S.boolean({ default: true }),
  scope: { ...scope, required: true },
  destination: { ...destination, required: true },
  rules: S.array(rule, { default: [] }),
  include: S.array(S.string({ regex: true }), { default: [] }),
  exclude: S.array(S.string({ regex: true }), { default: [] }),
  include_forks: S.boolean(),
  include_archived: S.boolean(),
  mirror_wikis: S.boolean(),
  mirror_lfs: S.boolean(),
  batch_pause_seconds: S.number({ min: 0, max: 3600 }),
  batch_pause_min_changes: S.number({ integer: true, min: 1, max: 100_000 }),
  ntfy: ntfyBlock({ defaults: false }),
  uptime_kuma: kumaBlock({ defaults: false }),
});

const connection = S.object({
  // `git` has no API: it only carries credentials for git itself, which is what
  // a source of plain clone URLs needs.
  provider: S.string({ required: true, enum: ['github', 'gitlab', 'git'] }),
  api_url: S.string({ nonEmpty: true }),
  host: S.string({ nonEmpty: true }),
  token: S.string({ nonEmpty: true }),
  ssh_key: S.string({ nonEmpty: true }),
  ssh_user: S.string({ nonEmpty: true, default: 'git' }),
  ssh_port: S.number({ integer: true, min: 1, max: 65535, default: 22 }),
  ssh_options: S.array(S.string({ nonEmpty: true }), { default: [] }),
  known_hosts: S.string({ nonEmpty: true }),
  strict_host_key_checking: S.boolean({ default: false }),
});

export const configSchema = S.object({
  data_dir: S.string({ default: '/data', nonEmpty: true }),
  concurrency: S.number({ integer: true, min: 1, max: 64, default: 4 }),
  batch_pause_seconds: S.number({ min: 0, max: 3600, default: 0 }),
  batch_pause_min_changes: S.number({ integer: true, min: 1, max: 100_000, default: 1 }),
  dry_run: S.boolean({ default: false }),
  run_on_start: S.boolean({ default: true }),
  log_level: S.string({ enum: ['error', 'warn', 'info', 'debug'], default: 'info' }),
  timezone: S.string({ nonEmpty: true }),
  git_timeout_minutes: S.number({ min: 1, max: 720, default: 30 }),
  keep_runs: S.number({ integer: true, min: 1, max: 1000, default: 30 }),
  prune_mirrors: S.boolean({ default: true }),

  schedule: S.object(
    {
      sync: { ...CRON, default: '0 3 * * *' },
      heartbeat: { ...CRON, nullable: true, default: null },
    },
    { default: {} },
  ),

  database: S.object(
    {
      driver: S.string({ enum: ['sqlite', 'postgres'], default: 'sqlite' }),
      path: S.string({ nonEmpty: true }),
      host: S.string({ nonEmpty: true }),
      port: S.number({ integer: true, min: 1, max: 65535 }),
      name: S.string({ nonEmpty: true }),
      user: S.string({ nonEmpty: true }),
      password: S.string(),
      ssl: S.string({ enum: ['disable', 'require', 'verify-full'] }),
      ssl_ca: S.string({ nonEmpty: true }),
      pool_max: S.number({ integer: true, min: 1, max: 100 }),
    },
    { default: {} },
  ),

  connections: S.record({ ...connection }, { minEntries: 1, required: true }),

  smtp: S.object({
    enabled: S.boolean({ default: true }),
    host: S.string(),
    port: S.number({ integer: true, min: 1, max: 65535, default: 587 }),
    secure: S.boolean({ default: false }),
    user: S.string({ default: '' }),
    password: S.string({ default: '' }),
    from: S.string(),
    from_name: S.string(),
    to: S.listOf(S.string(), { default: [] }),
    notify_on: S.array(S.string({ enum: ['changes', 'failures', 'always'] }), { default: ['changes', 'failures'] }),
    subject_prefix: S.string({ default: '[repo-sync]' }),
    logo: S.string({ nonEmpty: true }),
    retries: S.number({ integer: true, min: 0, max: 10, default: 3 }),
  }),

  ntfy: ntfyBlock({ defaults: true }),
  uptime_kuma: kumaBlock({ defaults: true }),

  metrics: S.object({
    enabled: S.boolean({ default: true }),
    host: S.string({ nonEmpty: true, default: '0.0.0.0' }),
    port: S.number({ integer: true, min: 1, max: 65535, default: 9091 }),
    path: S.string({ nonEmpty: true, default: '/metrics' }),
  }),

  defaults: S.object(
    {
      include_forks: S.boolean({ default: false }),
      include_archived: S.boolean({ default: false }),
      visibility: S.string({ enum: ['private', 'internal', 'public', 'original'], default: 'private' }),
      auto_create_namespaces: S.boolean({ default: true }),
      create_root_namespace: S.boolean({ default: false }),
      structure: S.string({ enum: ['preserve', 'flatten', 'template'], default: 'preserve' }),
      path_template: S.string({ nonEmpty: true, default: '{repo}' }),
      flatten_separator: S.string({ nonEmpty: true, default: '-' }),
      path_prefix: S.string({ nonEmpty: true }),
      on_remap: S.string({ enum: ['report', 'archive', 'delete'], default: 'report' }),
      mirror_wikis: S.boolean({ default: false }),
      mirror_lfs: S.boolean({ default: false }),
      push_mode: S.string({ enum: ['refspecs', 'mirror'], default: 'refspecs' }),
      relax_push_rules: S.boolean({ default: false }),
      disable_ci: S.boolean({ default: true }),
      sync_metadata: S.boolean({ default: true }),
      verify: S.string({ enum: ['push', 'always', 'off'], default: 'push' }),
    },
    { default: {} },
  ),

  sources: S.array(source, { required: true, minItems: 1 }),
});
