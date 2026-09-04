import { gitlab } from '../providers/index.js';
import { runGit } from '../mirror.js';
import { stateToRefs } from '../diff.js';

export async function handleRemap({ mapping, previous, destConn, destEnv, timeoutMs, dryRun, rlog }) {
  const info = { from: previous.destination, to: `${mapping.connection}:${mapping.path}`, action: 'reported' };
  const mode = mapping.onRemap ?? 'report';
  if (mode === 'report') return info;

  const [oldConnName, oldPath] = splitDestination(previous.destination);
  if (oldConnName !== mapping.connection) {
    info.detail = 'the old destination is on a different connection; left untouched';
    return info;
  }

  if (dryRun) {
    info.detail = 'dry run: old destination left untouched';
    return info;
  }

  const oldProject = await gitlab.getProject(destConn, oldPath).catch(() => null);
  if (!oldProject) {
    info.action = 'gone';
    info.detail = 'the old destination project no longer exists';
    return info;
  }

  if (mode === 'archive') {
    if (oldProject.archived) {
      info.action = 'archived';
      info.detail = 'was already archived';
      return info;
    }
    await gitlab.archiveProject(destConn, oldProject.id);
    info.action = 'archived';
    rlog.info('archived the old destination project after a remap', { project: oldPath });
    return info;
  }

  if (!previous.createdByService) {
    info.detail = 'left in place: this service did not create that project, so it is not ours to delete';
    return info;
  }

  const drift = await refsDiffer(destConn, oldPath, previous.refs, destEnv, timeoutMs);
  if (drift === null) {
    info.detail = 'left in place: could not read the refs at the old path to confirm nobody pushed there';
    return info;
  }
  if (drift) {
    info.detail = 'left in place: the refs at the old path differ from the last mirrored state, so somebody pushed there';
    return info;
  }

  await gitlab.deleteProject(destConn, oldProject.id);
  info.action = 'deleted';
  rlog.warn('deleted the old destination project after a remap', { project: oldPath });
  return info;
}

function splitDestination(value) {
  const idx = String(value).indexOf(':');
  return idx < 0 ? [null, String(value)] : [value.slice(0, idx), value.slice(idx + 1)];
}

async function refsDiffer(destConn, oldPath, knownRefs, env, timeoutMs) {
  try {
    const { stdout } = await runGit(['ls-remote', destConn.sshUrl(oldPath)], { env, timeoutMs: Math.min(timeoutMs, 120_000) });
    const remote = new Map();
    for (const line of stdout.split('\n')) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (sha && ref && (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/'))) remote.set(ref, sha);
    }
    const known = stateToRefs(knownRefs);
    if (remote.size !== known.size) return true;
    for (const [ref, sha] of known) {
      if (remote.get(ref) !== sha) return true;
    }
    return false;
  } catch {
    return null;
  }
}
