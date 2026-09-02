import { rm } from 'node:fs/promises';
import { log } from '../logger.js';
import { directorySize, listMirrors } from '../mirror.js';

export async function pruneMirrors(config, state, report) {
  for (const [sourceName, sourceState] of Object.entries(state.sources)) {
    const tracked = new Set(Object.keys(sourceState.repos || {}));
    let mirrors;
    try {
      mirrors = await listMirrors(config.data_dir, sourceName);
    } catch {
      continue;
    }
    for (const mirror of mirrors) {
      if (tracked.has(mirror.fullPath)) continue;
      const bytes = await directorySize(mirror.dir).catch(() => 0);
      try {
        await rm(mirror.dir, { recursive: true, force: true });
        report.pruned.push({ source: sourceName, repo: mirror.fullPath, wiki: mirror.wiki, bytes });
        log.info('pruned an unreferenced mirror directory', { source: sourceName, repo: mirror.fullPath, bytes });
      } catch (err) {
        log.warn('could not prune a mirror directory', { dir: mirror.dir, error: err.message });
      }
    }
  }
}
