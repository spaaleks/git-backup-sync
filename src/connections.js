import { child } from './logger.js';

const USER_AGENT = 'git-backup-sync/1.0';

export class ApiError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class Connection {
  constructor(name, cfg) {
    this.name = name;
    this.provider = cfg.provider;
    this.apiUrl = cfg.api_url ? cfg.api_url.replace(/\/+$/, '') : null;
    this.host = cfg.host;
    this.token = cfg.token;
    this.sshKey = cfg.ssh_key;
    this.sshUser = cfg.ssh_user || 'git';
    this.sshPort = cfg.ssh_port || 22;
    this.sshOptions = cfg.ssh_options || [];
    this.knownHosts = cfg.known_hosts;
    this.strictHostKeyChecking = cfg.strict_host_key_checking;
    this.log = child({ connection: name });

    this.rate = { remaining: null, resetAt: null, limit: null };
    this.queue = Promise.resolve();
  }

  get sshHost() {
    return this.host;
  }

  sshUrl(fullPath) {
    if (this.sshPort && this.sshPort !== 22) {
      return `ssh://${this.sshUser}@${this.host}:${this.sshPort}/${fullPath}.git`;
    }
    return `${this.sshUser}@${this.host}:${fullPath}.git`;
  }

  gitSshCommand() {
    const parts = ['ssh'];
    if (this.sshKey) parts.push('-i', quote(this.sshKey), '-o', 'IdentitiesOnly=yes');
    if (this.sshPort && this.sshPort !== 22) parts.push('-p', String(this.sshPort));
    if (this.knownHosts) parts.push('-o', `UserKnownHostsFile=${quote(this.knownHosts)}`);
    parts.push('-o', `StrictHostKeyChecking=${this.strictHostKeyChecking ? 'yes' : 'accept-new'}`);
    parts.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30');
    for (const opt of this.sshOptions) parts.push('-o', quote(opt));
    return parts.join(' ');
  }

  authHeaders() {
    return this.provider === 'github'
      ? {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }
      : { 'PRIVATE-TOKEN': this.token };
  }

  request(path, options = {}) {
    const run = () => this.#request(path, options);
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #request(path, { method = 'GET', body, headers = {}, retries = 3, expect404 = false } = {}) {
    const url = path.startsWith('http') ? path : `${this.apiUrl}${path}`;
    let attempt = 0;

    for (;;) {
      await this.#waitForRateLimit();

      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            'User-Agent': USER_AGENT,
            ...this.authHeaders(),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        if (attempt++ < retries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new ApiError(`${method} ${redactUrl(url)} failed: ${err.message}`, { url });
      }

      this.#readRateLimit(res.headers);

      if (res.status === 404 && expect404) return { status: 404, data: null, headers: res.headers };

      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt++ < retries) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
          this.log.warn('api request throttled or failed, retrying', {
            status: res.status,
            url: redactUrl(url),
            waitMs,
            attempt,
          });
          await sleep(waitMs);
          continue;
        }
      }

      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (!res.ok) {
        throw new ApiError(
          `${method} ${redactUrl(url)} -> ${res.status} ${res.statusText}${
            data ? `: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}` : ''
          }`,
          { status: res.status, url: redactUrl(url), body: data },
        );
      }

      return { status: res.status, data, headers: res.headers };
    }
  }

  async paginate(path, { perPage = 100, max = 100_000, ...options } = {}) {
    const out = [];
    let url = addQuery(path.startsWith('http') ? path : `${this.apiUrl}${path}`, { per_page: perPage });

    while (url) {
      const { data, headers } = await this.request(url, options);
      if (!Array.isArray(data)) {
        throw new ApiError(`expected a list from ${redactUrl(url)}`, { url });
      }
      out.push(...data);
      if (out.length >= max) break;
      url = nextPageUrl(headers, this.provider);
    }
    return out;
  }

  #readRateLimit(headers) {
    const get = (k) => headers.get(k);
    if (this.provider === 'github') {
      const remaining = get('x-ratelimit-remaining');
      const reset = get('x-ratelimit-reset');
      if (remaining !== null) this.rate.remaining = Number(remaining);
      if (reset !== null) this.rate.resetAt = new Date(Number(reset) * 1000);
      const limit = get('x-ratelimit-limit');
      if (limit !== null) this.rate.limit = Number(limit);
      const expiry = get('github-authentication-token-expiration');
      if (expiry) this.tokenExpiresAt = expiry;
    } else {
      const remaining = get('ratelimit-remaining');
      const reset = get('ratelimit-reset');
      if (remaining !== null) this.rate.remaining = Number(remaining);
      if (reset !== null) this.rate.resetAt = new Date(Number(reset) * 1000);
      const limit = get('ratelimit-limit');
      if (limit !== null) this.rate.limit = Number(limit);
    }
  }

  async #waitForRateLimit() {
    const { remaining, resetAt } = this.rate;
    if (remaining === null || remaining > 5 || !resetAt) return;
    const waitMs = resetAt.getTime() - Date.now();
    if (waitMs <= 0) return;
    this.log.warn('rate limit nearly exhausted, sleeping until reset', {
      remaining,
      resetAt: resetAt.toISOString(),
      waitMs,
    });
    await sleep(Math.min(waitMs + 1000, 15 * 60_000));
    this.rate.remaining = null;
  }

  async probe() {
    if (this.provider === 'git') {
      return { ok: true, latencyMs: 0, login: null, note: 'no API, credentials only' };
    }
    const started = Date.now();
    try {
      const { data } = await this.request(this.provider === 'github' ? '/user' : '/user');
      const info = {
        ok: true,
        latencyMs: Date.now() - started,
        login: data?.login || data?.username,
        rate: { ...this.rate, resetAt: this.rate.resetAt?.toISOString() ?? null },
        tokenExpiresAt: this.tokenExpiresAt ?? null,
      };
      if (this.provider === 'gitlab') {
        const res = await this.request('/personal_access_tokens/self', { expect404: true, retries: 1 }).catch(() => null);
        if (res?.data?.expires_at) info.tokenExpiresAt = res.data.expires_at;
      }
      return info;
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: err.message };
    }
  }
}

// OpenSSH refuses a private key that group or others can read, even as root.
export async function checkSshKey(connection) {
  if (!connection.sshKey) return { ok: true, skipped: 'no ssh_key configured, git will use the default identity' };

  const { stat } = await import('node:fs/promises');
  let info;
  try {
    info = await stat(connection.sshKey);
  } catch (err) {
    return {
      ok: false,
      problem:
        `ssh_key "${connection.sshKey}" ${err.code === 'ENOENT' ? 'does not exist' : `cannot be read: ${err.message}`}. ` +
        'In Docker, check that the file is mounted into the container at that path.',
    };
  }

  if (!info.isFile()) {
    return { ok: false, problem: `ssh_key "${connection.sshKey}" is not a regular file` };
  }

  const mode = info.mode & 0o777;
  if (mode & 0o077) {
    return {
      ok: false,
      problem:
        `ssh_key "${connection.sshKey}" has mode ${mode.toString(8).padStart(4, '0')}, which lets group or others ` +
        'read it. OpenSSH refuses such a key outright, even as root. Run `chmod 400` on it.',
    };
  }

  return { ok: true, mode: mode.toString(8).padStart(4, '0') };
}

export function buildConnections(config) {
  const out = {};
  for (const [name, cfg] of Object.entries(config.connections)) {
    out[name] = new Connection(name, cfg);
  }
  return out;
}

function nextPageUrl(headers, provider) {
  if (provider === 'gitlab') {
    const next = headers.get('x-next-page');
    if (!next) return null;
    const link = parseLink(headers.get('link'))?.next;
    return link || null;
  }
  return parseLink(headers.get('link'))?.next || null;
}

function parseLink(header) {
  if (!header) return null;
  const out = {};
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

function addQuery(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && !u.searchParams.has(k)) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    u.searchParams.delete('private_token');
    u.searchParams.delete('access_token');
    return u.toString();
  } catch {
    return url;
  }
}

function backoff(attempt) {
  return Math.min(1000 * 2 ** (attempt - 1), 30_000) + Math.floor(Math.random() * 250);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quote(value) {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
