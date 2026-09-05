import { rm } from 'node:fs/promises';
import path from 'node:path';
import { log } from './logger.js';
import { buildConnections } from './connections.js';
import * as gitlab from './providers/gitlab.js';
import { openState } from './state.js';
import { directorySize, listMirrors } from './mirror.js';
import { formatBytes } from './mail.js';

export async function cleanup(config, { source: sourceName, yes = false, force = false, keepState = false, purge = false }) {
  const state = await openState(config.database);
  try {
    return await run(config, state, { sourceName, yes, force, keepState, purge });
  } finally {
    await state.close();
  }
}

async function run(config, state, { sourceName, yes, force, keepState, purge }) {
  const sourceState = state.sources[sourceName];

  if (!sourceState) {
    log.print(`no source named "${sourceName}" in state. Known sources: ${Object.keys(state.sources).join(', ') || '(none)'}`);
    return 1;
  }

  const connections = buildConnections(config);
  const repos = Object.entries(sourceState.repos ?? {});

  log.print(`cleanup plan for source "${sourceName}"`);
  log.print('='.repeat(78));
  log.print(`  ${repos.length} repositories recorded in state`);
  log.print('');

  const targets = [];
  const unreachable = [];

  for (const [fullPath, record] of repos) {
    if (!record.destination) continue;
    const idx = record.destination.indexOf(':');
    const connectionName = idx < 0 ? null : record.destination.slice(0, idx);
    const projectPath = idx < 0 ? record.destination : record.destination.slice(idx + 1);
    const connection = connections[connectionName];

    if (!connection) {
      unreachable.push({ fullPath, destination: record.destination, reason: `connection "${connectionName}" is not in the config` });
      continue;
    }

    let project;
    try {
      project = await gitlab.getProject(connection, projectPath, { followRedirect: true });
    } catch (err) {
      unreachable.push({ fullPath, destination: record.destination, reason: err.message });
      continue;
    }

    if (!project) continue;
    targets.push({
      fullPath,
      connectionName,
      connection,
      projectPath,
      project,
      empty: Boolean(project.empty_repo),
      createdByService: Boolean(record.createdByService),
      pending: gitlab.markedForDeletion(project),
      currentPath: project.path_with_namespace ?? projectPath,
    });
  }

  const empty = targets.filter((t) => t.empty);
  const withContent = targets.filter((t) => !t.empty);

  log.print('DESTINATION PROJECTS THAT EXIST');
  log.print('-'.repeat(78));
  for (const t of targets) {
    const flags = [t.empty ? 'empty' : 'HAS COMMITS', t.createdByService ? 'created by this service' : 'not recorded as ours'];
    if (t.pending) flags.push('already marked for deletion');
    log.print(`  ${t.connectionName}:${t.projectPath}`);
    log.print(`    from ${t.fullPath}  [${flags.join(', ')}]`);
  }
  if (targets.length === 0) log.print('  (none)');
  log.print('');

  if (unreachable.length) {
    log.print('COULD NOT BE CHECKED');
    log.print('-'.repeat(78));
    for (const u of unreachable) log.print(`  ${u.destination}: ${u.reason}`);
    log.print('');
  }

  const mirrors = await listMirrors(config.data_dir, sourceName).catch(() => []);
  let mirrorBytes = 0;
  for (const m of mirrors) mirrorBytes += await directorySize(m.dir).catch(() => 0);

  const deletable = force ? targets : empty;

  log.print('WHAT --yes WOULD DO');
  log.print('-'.repeat(78));
  log.print(`  delete ${deletable.length} destination project${deletable.length === 1 ? '' : 's'}${force ? ' (--force: including ones with commits)' : ''}`);
  if (!force && withContent.length) {
    log.print(`  keep ${withContent.length} project${withContent.length === 1 ? '' : 's'} that have commits. Add --force to delete those too.`);
  }
  log.print(
    purge
      ? '  purge them outright (--purge), leaving no scheduled-deletion copy and no redirect'
      : '  let the instance decide when the delete becomes permanent. Add --purge to remove them outright.',
  );
  log.print(`  remove ${mirrors.length} local mirror director${mirrors.length === 1 ? 'y' : 'ies'} (${formatBytes(mirrorBytes)})`);
  log.print(keepState ? '  keep the state entry (--keep-state)' : `  forget the state entry for "${sourceName}"`);
  log.print('');

  if (!yes) {
    log.print('Nothing was changed. Re-run with --yes to apply.');
    return 0;
  }

  if (config.dry_run) {
    log.print('dry_run is enabled in the config, so nothing was deleted.');
    return 0;
  }

  let deleted = 0;
  let purged = 0;
  let failed = 0;
  for (const t of deletable) {
    try {
      if (!t.pending) await gitlab.deleteProject(t.connection, t.project.id);
      deleted++;
      log.print(`  deleted ${t.connectionName}:${t.projectPath}`);
      if (purge) {
        const current = await gitlab
          .getProject(t.connection, t.projectPath, { followRedirect: true })
          .catch(() => null);
        if (current && gitlab.markedForDeletion(current)) {
          await gitlab.deleteProject(t.connection, current.id, {
            permanently: true,
            fullPath: current.path_with_namespace,
          });
          purged++;
          log.print(`  purged ${t.connectionName}:${current.path_with_namespace}`);
        }
      }
    } catch (err) {
      failed++;
      log.print(`  FAILED to delete ${t.connectionName}:${t.projectPath}: ${err.message}`);
    }
  }

  for (const m of mirrors) {
    await rm(m.dir, { recursive: true, force: true }).catch((err) =>
      log.print(`  could not remove ${m.dir}: ${err.message}`),
    );
  }
  await rm(path.join(config.data_dir, 'mirrors', sourceName), { recursive: true, force: true }).catch(() => {});

  if (!keepState && failed === 0) {
    await state.forgetSource(sourceName);
  } else if (!keepState) {
    log.print('');
    log.print(`state for "${sourceName}" was kept because ${failed} deletion(s) failed. Fix the cause and re-run.`);
  }

  log.print('');
  log.print(
    `done: ${deleted} project(s) deleted, ${purged} purged, ${failed} failed, ${mirrors.length} mirror director(ies) removed.`,
  );
  if (deleted > purged) {
    log.print('');
    log.print('Note: with delayed project deletion enabled, GitLab renames each project to');
    log.print('"<path>-deletion_scheduled-<id>" and purges it after the retention period. Until');
    log.print('then the old path answers the API with the doomed project, which refuses pushes.');
    log.print('Sync treats such a path as free and creates a new project. Use --purge to remove');
    log.print('them outright instead.');
  }
  if (!keepState) log.print(`state for "${sourceName}" was forgotten, so the next run treats every repository as new.`);
  return failed === 0 ? 0 : 1;
}
