import { log } from './logger.js';
import { redactedConfig } from './config/load.js';
import { buildConnections } from './connections.js';
import { enumerateAll, resolveAll, preflight } from './run.js';
import { resolveMapping } from './mapping.js';
import * as gitlab from './providers/gitlab.js';
import { formatBytes } from './mail.js';

export function printConfigDump(config) {
  log.print('resolved configuration');
  log.print('='.repeat(72));
  log.print(JSON.stringify(redactedConfig(stripInternals(config)), null, 2));
  log.print('');
}

function stripInternals(config) {
  const { configPath, ...rest } = config;
  return { config_path: configPath, ...rest };
}

export async function checkConfig(config, { verbose = true } = {}) {
  const connections = buildConnections(config);
  let problems = 0;

  if (verbose) printConfigDump(config);

  log.print('enumerating sources');
  log.print('='.repeat(72));
  const enumerated = await enumerateAll(config, connections);
  for (const entry of enumerated) {
    if (entry.disabled) {
      log.print(`  ${entry.source.name}: disabled`);
      continue;
    }
    if (entry.error) {
      log.print(`  ${entry.source.name}: FAILED - ${entry.error.message}`);
      problems++;
      continue;
    }
    log.print(`  ${entry.source.name}: ${entry.repos.length} repositories, ${entry.filtered.length} filtered out`);
  }
  log.print('');

  const { mappings, errors, skipped } = resolveAll(enumerated);
  for (const err of errors) {
    log.print(`  MAPPING ERROR ${err.message}`);
    problems++;
  }

  const pf = await preflight({ config, connections, enumerated, mappings, dryRun: true });

  for (const problem of pf.fatal) {
    log.print('FATAL');
    log.print('='.repeat(72));
    log.print(problem);
    log.print('');
    problems++;
  }
  for (const [source, messages] of pf.sourceErrors) {
    for (const message of messages) {
      log.print(`  SOURCE ERROR ${source}: ${message}`);
      problems++;
    }
  }
  if (pf.sourceErrors.size) log.print('');

  if (pf.keyChecks?.size) {
    log.print('ssh keys');
    log.print('='.repeat(72));
    for (const [name, check] of pf.keyChecks) {
      const state = check.ok ? (check.skipped ?? `ok, mode ${check.mode}`) : `PROBLEM: ${check.problem}`;
      log.print(`  ${padTo(name, 16)} ${state}`);
    }
    log.print('');
  }

  if (pf.namespaceChecks.length) {
    log.print('destination namespaces');
    log.print('='.repeat(72));
    for (const check of pf.namespaceChecks) {
      const state = check.ok ? (check.unverified ? 'writable (access level not exposed by this instance)' : 'writable') : `NOT WRITABLE: ${check.reason}`;
      log.print(`  ${check.connection}:${check.namespace}  (${check.kind}) ${state}`);
    }
    log.print('');
  }

  log.print('resolved mapping');
  log.print('='.repeat(72));

  const width = Math.min(60, Math.max(20, ...mappings.map((m) => m.repo.fullPath.length)));
  const existence = await lookupProjects(connections, mappings);
  const plannedGroups = new Set();

  for (const entry of enumerated) {
    if (entry.disabled || entry.error) continue;
    log.print(`  source ${entry.source.name}  (${entry.source.connection} -> ${entry.source.destination.connection}:${entry.source.destination.namespace})`);
    if (!entry.mappings?.length) log.print('    (nothing to mirror)');

    for (const m of entry.mappings ?? []) {
      const key = `${m.connection}:${m.path}`;
      const exists = existence.get(key);
      const marker = exists === true ? 'exists' : exists === false ? 'CREATE' : '?';
      log.print(`    ${padTo(m.repo.fullPath, width)} -> ${padTo(key, 52)} [${marker}]`);

      for (const group of await groupsToCreate(pf, m)) {
        if (!plannedGroups.has(`${m.connection}:${group}`)) {
          plannedGroups.add(`${m.connection}:${group}`);
        }
      }
    }
    for (const s of entry.skipped ?? []) {
      log.print(`    ${padTo(s.repo.fullPath, width)} -- skipped (${s.reason})`);
    }
    for (const f of entry.filtered ?? []) {
      log.print(`    ${padTo(f.repo.fullPath, width)} -- filtered (${f.reason})`);
    }
    log.print('');
  }

  if (plannedGroups.size) {
    log.print('destination groups that would be created');
    log.print('='.repeat(72));
    for (const group of [...plannedGroups].sort()) log.print(`  ${group}`);
    log.print('');
  }

  const toCreate = [...existence.values()].filter((v) => v === false).length;
  log.print('summary');
  log.print('='.repeat(72));
  log.print(`  ${mappings.length} repositor${mappings.length === 1 ? 'y' : 'ies'} mapped`);
  log.print(`  ${skipped.length} skipped by rules`);
  log.print(`  ${toCreate} destination project${toCreate === 1 ? '' : 's'} would be created`);
  log.print(`  ${plannedGroups.size} destination group${plannedGroups.size === 1 ? '' : 's'} would be created`);
  log.print(`  ${problems} problem${problems === 1 ? '' : 's'}`);
  if (config.dry_run) log.print('  dry_run is enabled: a real run would create nothing');

  return problems === 0 ? 0 : 1;
}

async function groupsToCreate(pf, mapping) {
  const resolver = pf.resolvers.get(mapping.connection);
  if (!resolver || mapping.subgroups.length === 0) return [];
  const root = await resolver.root(mapping.namespace).catch(() => null);
  if (!root || root.kind === 'user') return [];
  const out = [];
  let current = mapping.namespace;
  for (const segment of mapping.subgroups) {
    current = `${current}/${segment}`;
    const group = await resolver.group(current).catch(() => null);
    if (!group) out.push(current);
  }
  return out;
}

async function lookupProjects(connections, mappings) {
  const out = new Map();
  const limit = 8;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, mappings.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= mappings.length) return;
        const m = mappings[index];
        const key = `${m.connection}:${m.path}`;
        if (out.has(key)) continue;
        try {
          const project = await gitlab.getProject(connections[m.connection], m.path);
          out.set(key, Boolean(project));
        } catch {
          out.set(key, null);
        }
      }
    }),
  );
  return out;
}

export async function explain(config, query) {
  const connections = buildConnections(config);
  const enumerated = await enumerateAll(config, connections);
  const needle = query.toLowerCase();
  let found = 0;

  for (const entry of enumerated) {
    if (entry.disabled || entry.error) continue;
    for (const repo of entry.repos) {
      if (!repo.fullPath.toLowerCase().includes(needle) && repo.repo.toLowerCase() !== needle) continue;
      found++;
      const result = resolveMapping(repo, entry.source);

      log.print(`${repo.fullPath}`);
      log.print('='.repeat(72));
      log.print(`  source        ${entry.source.name}`);
      log.print(`  connection    ${entry.source.connection} (${repo.provider} at ${repo.host})`);
      log.print(`  owner         ${repo.owner}`);
      log.print(`  repo          ${repo.repo}`);
      log.print(`  relative path ${repo.relativePath || '(top level)'}`);
      log.print(`  fork          ${repo.isFork}`);
      log.print(`  archived      ${repo.isArchived}`);
      log.print(`  visibility    ${repo.visibility}`);
      log.print(`  size          ${repo.sizeHint ? formatBytes(repo.sizeHint) : 'unknown'}`);
      log.print('');
      log.print('  resolution');
      for (const step of result.explain.steps) log.print(`    ${step}`);
      if (result.explain.rule) {
        log.print('');
        log.print(`  rule[${result.explain.rule.index}] that fired:`);
        for (const [k, v] of Object.entries(result.explain.rule)) {
          if (k === 'index') continue;
          log.print(`    ${k}: ${JSON.stringify(v)}`);
        }
      }
      log.print('');
      if (result.skipped) log.print(`  RESULT: skipped (${result.reason})`);
      else if (result.error) log.print(`  RESULT: error, ${result.error}`);
      else {
        log.print(`  RESULT: ${result.connection}:${result.path}`);
        log.print(`    root namespace ${result.namespace}`);
        log.print(`    subgroups      ${result.subgroups.join('/') || '(none)'}`);
        log.print(`    project        ${result.project}`);
        log.print(`    visibility     ${result.visibility}`);
        log.print(`    on_remap       ${result.onRemap}`);
      }
      log.print('');
    }

    for (const f of entry.filtered ?? []) {
      if (!f.repo.fullPath.toLowerCase().includes(needle)) continue;
      found++;
      log.print(`${f.repo.fullPath}`);
      log.print('='.repeat(72));
      log.print(`  source  ${entry.source.name}`);
      log.print(`  RESULT: filtered out before mapping, ${f.reason}`);
      log.print('');
    }
  }

  if (found === 0) {
    log.print(`no repository matching "${query}" was found in any enabled source.`);
    return 1;
  }
  return 0;
}

function padTo(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
