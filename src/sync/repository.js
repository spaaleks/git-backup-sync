import { child } from '../logger.js';
import { gitlab, github } from '../providers/index.js';
import { NamespaceError } from '../namespaces.js';
import {
  gitEnv,
  mirrorDir,
  snapshotRefs,
  fetchMirror,
  pruneInternalRefs,
  detectLfs,
  transferLfs,
  directorySize,
} from '../mirror.js';
import { diffRefs, refsToState, describeChanges } from '../diff.js';
import { stopping } from './stop.js';
import { pushWithRelax } from './push-rules.js';
import { verifyDestination, describeVerification, VerificationError } from './verify.js';
import { syncWiki } from './wiki.js';
import { handleRemap } from './remap.js';
import * as directory from '../destinations/directory.js';
import * as githubDest from '../destinations/github.js';

export { VerificationError };

export async function syncRepo({ mapping, source, srcConn, destConn, resolver, state, config, report, dryRun, timeoutMs, lfsAvailable }) {
  const { repo } = mapping;
  const rlog = child({ source: source.name, repo: repo.fullPath });
  const previous = state.repos[repo.fullPath];
  const dir = mirrorDir(config.data_dir, source.name, repo.fullPath);
  const srcEnv = gitEnv(srcConn);
  const destEnv = mapping.type === 'directory' ? srcEnv : gitEnv(destConn);
  const toDirectory = mapping.type === 'directory';
  const toGithub = mapping.type === 'github';

  const result = {
    repo: repo.fullPath,
    source: source.name,
    destination: toDirectory ? `dir:${mapping.root}/${mapping.path}` : `${mapping.connection}:${mapping.path}`,
    status: 'unchanged',
    changes: null,
    error: null,
    createdGroups: [],
    createdProject: false,
    wiki: null,
    usesLfs: false,
    consecutiveFailures: previous?.consecutiveFailures ?? 0,
  };

  if (previous?.destination && previous.destination !== result.destination) {
    result.remapped = { from: previous.destination, to: result.destination, action: 'reported' };
  }

  try {
    const before = await snapshotRefs(dir, srcEnv, timeoutMs);

    if (dryRun && toDirectory) {
      result.status = 'planned';
      result.planned = { exists: false, wouldCreateProject: true, wouldCreateGroups: [] };
      rlog.info('would mirror to a directory', {
        destination: result.destination,
        format: mapping.format,
        refsKnown: before.size,
      });
      return result;
    }

    if (dryRun && toGithub) {
      const existing = await github.getRepo(destConn, mapping.path).catch(() => null);
      result.status = 'planned';
      result.planned = { exists: Boolean(existing), wouldCreateProject: !existing, wouldCreateGroups: [] };
      rlog.info('would mirror', { destination: result.destination, projectExists: Boolean(existing), refsKnown: before.size });
      return result;
    }

    if (dryRun) {
      const existing = await gitlab.getProject(destConn, mapping.path).catch(() => null);
      result.status = 'planned';
      result.planned = {
        exists: Boolean(existing),
        wouldCreateProject: !existing,
        wouldCreateGroups: mapping.subgroups.length ? await plannedGroups(resolver, mapping) : [],
      };
      rlog.info('would mirror', {
        destination: result.destination,
        projectExists: result.planned.exists,
        wouldCreateGroups: result.planned.wouldCreateGroups,
        refsKnown: before.size,
      });
      return result;
    }

    let project = null;
    let destUrl;

    if (toGithub) {
      const prepared = await githubDest.prepare(mapping, { connection: destConn, rlog });
      destUrl = prepared.url;
      project = prepared.target;
      if (prepared.created) {
        result.createdProject = true;
        report.createdProjects.push({ connection: mapping.connection, path: mapping.path });
      }
    } else if (toDirectory) {
      const target = await directory.ensureTarget(mapping, { env: destEnv, timeoutMs });
      destUrl = target.url;
      if (target.created) {
        result.createdProject = true;
        report.createdProjects.push({ connection: `dir:${mapping.root}`, path: mapping.path });
        rlog.info('created destination repository directory', { destination: result.destination });
      }
    } else {
      const ns = await resolver.ensure(mapping.namespace, mapping.subgroups, {
        visibility: mapping.visibility,
        autoCreate: mapping.autoCreateNamespaces,
        createRoot: mapping.createRootNamespace,
      });
      for (const created of ns.created) {
        result.createdGroups.push(created);
        report.createdGroups.push({ connection: mapping.connection, path: created });
    }

    if (mapping.relaxPushRules && ns.created.length && ns.id) {
      const applied = await gitlab.relaxGroupPushRules(destConn, ns.id);
      if (applied?.applied) {
        result.relaxedGroupPushRules = ns.path;
        rlog.info('relaxed push rules on the destination group', { group: ns.path });
      }
    }

    project = await gitlab.getProject(destConn, mapping.path);
    if (!project) {
      project = await gitlab.createProject(destConn, {
        name: repo.repo,
        path: mapping.project,
        namespaceId: ns.id,
        visibility: mapping.visibility,
        disableCi: mapping.disableCi,
      });
      result.createdProject = true;
      report.createdProjects.push({ connection: mapping.connection, path: mapping.path });
      rlog.info('created destination project', { destination: result.destination });

      if (mapping.relaxPushRules) {
        try {
          result.relaxedPushRules = { ...(await gitlab.relaxPushRules(destConn, project.id)), preemptive: true };
        } catch (err) {
          rlog.warn('could not pre-emptively relax the push rules, will retry reactively if needed', {
            error: err.message,
          });
        }
      }
    } else if (mapping.disableCi && gitlab.ciEnabled(project)) {
      project = await gitlab.disableCi(destConn, project.id);
      result.disabledCi = true;
      rlog.info('disabled CI on the destination project', { destination: result.destination });
    }

    if (project?.id && project.visibility !== mapping.visibility) {
      const previous = project.visibility;
      const restricting = gitlab.isMoreRestrictive(mapping.visibility, previous);
      try {
        project = await gitlab.setVisibility(destConn, project.id, mapping.visibility);
        result.visibilityChanged = { from: previous, to: mapping.visibility };
        rlog.info('changed destination visibility', {
          destination: result.destination,
          to: mapping.visibility,
        });
      } catch (err) {
        const detail =
          `could not set ${mapping.path} to ${mapping.visibility}: ${err.message}. ` +
          'GitLab caps a project at its namespace\'s visibility, so a public project cannot sit in a private group.';
        if (restricting) throw new Error(detail);
        result.visibilityWarning = detail;
        rlog.warn('could not widen destination visibility', { destination: result.destination, error: err.message });
      }
    }

    destUrl = destConn.sshUrl(mapping.path);
    }

    const { cloned } = await fetchMirror(dir, repo.sshUrl, srcEnv, timeoutMs);
    await pruneInternalRefs(dir, srcEnv, timeoutMs);
    const after = await snapshotRefs(dir, srcEnv, timeoutMs);

    const deliver = () =>
      toDirectory
        ? directory.deliver(mapping, {
            mirrorDir: dir,
            target: destUrl,
            env: destEnv,
            timeoutMs,
            defaultBranch: repo.defaultBranch ?? defaultBranchOf(after),
            pushMode: mapping.pushMode,
          })
        : pushWithRelax({ dir, destUrl, destEnv, timeoutMs, mapping, project, destConn, result, rlog });

    result.usesLfs = await detectLfs(dir, srcEnv, timeoutMs, repo.defaultBranch);

    if (Object.keys(refsToState(after)).length === 0) {
      // git push with no matching refs exits 1. That is not a failure.
      result.emptyRepo = true;
      rlog.info('source repository is empty, nothing to push');
    } else {
      await deliver();
    }

    if (toGithub && project) {
      project = await githubDest.afterPush(mapping, {
        connection: destConn,
        project,
        source: repo,
        pushedRefs: after,
        result,
        rlog,
      });
    }

    if (!toDirectory && !toGithub && mapping.syncMetadata && project?.id) {
      const changes = gitlab.metadataDiff(project, repo, after);
      if (Object.keys(changes).length) {
        project = await gitlab.updateProject(destConn, project.id, changes);
        result.metadata = changes;
        rlog.info('updated destination project metadata', {
          destination: result.destination,
          changed: Object.keys(changes),
        });
      }
    }

    if (result.usesLfs) {
      if (source.mirror_lfs && lfsAvailable) {
        await transferLfs(dir, repo.sshUrl, destUrl, srcEnv, destEnv, timeoutMs);
        result.lfsTransferred = true;
      } else {
        result.lfsWarning = source.mirror_lfs
          ? 'uses Git LFS but git-lfs is unavailable; blobs were not transferred'
          : 'uses Git LFS; `--mirror` does not carry LFS blobs. Set `mirror_lfs: true` to transfer them.';
      }
    }

    const changes = diffRefs(before, after);
    result.changes = changes;
    result.status = previous ? (changes.changed ? 'changed' : 'unchanged') : 'new';
    if (cloned && previous) result.recloned = true;

    const wrote = result.status !== 'unchanged' || result.createdProject || result.relaxedPushRules;
    const canVerify = !toDirectory || directory.verifiable(mapping);
    if (canVerify && (mapping.verify === 'always' || (mapping.verify === 'push' && wrote && !result.emptyRepo))) {
      result.verification = await verifyDestination({ destUrl, destEnv, timeoutMs, expected: after });
      if (!result.verification.ok) {
        throw new VerificationError(describeVerification(result.verification, result.destination));
      }
    }

    if (source.mirror_wikis && !toDirectory && !toGithub) {
      result.wiki = await syncWiki({ repo, mapping, destConn, project, config, timeoutMs, srcEnv, destEnv, rlog });
    }

    if (result.remapped && !toDirectory && !toGithub) {
      result.remapped = await handleRemap({ mapping, previous, destConn, destEnv, timeoutMs, dryRun, rlog });
    }

    const sizeBytes = await directorySize(dir);
    state.repos[repo.fullPath] = {
      destination: result.destination,
      refs: refsToState(after),
      wiki: result.wiki?.refs ? { refs: result.wiki.refs, lastSuccess: new Date().toISOString() } : previous?.wiki ?? null,
      lastSuccess: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      consecutiveFailures: 0,
      lastError: null,
      sizeBytes,
      usesLfs: result.usesLfs,
      createdByService: previous?.createdByService || result.createdProject,
    };
    result.sizeBytes = sizeBytes;
    result.consecutiveFailures = 0;

    if (result.status !== 'unchanged') {
      rlog.info('repository synced', { status: result.status, changes: describeChanges(changes) });
    } else {
      rlog.debug('repository unchanged');
    }
    return result;
  } catch (err) {
    const message = err instanceof NamespaceError ? err.message : err.stderr ? `${err.message}\n${err.stderr}` : err.message;

    // Cut short by shutdown, so it must not count against the failure streak.
    if (err.interrupted || (stopping() && err.signal)) {
      result.status = 'interrupted';
      result.error = message;
      rlog.warn('repository interrupted by shutdown', { repo: repo.fullPath });
      return result;
    }

    const failures = (previous?.consecutiveFailures ?? 0) + 1;
    result.status = 'failed';
    result.error = message;
    result.consecutiveFailures = failures;
    state.repos[repo.fullPath] = {
      ...(previous ?? { refs: {}, wiki: null, lastSuccess: null, sizeBytes: 0, usesLfs: false }),
      // A project created before this run failed is still ours to clean up.
      createdByService: Boolean(previous?.createdByService || result.createdProject),
      destination: previous?.destination ?? result.destination,
      lastSeenAt: new Date().toISOString(),
      consecutiveFailures: failures,
      lastError: message,
    };
    rlog.error('repository failed', { error: message, consecutiveFailures: failures });
    return result;
  }
}

function defaultBranchOf(refs) {
  for (const candidate of ['refs/heads/main', 'refs/heads/master']) {
    if (refs.has(candidate)) return candidate.slice('refs/heads/'.length);
  }
  for (const ref of refs.keys()) {
    if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  }
  return null;
}

async function plannedGroups(resolver, mapping) {
  const planned = [];
  let current = mapping.namespace;
  const root = await resolver.root(mapping.namespace).catch(() => null);
  if (!root) return planned;
  for (const segment of mapping.subgroups) {
    current = `${current}/${segment}`;
    const group = await resolver.group(current).catch(() => null);
    if (!group) planned.push(current);
  }
  return planned;
}
