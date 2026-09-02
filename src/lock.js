import { readFile, writeFile, unlink, mkdir, stat, utimes } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { log } from './logger.js';

const HEARTBEAT_MS = 30_000;
const STALE_MS = 5 * 60_000;

let held = false;

export class LockBusyError extends Error {
  constructor(message, holder) {
    super(message);
    this.name = 'LockBusyError';
    this.holder = holder;
  }
}

function lockPath(dataDir) {
  return path.join(dataDir, 'sync.lock');
}

export async function acquire(dataDir) {
  if (held) throw new LockBusyError('a sync is already running in this process');

  const file = lockPath(dataDir);
  await mkdir(dataDir, { recursive: true });

  const existing = await readLock(file);
  if (existing && !(await isStale(existing))) {
    throw new LockBusyError(
      `another sync holds the lock (pid ${existing.pid} on ${existing.host}, since ${existing.startedAt}, ` +
        `last seen ${Math.round(existing.ageMs / 1000)}s ago)`,
      existing,
    );
  }
  if (existing) {
    log.warn('removing a stale lock file', { pid: existing.pid, host: existing.host, ageMs: existing.ageMs, file });
    await unlink(file).catch(() => {});
  }

  const record = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  try {
    await writeFile(file, JSON.stringify(record), { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new LockBusyError('another sync acquired the lock first', await readLock(file));
    }
    throw err;
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(file, now, now).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref();

  held = true;
  return async () => {
    held = false;
    clearInterval(heartbeat);
    await unlink(file).catch(() => {});
  };
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

export function isHeld() {
  return held;
}

export async function inspect(dataDir) {
  const file = lockPath(dataDir);
  const lock = await readLock(file);
  if (!lock) return { file, present: false };
  return { file, present: true, ...lock, stale: await isStale(lock) };
}

export async function forceRelease(dataDir) {
  await unlink(lockPath(dataDir));
}
