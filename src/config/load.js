import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { interpolate, isRedactableKey, isSecretPath, maskUrlSecret } from './interpolate.js';
import { configSchema, validate, ValidationError } from './schema.js';
import { parseCron } from '../cron.js';
import { TEMPLATE_PLACEHOLDERS } from '../mapping.js';

export const DEFAULT_CONFIG_PATH = '/config/config.yml';
const LEGACY_CONFIG_PATH = '/config/config.yaml';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const INHERITABLE = [
  'include_forks',
  'include_archived',
  'visibility',
  'auto_create_namespaces',
  'create_root_namespace',
  'structure',
  'path_template',
  'flatten_separator',
  'path_prefix',
  'on_remap',
  'mirror_wikis',
  'mirror_lfs',
  'push_mode',
  'relax_push_rules',
  'disable_ci',
  'sync_metadata',
  'verify',
];

export async function loadConfig({ path, env = process.env } = {}) {
  const explicit = path ?? env.CONFIG_PATH;
  const candidates = explicit ? [explicit] : [DEFAULT_CONFIG_PATH, LEGACY_CONFIG_PATH];

  let text;
  let used;
  for (const candidate of candidates) {
    try {
      text = await readFile(candidate, 'utf8');
      used = candidate;
      break;
    } catch (err) {
      if (err.code !== 'ENOENT' || candidate === candidates.at(-1)) {
        throw new ConfigError(
          `cannot read config file ${candidates.join(' or ')}: ` +
            (err.code === 'ENOENT' ? 'no such file' : err.message),
        );
      }
    }
  }
  path = used;

  let doc;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`${path}: YAML is malformed: ${err.message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ConfigError(`${path}: expected a mapping at the top level`);
  }

  const { value: interpolated } = interpolate(doc, { env, configPath: path });
  applyDatabaseEnv(interpolated, env);

  let config;
  try {
    config = validate(interpolated, configSchema);
  } catch (err) {
    if (err instanceof ValidationError) throw new ConfigError(`${path}: ${err.message}`);
    throw err;
  }

  config.timezone ??= env.TZ || 'UTC';
  crossCheck(config, path);
  resolveDatabase(config);
  resolveInheritance(config);

  config.configPath = path;
  return deepFreeze(config);
}

const DB_ENV = {
  driver: 'DB_DRIVER',
  path: 'DB_PATH',
  host: 'DB_HOST',
  port: 'DB_PORT',
  name: 'DB_NAME',
  user: 'DB_USER',
  password: 'DB_PASSWORD',
  ssl: 'DB_SSL',
  ssl_ca: 'DB_SSL_CA',
  pool_max: 'DB_POOL_MAX',
};

const POSTGRES_ONLY = ['host', 'port', 'name', 'user', 'password', 'ssl', 'ssl_ca', 'pool_max'];

function applyDatabaseEnv(doc, env) {
  const database = (doc.database ??= {});
  for (const [key, variable] of Object.entries(DB_ENV)) {
    if (database[key] === undefined && env[variable] !== undefined && env[variable] !== '') {
      database[key] = env[variable];
    }
  }
}

function checkDatabase(config, add) {
  const db = config.database;
  if (db.driver === 'postgres') {
    if (db.path) add('database.path', 'applies to `driver: sqlite`, not postgres');
    for (const key of ['host', 'name', 'user']) {
      if (!db[key]) add(`database.${key}`, `is required for \`driver: postgres\` (${DB_ENV[key]})`);
    }
    return;
  }
  for (const key of POSTGRES_ONLY) {
    if (db[key] !== undefined && db[key] !== null) {
      add(`database.${key}`, 'applies to `driver: postgres`, not sqlite');
    }
  }
}

function resolveDatabase(config) {
  const db = config.database;
  if (db.driver === 'postgres') {
    db.port ??= 5432;
    db.ssl ??= 'require';
    db.pool_max ??= 10;
    return;
  }
  db.path ??= `${config.data_dir.replace(/\/+$/, '')}/state.db`;
}

function crossCheck(config, path) {
  const errors = [];
  const add = (p, m) => errors.push(`  ${p}: ${m}`);

  checkDatabase(config, add);

  for (const [name, conn] of Object.entries(config.connections)) {
    const p = `connections.${name}`;
    if (conn.provider === 'git') {
      conn.name = name;
      continue;
    }
    if (!conn.token) add(`${p}.token`, 'is required for a github or gitlab connection');
    if (conn.provider === 'github') {
      conn.api_url ??= 'https://api.github.com';
      conn.host ??= hostFromApiUrl(conn.api_url) === 'api.github.com' ? 'github.com' : hostFromApiUrl(conn.api_url);
      if (!conn.host) add(p, 'could not derive an SSH host from api_url; set `host` explicitly');
    } else {
      if (!conn.host) add(p, '`host` is required for a gitlab connection (e.g. gitlab.com)');
      conn.api_url ??= conn.host ? `https://${conn.host}/api/v4` : undefined;
    }
    conn.name = name;
  }

  for (const key of ['sync', 'heartbeat']) {
    const expr = config.schedule?.[key];
    if (!expr) continue;
    try {
      parseCron(expr);
    } catch (err) {
      add(`schedule.${key}`, err.message);
    }
  }

  if (config.timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: config.timezone });
    } catch {
      add('timezone', `"${config.timezone}" is not a recognised IANA time zone`);
    }
  }

  if (config.smtp) {
    config.smtp.to = (config.smtp.to ?? []).filter((t) => String(t).trim() !== '');

    if (config.smtp.enabled) {
      for (const key of ['host', 'from']) {
        if (!config.smtp[key]) {
          add(`smtp.${key}`, 'is required unless `smtp.enabled` is false (did an env var resolve empty?)');
        }
      }
      if (config.smtp.to.length === 0) {
        add('smtp.to', 'needs at least one recipient unless `smtp.enabled` is false (did an env var resolve empty?)');
      }
      if (config.smtp.to.some((t) => !t.includes('@'))) {
        add('smtp.to', 'contains an entry that is not an email address');
      }
    }
  }

  if (config.ntfy?.enabled && !config.ntfy.topic) {
    const anySourceTopic = (config.sources ?? []).some((src) => src.ntfy?.topic);
    if (!anySourceTopic) add('ntfy.topic', 'is required unless a source defines its own, or `enabled: false`');
  }
  if (config.uptime_kuma?.enabled && !config.uptime_kuma.url) {
    const anySourceUrl = (config.sources ?? []).some((src) => src.uptime_kuma?.url);
    if (!anySourceUrl) add('uptime_kuma.url', 'is required unless a source defines its own, or `enabled: false`');
  }
  for (const [i, src] of (config.sources ?? []).entries()) {
    if (src.uptime_kuma && !src.uptime_kuma.url && !config.uptime_kuma?.url) {
      add(`sources[${i}].uptime_kuma.url`, 'is required: a push monitor URL cannot be inherited when none is set globally');
    }
  }

  const seen = new Set();
  config.sources.forEach((src, i) => {
    const p = `sources[${i}]`;
    if (seen.has(src.name)) add(`${p}.name`, `duplicate source name "${src.name}"; names are state keys and must be unique`);
    seen.add(src.name);

    const conn = config.connections[src.connection];
    if (!conn) {
      add(`${p}.connection`, `no connection named "${src.connection}" is defined`);
    }

    const dest = src.destination;
    if (dest?.type === 'directory') {
      if (!dest.path) add(`${p}.destination.path`, 'is required for `type: directory`');
      if (dest.connection) add(`${p}.destination.connection`, 'has no meaning for `type: directory`');
      for (const key of ['namespace', 'visibility', 'auto_create_namespaces', 'create_root_namespace', 'relax_push_rules', 'disable_ci', 'sync_metadata']) {
        if (dest[key] !== undefined && dest[key] !== null) {
          add(`${p}.destination.${key}`, 'applies to a gitlab destination, not `type: directory`');
        }
      }
      if (dest.format === 'worktree' && (dest.verify ?? config.defaults?.verify) === 'always') {
        add(`${p}.destination.verify`, 'cannot be `always` for `format: worktree`: a checkout has no refs to read back');
      }
    } else if (dest?.type === 'github') {
      const destConn = config.connections[dest.connection];
      if (!dest.connection) {
        add(`${p}.destination.connection`, 'is required for `type: github`');
      } else if (!destConn) {
        add(`${p}.destination.connection`, `no connection named "${dest.connection}" is defined`);
      } else if (destConn.provider !== 'github') {
        add(
          `${p}.destination.connection`,
          `"${dest.connection}" is a ${destConn.provider} connection; a github destination needs a github connection`,
        );
      }
      if (!dest.namespace) {
        add(`${p}.destination.namespace`, 'is required for `type: github`: it names the user or organisation');
      } else if (dest.namespace.includes('/')) {
        add(`${p}.destination.namespace`, 'must be a single user or organisation: GitHub has no nested namespaces');
      }
      for (const key of ['auto_create_namespaces', 'create_root_namespace', 'relax_push_rules', 'path']) {
        if (dest[key] !== undefined && dest[key] !== null) {
          add(`${p}.destination.${key}`, 'has no meaning for `type: github`');
        }
      }
      if ((dest.visibility ?? config.defaults?.visibility) === 'internal') {
        add(`${p}.destination.visibility`, '`internal` is GitLab-only; GitHub destinations are private or public');
      }
    } else {
      const destConn = config.connections[dest?.connection];
      if (!dest?.connection) {
        add(`${p}.destination.connection`, 'is required for `type: gitlab`');
      } else if (!destConn) {
        add(`${p}.destination.connection`, `no connection named "${dest.connection}" is defined`);
      } else if (destConn.provider !== 'gitlab') {
        add(
          `${p}.destination.connection`,
          `"${dest.connection}" is a ${destConn.provider} connection; a gitlab destination needs a gitlab connection`,
        );
      }
      if (dest?.path) add(`${p}.destination.path`, 'applies to `type: directory`, not a gitlab destination');
    }

    if (dest?.namespace && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(dest.namespace)) {
      add(`${p}.destination.namespace`, `"${dest.namespace}" is not a valid GitLab namespace path`);
    }

    if (!dest?.namespace && dest?.type !== 'directory' && dest?.type !== 'github') {
      const structure = dest?.structure ?? config.defaults?.structure;
      if (structure === 'flatten') {
        add(
          `${p}.destination`,
          '`structure: flatten` needs a `namespace`: it collapses every repository to a single path segment, ' +
            'which without a namespace would be a top-level project, and GitLab requires every project to sit ' +
            'in a namespace.',
        );
      }
      const createRoot = dest?.create_root_namespace ?? config.defaults?.create_root_namespace;
      if (!createRoot) {
        add(
          `${p}.destination`,
          'has no `namespace`, so each of the source\'s top-level groups becomes a top-level group on the ' +
            'destination. That needs `create_root_namespace: true`, or an existing group for every one of them.',
        );
      }
    }

    checkScope(src, conn, p, add);

    for (const [ri, rule] of (src.rules || []).entries()) {
      const rp = `${p}.rules[${ri}]`;
      if (rule.skip && (rule.namespace || rule.path_template || rule.structure)) {
        add(rp, 'has `skip: true` together with mapping keys; a skipped repo has no destination');
      }
      if (rule.path_template) checkTemplate(rule.path_template, `${rp}.path_template`, add);
    }

    if (dest?.path_template) checkTemplate(dest.path_template, `${p}.destination.path_template`, add);

    for (const key of ['include', 'exclude']) {
      for (const [ri, pattern] of (src[key] || []).entries()) {
        try {
          new RegExp(pattern);
        } catch (err) {
          add(`${p}.${key}[${ri}]`, `is not a valid regular expression: ${err.message}`);
        }
      }
    }
  });

  if (config.defaults?.path_template) checkTemplate(config.defaults.path_template, 'defaults.path_template', add);

  if (errors.length) {
    throw new ConfigError(`${path}: configuration is invalid:\n${errors.join('\n')}`);
  }
}

function checkScope(src, conn, p, add) {
  const { scope } = src;
  const provider = conn?.provider;
  const sp = `${p}.scope`;

  if (provider === 'git' && scope.type !== 'urls') {
    add(`${sp}.type`, 'a `provider: git` connection has no API, so it only supports scope type `urls`');
  }
  if (scope.type === 'org' && provider && provider !== 'github') {
    add(`${sp}.type`, '`org` is a GitHub scope; use `group` for GitLab');
  }
  if (scope.type === 'group' && provider && provider !== 'gitlab') {
    add(`${sp}.type`, '`group` is a GitLab scope; use `org` for GitHub');
  }
  if (['user', 'org', 'group'].includes(scope.type) && !scope.login) {
    add(`${sp}.login`, `is required for scope type "${scope.type}"`);
  }
  if (scope.type === 'urls') {
    if ((scope.urls?.length ?? 0) === 0) {
      add(`${sp}.urls`, 'needs at least one url');
    }
    if (provider && provider !== 'git') {
      add(
        `${p}.connection`,
        `scope type "urls" needs a \`provider: git\` connection, but "${src.connection}" is ${provider}`,
      );
    }
  }
  if (['projects', 'repos'].includes(scope.type)) {
    const list = scope.projects || scope.repos;
    if (!list || list.length === 0) {
      add(`${sp}.projects`, `scope type "${scope.type}" needs a non-empty list of paths`);
    }
  }
  if ((scope.include_owned_groups || scope.include_membership) && provider === 'github') {
    add(`${sp}.include_owned_groups`, 'is a GitLab-only option (GitHub has no group tree); use scope type `org`');
  }
  if (scope.include_membership && !scope.include_owned_groups) {
    add(
      `${sp}.include_membership`,
      'has no effect without `include_owned_groups: true`',
    );
  }
}

function checkTemplate(template, p, add) {
  for (const m of template.matchAll(/\{([a-z_]+)\}/g)) {
    if (!TEMPLATE_PLACEHOLDERS.includes(m[1])) {
      add(p, `unknown placeholder {${m[1]}}; known placeholders are ${TEMPLATE_PLACEHOLDERS.map((x) => `{${x}}`).join(', ')}`);
    }
  }
  const stray = template.replace(/\{[a-z_]+\}/g, '');
  if (stray.includes('{') || stray.includes('}')) {
    add(p, 'contains an unbalanced or malformed placeholder');
  }
}

function hostFromApiUrl(apiUrl) {
  try {
    return new URL(apiUrl).host;
  } catch {
    return undefined;
  }
}

function resolveInheritance(config) {
  for (const src of config.sources) {
    for (const key of INHERITABLE) {
      if (src[key] === undefined) src[key] = config.defaults[key];
    }
    const dest = src.destination;
    for (const key of ['structure', 'path_template', 'flatten_separator', 'path_prefix', 'visibility', 'auto_create_namespaces', 'create_root_namespace', 'on_remap', 'relax_push_rules', 'disable_ci', 'sync_metadata', 'push_mode', 'verify']) {
      if (dest[key] === undefined) dest[key] = src[key] ?? config.defaults[key];
    }
    if (src.visibility === undefined) src.visibility = config.defaults.visibility;
    if (src.batch_pause_seconds === undefined) src.batch_pause_seconds = config.batch_pause_seconds;
    if (src.batch_pause_min_changes === undefined) src.batch_pause_min_changes = config.batch_pause_min_changes;
    if (src.scope.type === 'repos' && !src.scope.projects) src.scope.projects = src.scope.repos;
  }
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

export function redactedConfig(config) {
  const walk = (node, keyName, path) => {
    if (typeof node === 'string') {
      if (node === '') return node;
      if (isSecretPath(path)) return maskUrlSecret(node);
      return keyName && isRedactableKey(keyName) ? '***' : node;
    }
    if (Array.isArray(node)) return node.map((v, i) => walk(v, keyName, `${path}[${i}]`));
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, k, path ? `${path}.${k}` : k);
      return out;
    }
    return node;
  };
  return walk(config, null, '');
}
