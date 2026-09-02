import path from 'node:path';
import { rm } from 'node:fs/promises';
import { gitlab } from '../providers/index.js';
import { snapshotRefs, fetchMirror, pushMirror } from '../mirror.js';
import { diffRefs, refsToState } from '../diff.js';

export async function syncWiki({ repo, mapping, destConn, project, config, timeoutMs, srcEnv, destEnv, rlog }) {
  const dir = path.join(config.data_dir, 'mirrors', mapping.source, `${repo.fullPath}.wiki.git`);
  const sourceUrl = repo.wikiSshUrl;
  const destUrl = destConn.sshUrl(`${mapping.path}.wiki`);

  try {
    const before = await snapshotRefs(dir, srcEnv, timeoutMs);
    try {
      await fetchMirror(dir, sourceUrl, srcEnv, timeoutMs);
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return { status: 'absent', detail: firstLine(err.stderr || err.message) };
    }

    const after = await snapshotRefs(dir, srcEnv, timeoutMs);
    if (after.size === 0) return { status: 'empty' };

    if (project?.id && project.wiki_access_level === 'disabled') {
      await gitlab.enableWiki(destConn, project.id);
      rlog.info('enabled wiki on destination project', { destination: mapping.path });
    }
    await pushMirror(dir, destUrl, destEnv, timeoutMs, 'refspecs');

    const changes = diffRefs(before, after);
    return { status: changes.changed ? 'changed' : 'unchanged', changes, refs: refsToState(after) };
  } catch (err) {
    rlog.warn('wiki mirror failed', { error: err.message });
    return { status: 'failed', error: firstLine(err.stderr || err.message) };
  }
}

function firstLine(text) {
  return String(text || '').split('\n').find((l) => l.trim()) ?? '';
}
