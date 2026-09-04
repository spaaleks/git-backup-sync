import { registerSecret } from '../logger.js';

const SECRET_KEY = /secret|pass|token|key/i;

const PATH_KEYS = new Set(['ssh_key', 'ssh_key_path', 'known_hosts', 'known_hosts_file', 'data_dir']);

const SECRET_PATHS = ['uptime_kuma.url'];

export function isSecretPath(path) {
  return SECRET_PATHS.some((suffix) => path === suffix || path.endsWith(`.${suffix}`));
}

export function maskUrlSecret(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return value;
    segments[segments.length - 1] = '***';
    url.pathname = `/${segments.join('/')}`;
    return url.toString();
  } catch {
    return '***';
  }
}

const TOKEN = /\$\$\{|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export class InterpolationError extends Error {
  constructor(message, path) {
    super(message);
    this.name = 'InterpolationError';
    this.path = path;
  }
}

export function isRedactableKey(key) {
  return SECRET_KEY.test(key) && !PATH_KEYS.has(key);
}

export function interpolateString(input, path, env = process.env) {
  if (!input.includes('${') && !input.includes('$$')) return input;

  let out = '';
  let last = 0;
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(input)) !== null) {
    out += input.slice(last, m.index);
    last = m.index + m[0].length;

    if (m[0] === '$${') {
      out += '${';
      continue;
    }

    const [, name, fallback] = m;
    const raw = env[name];
    if (fallback !== undefined) {
      out += raw === undefined || raw === '' ? fallback : raw;
    } else if (raw === undefined) {
      throw new InterpolationError(
        `environment variable \${${name}} is not set (referenced by ${path}). ` +
          `Set it, or give it a fallback with \${${name}:-default}.`,
        path,
      );
    } else {
      out += raw;
    }
  }
  out += input.slice(last);
  return out;
}

export function interpolate(doc, { env = process.env, configPath = '<config>' } = {}) {
  const secrets = new Set();

  const walk = (node, path, keyName) => {
    if (typeof node === 'string') {
      const value = interpolateString(node, path, env);
      if (value !== '' && ((keyName && isRedactableKey(keyName)) || isSecretPath(path))) {
        secrets.add(value);
        registerSecret(value);
      }
      return value;
    }
    if (Array.isArray(node)) {
      return node.map((item, i) => walk(item, `${path}[${i}]`, keyName));
    }
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = walk(v, path === '' ? k : `${path}.${k}`, k);
      }
      return out;
    }
    return node;
  };

  try {
    return { value: walk(doc, '', null), secrets };
  } catch (err) {
    if (err instanceof InterpolationError) {
      err.message = `${configPath}: ${err.message}`;
    }
    throw err;
  }
}
