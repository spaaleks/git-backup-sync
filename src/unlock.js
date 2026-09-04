import { log } from './logger.js';
import { openLock } from './lock.js';
import { openStore } from './store/index.js';

export async function unlock(config, { force = false } = {}) {
  const store = config.database.driver === 'postgres' ? await openStore(config.database) : null;
  try {
    return await inspectAndRelease(await openLock(config, store), { force });
  } finally {
    await store?.close();
  }
}

async function inspectAndRelease(handle, { force }) {
  const lock = await handle.inspect();

  if (!lock.present) {
    log.print(`nothing holds ${lock.describe}.`);
    return 0;
  }

  log.print(`lock at ${lock.describe}`);
  log.print(`  held by   pid ${lock.pid} on ${lock.host}`);
  log.print(`  since     ${lock.startedAt}`);
  log.print(`  last seen ${Math.round(lock.ageMs / 1000)}s ago`);
  log.print(`  verdict   ${lock.stale ? 'stale' : 'LOOKS ALIVE'}`);
  log.print('');

  if (!lock.stale && !force) {
    log.print('A sync appears to be running.');
    log.print('Stop it first, or pass --force if you are certain it is gone.');
    return 1;
  }

  await handle.forceRelease();
  log.print(lock.stale ? 'stale lock removed.' : 'lock removed (--force).');
  return 0;
}
