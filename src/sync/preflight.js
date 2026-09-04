import { child } from '../logger.js';
import { enumerateSource, gitlab } from '../providers/index.js';
import { checkSshKey } from '../connections.js';
import { resolveMapping, findCollisions, describeCollision } from '../mapping.js';
import { NamespaceResolver } from '../namespaces.js';
import * as directory from '../destinations/directory.js';
import * as githubDest from '../destinations/github.js';

export async function enumerateAll(config, connections) {
  const results = [];
  for (const source of config.sources) {
    if (!source.enabled) {
      results.push({ source, repos: [], filtered: [], disabled: true });
      continue;
    }
    const connection = connections[source.connection];
    const slog = child({ source: source.name, connection: source.connection });
    try {
      const started = Date.now();
      const { repos, filtered } = await enumerateSource(connection, source);
      slog.info('enumerated source', { repos: repos.length, filtered: filtered.length, ms: Date.now() - started });
      results.push({ source, repos, filtered });
    } catch (err) {
      slog.error('source enumeration failed', { error: err.message });
      results.push({ source, repos: [], filtered: [], error: err });
    }
  }
  return results;
}

export function resolveAll(enumerated) {
  const mappings = [];
  const errors = [];
  const skipped = [];

  for (const entry of enumerated) {
    entry.mappings = [];
    entry.skipped = [];
    for (const repo of entry.repos) {
      const result = resolveMapping(repo, entry.source);
      if (result.skipped) {
        entry.skipped.push({ repo, reason: result.reason });
        skipped.push({ repo, reason: result.reason });
        continue;
      }
      if (result.error) {
        errors.push({ repo, source: entry.source.name, message: result.error });
        continue;
      }
      entry.mappings.push(result);
      mappings.push(result);
    }
  }

  return { mappings, errors, skipped };
}

export async function preflight({ config, connections, mappings, dryRun = false }) {
  const fatal = [];
  const sourceErrors = new Map();
  const resolvers = new Map();
  const namespaceChecks = [];

  const keyChecks = new Map();
  for (const source of config.sources) {
    if (!source.enabled) continue;
    for (const name of [source.connection, source.destination.connection]) {
      if (!keyChecks.has(name) && connections[name]) {
        keyChecks.set(name, await checkSshKey(connections[name]));
      }
    }
    for (const name of [source.connection, source.destination.connection]) {
      const check = keyChecks.get(name);
      if (check && !check.ok) addSourceError(sourceErrors, source.name, `connection "${name}": ${check.problem}`);
    }
  }

  const { collisions, selfMirrors } = findCollisions(mappings, config.connections);

  if (collisions.length) {
    fatal.push(
      `${collisions.length} destination path collision${collisions.length === 1 ? '' : 's'}. ` +
        'Two repositories mirroring into one project would destroy data, so the whole run is aborted ' +
        'before any push. Give one of each pair a `path_template` or a `rules` entry.\n' +
        collisions.map(describeCollision).join('\n'),
    );
  }

  if (selfMirrors.length) {
    fatal.push(
      'a destination resolves to its own source path on the same host. ' +
        '`push --mirror` onto the source would be catastrophic, so the run is aborted.\n' +
        selfMirrors
          .map((m) => `  ${m.repo.host}:${m.repo.fullPath}  (source "${m.source}") -> ${m.connection}:${m.path}`)
          .join('\n'),
    );
  }

  const resolverFor = (connectionName) => {
    let r = resolvers.get(connectionName);
    if (!r) {
      r = new NamespaceResolver(connections[connectionName], { dryRun });
      resolvers.set(connectionName, r);
    }
    return r;
  };

  const directories = new Map();
  for (const m of mappings.filter((x) => x.type === 'directory')) {
    if (!directories.has(m.root)) directories.set(m.root, new Set());
    directories.get(m.root).add(m.source);
  }
  for (const [root, sources] of directories) {
    const result = await directory.check({ root });
    if (!result.ok) {
      for (const name of sources) addSourceError(sourceErrors, name, result.reason);
    }
  }

  const owners = new Map();
  for (const m of mappings.filter((x) => x.type === 'github')) {
    const key = `${m.connection}:${m.namespace}`;
    if (!owners.has(key)) owners.set(key, { connection: m.connection, namespace: m.namespace, sources: new Set() });
    owners.get(key).sources.add(m.source);
  }
  for (const owner of owners.values()) {
    const connection = connections[owner.connection];
    let result;
    try {
      result = await githubDest.check(connection, owner.namespace);
    } catch (err) {
      result = { ok: false, reason: `could not check "${owner.namespace}" on ${connection.host}: ${err.message}` };
    }
    namespaceChecks.push({ connection: owner.connection, namespace: owner.namespace, kind: result.kind ?? 'github', ...result });
    if (!result.ok) {
      for (const name of owner.sources) addSourceError(sourceErrors, name, result.reason);
    }
  }

  const roots = new Map();
  for (const m of mappings.filter((x) => x.type === 'gitlab')) {
    const key = `${m.connection}:${m.namespace}`;
    if (!roots.has(key)) roots.set(key, { connection: m.connection, namespace: m.namespace, sources: new Set(), mappings: [] });
    const entry = roots.get(key);
    entry.sources.add(m.source);
    entry.mappings.push(m);
  }

  for (const root of roots.values()) {
    const connection = connections[root.connection];
    const resolver = resolverFor(root.connection);
    let namespace;
    try {
      namespace = await resolver.root(root.namespace);
    } catch (err) {
      for (const s of root.sources) addSourceError(sourceErrors, s, `could not resolve destination namespace "${root.namespace}" on ${connection.host}: ${err.message}`);
      continue;
    }

    if (!namespace) {
      let me = null;
      try {
        me = await gitlab.whoami(connection);
      } catch {
      }

      if (root.mappings.every((m) => m.createRootNamespace)) {
        if (me && me.canCreateGroup === false) {
          for (const s of root.sources) {
            addSourceError(
              sourceErrors,
              s,
              `"${root.namespace}" does not exist on ${connection.host} and create_root_namespace is set, ` +
                `but the token owner "${me.login}" is not allowed to create top-level groups on that instance.`,
            );
          }
          continue;
        }
        namespaceChecks.push({
          connection: root.connection,
          namespace: root.namespace,
          kind: 'group',
          ok: true,
          willCreate: true,
        });
        continue;
      }

      const owner = me?.login ?? null;
      for (const s of root.sources) {
        addSourceError(
          sourceErrors,
          s,
          `destination namespace "${root.namespace}" was not found on ${connection.host} ` +
            `using connection "${root.connection}"${owner ? ` (token owner: ${owner})` : ''}. ` +
            'Either it does not exist, or it exists but this token cannot see it. ' +
            'Either create it, grant this token access, set `create_root_namespace: true` on the ' +
            'destination, or fix `destination.namespace`.',
        );
      }
      continue;
    }

    if (namespace.kind === 'user') {
      const offenders = root.mappings.filter((m) => m.subgroups.length > 0);
      if (offenders.length) {
        const bySource = new Map();
        for (const m of offenders) {
          if (!bySource.has(m.source)) bySource.set(m.source, []);
          bySource.get(m.source).push(m);
        }
        for (const [sourceName, list] of bySource) {
          addSourceError(
            sourceErrors,
            sourceName,
            `"${root.namespace}" on ${connection.host} is a personal namespace, and GitLab personal namespaces ` +
              `cannot contain subgroups. ${list.length} repositor${list.length === 1 ? 'y needs' : 'ies need'} one, ` +
              `for example ${list[0].repo.fullPath} -> ${list[0].path}. ` +
              'Use `structure: flatten` or `structure: template` for this destination.',
          );
        }
      }
    }

    let access;
    try {
      access = await gitlab.canWriteNamespace(connection, namespace);
    } catch (err) {
      access = { ok: false, reason: `could not check access to "${root.namespace}": ${err.message}` };
    }
    namespaceChecks.push({ connection: root.connection, namespace: root.namespace, kind: namespace.kind, ...access });
    if (!access.ok) {
      for (const s of root.sources) addSourceError(sourceErrors, s, access.reason);
    }
  }

  return { fatal, sourceErrors, resolvers, namespaceChecks, collisions, selfMirrors, keyChecks };
}

function addSourceError(map, sourceName, message) {
  if (!map.has(sourceName)) map.set(sourceName, []);
  map.get(sourceName).push(message);
}
