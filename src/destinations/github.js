import { github } from '../providers/index.js';
import { pushMirror } from '../mirror.js';

export const kind = 'github';

export function verifiable() {
  return true;
}

export async function check(connection, namespace) {
  const owner = await github.getOwner(connection, namespace);
  if (!owner) {
    return {
      ok: false,
      reason:
        `destination owner "${namespace}" was not found on ${connection.host} using connection ` +
        `"${connection.name}". Either it does not exist, or this token cannot see it.`,
    };
  }
  if (owner.kind === 'user' && !owner.self) {
    const me = await github.whoami(connection);
    return {
      ok: false,
      reason:
        `"${namespace}" is the personal account of another user. The destination token belongs to ` +
        `"${me.login}", and GitHub only lets a token create repositories under its own account or an ` +
        'organisation it can write to.',
    };
  }
  return { ok: true, kind: owner.kind };
}

export async function prepare(mapping, { connection, rlog }) {
  let repo = await github.getRepo(connection, mapping.path);
  let created = false;

  if (!repo) {
    const owner = await github.getOwner(connection, mapping.namespace);
    repo = await github.createRepo(connection, {
      owner: mapping.namespace,
      ownerKind: owner?.kind ?? 'user',
      name: mapping.project,
      description: mapping.repo.description,
      isPrivate: mapping.visibility !== 'public',
    });
    created = true;
    rlog.info('created destination repository', { destination: `${mapping.connection}:${mapping.path}` });
  }

  return { url: connection.sshUrl(mapping.path), target: repo, created };
}

export async function deliver(mapping, { mirrorDir, target, env, timeoutMs, pushMode }) {
  await pushMirror(mirrorDir, target, env, timeoutMs, pushMode);
}

export async function afterPush(mapping, { connection, project, source, pushedRefs, result, rlog }) {
  let current = project;
  const wantPrivate = mapping.visibility !== 'public';

  if (current.private !== wantPrivate) {
    const from = current.private ? 'private' : 'public';
    try {
      current = await github.updateRepo(connection, mapping.path, { private: wantPrivate });
      result.visibilityChanged = { from, to: wantPrivate ? 'private' : 'public' };
      rlog.info('changed destination visibility', { destination: mapping.path, to: result.visibilityChanged.to });
    } catch (err) {
      const detail = `could not set ${mapping.path} to ${wantPrivate ? 'private' : 'public'}: ${err.message}`;
      if (wantPrivate) throw new Error(detail);
      result.visibilityWarning = detail;
      rlog.warn('could not widen destination visibility', { destination: mapping.path, error: err.message });
    }
  }

  if (mapping.disableCi && (await github.actionsEnabled(connection, mapping.path))) {
    await github.disableActions(connection, mapping.path);
    result.disabledCi = true;
    rlog.info('disabled Actions on the destination repository', { destination: mapping.path });
  }

  if (mapping.syncMetadata) {
    const changes = github.metadataDiff(current, source, pushedRefs);
    if (Object.keys(changes).length) {
      current = await github.updateRepo(connection, mapping.path, changes);
      result.metadata = { ...(result.metadata ?? {}), ...changes };
    }
    if (github.topicsDiffer(current, source)) {
      const topics = (source.topics ?? []).map((t) => t.toLowerCase());
      await github.setTopics(connection, mapping.path, topics);
      result.metadata = { ...(result.metadata ?? {}), topics };
    }
    if (result.metadata) {
      rlog.info('updated destination repository metadata', {
        destination: mapping.path,
        changed: Object.keys(result.metadata),
      });
    }
  }

  return current;
}

export async function archive(connection, fullPath) {
  await github.updateRepo(connection, fullPath, { archived: true });
}

export async function remove(connection, fullPath) {
  await github.deleteRepo(connection, fullPath);
}
