import { readFile, writeFile, unlink, mkdir, stat, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { log } from './logger.js';

const HEARTBEAT_MS = 30_000;
const STALE_MS = 5 * 60_000;

export async function openLock(config, store = null) {
  if (config.database.driver !== 'postgres') return new FileLock(config.data_dir);
  if (!store) throw new Error('the postgres advisory lock needs an open state store');
  return new AdvisoryLock(store);
}

export class LockBusyError extends Error {
  constructor(message, holder) {
    super(message);
    this.name = 'LockBusyError';
    this.holder = holder;
  }
}

export class FileLock {
  constructor(dataDir, { scope = 'sync' } = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, `${scope}.lock`);
    this.describe = this.file;
  }

  async acquire() {
    await mkdir(this.dataDir, { recursive: true });

    const existing = await readLock(this.file);
    if (existing && !(await isStale(existing))) {
      throw new LockBusyError(
        `another sync holds the lock (pid ${existing.pid} on ${existing.host}, since ${existing.startedAt}, ` +
          `last seen ${Math.round(existing.ageMs / 1000)}s ago)`,
        existing,
      );
    }
    if (existing) {
      log.warn('removing a stale lock file', { pid: existing.pid, host: existing.host, ageMs: existing.ageMs, file: this.file });
      await unlink(this.file).catch(() => {});
    }

    const record = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
    try {
      await writeFile(this.file, JSON.stringify(record), { flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new LockBusyError('another sync acquired the lock first', await readLock(this.file));
      }
      throw err;
    }

    const heartbeat = setInterval(() => {
      const now = new Date();
      utimes(this.file, now, now).catch(() => {});
    }, HEARTBEAT_MS);
    heartbeat.unref();

    return async () => {
      clearInterval(heartbeat);
      await unlink(this.file).catch(() => {});
    };
  }

  async inspect() {
    const lock = await readLock(this.file);
    if (!lock) return { describe: this.file, present: false };
    return { describe: this.file, present: true, ...lock, stale: await isStale(lock) };
  }

  async forceRelease() {
    await unlink(this.file);
  }
}

// A session lock, not pg_advisory_xact_lock: a run commits per repository over
// hours and cannot sit inside one transaction.
export class AdvisoryLock {
  constructor(store, { scope = 'sync' } = {}) {
    this.store = store;
    this.scope = scope;
    this.key = advisoryKey(scope);
    this.describe = `postgres advisory lock ${this.key[0]}/${this.key[1]} on ${store.describe}`;
  }

  async acquire() {
    const client = await this.store.pool.connect();
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1, $2) AS taken', this.key);
      if (!rows[0].taken) {
        const holder = await this.#holder();
        throw new LockBusyError(
          holder
            ? `another sync holds the lock (backend ${holder.pid} from ${holder.host}, since ${holder.startedAt})`
            : 'another sync holds the lock',
          holder,
        );
      }
    } catch (err) {
      client.release();
      throw err;
    }

    return async () => {
      await client.query('SELECT pg_advisory_unlock($1, $2)', this.key).catch(() => {});
      client.release();
    };
  }

  async inspect() {
    const holder = await this.#holder();
    if (!holder) return { describe: this.describe, present: false };
    // Nothing to age out: the server drops the lock when the connection goes.
    return { describe: this.describe, present: true, ...holder, stale: false };
  }

  async forceRelease() {
    const holder = await this.#holder();
    if (!holder) return;
    await this.store.pool.query('SELECT pg_terminate_backend($1)', [holder.pid]);
  }

  async #holder() {
    const { rows } = await this.store.pool.query(
      `SELECT a.pid, a.client_addr, a.backend_start
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted
          AND l.classid = $1 AND l.objid = $2 AND l.objsubid = 2`,
      this.key,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      pid: row.pid,
      host: row.client_addr ?? 'the database server',
      startedAt: row.backend_start?.toISOString?.() ?? String(row.backend_start),
      ageMs: Date.now() - new Date(row.backend_start).getTime(),
    };
  }
}

// Masked to 31 bits so the pair fits pg_locks' unsigned oid columns.
function advisoryKey(scope) {
  const digest = createHash('sha256').update(`git-backup-sync:${scope}`).digest();
  return [digest.readUInt32BE(0) & 0x7fffffff, digest.readUInt32BE(4) & 0x7fffffff];
}

async function readLock(file) {
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    return { ...JSON.parse(text), ageMs: Date.now() - info.mtimeMs };
  } catch {
    return null;
  }
}

async function isStale(lock) {
  if (!lock?.pid || !lock?.startedAt) return true;
  if (lock.host === hostname()) {
    try {
      process.kill(lock.pid, 0);
      return false;
    } catch (err) {
      return err.code === 'ESRCH';
    }
  }
  return lock.ageMs > STALE_MS;
}
