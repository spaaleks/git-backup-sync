import { log } from './logger.js';
import { inspect, forceRelease } from './lock.js';

export async function unlock(config, { force = false } = {}) {
  const lock = await inspect(config.data_dir);

  if (!lock.present) {
    log.print(`no lock file at ${lock.file}, nothing to do.`);
    return 0;
  }

  log.print(`lock at ${lock.file}`);
  log.print(`  held by   pid ${lock.pid} on ${lock.host}`);
  log.print(`  since     ${lock.startedAt}`);
  log.print(`  last seen ${Math.round(lock.ageMs / 1000)}s ago`);
  log.print(`  verdict   ${lock.stale ? 'stale' : 'LOOKS ALIVE'}`);
  log.print('');

  if (!lock.stale && !force) {
    log.print('A sync appears to be running: the lock was refreshed within the last few minutes.');
    log.print('Stop it first, or pass --force if you are certain it is gone.');
    return 1;
  }

  await forceRelease(config.data_dir);
  log.print(lock.stale ? 'stale lock removed.' : 'lock removed (--force).');
  return 0;
}
