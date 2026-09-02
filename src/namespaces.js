import * as gitlab from './providers/gitlab.js';
import { log } from './logger.js';

export class NamespaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NamespaceError';
  }
}

export class NamespaceResolver {
  constructor(connection, { dryRun = false } = {}) {
    this.connection = connection;
    this.dryRun = dryRun;
    // These cache the in-flight promise, not the result: concurrent repositories
    // wanting the same missing group must produce one POST, not thirty.
    this.roots = new Map();
    this.rootCreation = new Map();
    this.groups = new Map();
    this.created = [];
    this.wouldCreate = new Set();
    this.claimed = new Set();
  }

  root(path) {
    let pending = this.roots.get(path);
    if (!pending) {
      pending = gitlab.getNamespace(this.connection, path);
      this.roots.set(path, pending);
      pending.catch(() => this.roots.delete(path));
    }
    return pending;
  }

  group(path) {
    const pending = this.groups.get(path);
    if (pending) return pending;
    return gitlab.getGroup(this.connection, path).then((g) => (g ? { id: g.id, kind: 'group', fullPath: g.fullPath } : null));
  }

  async ensure(rootPath, subgroups, { visibility, autoCreate, createRoot = false }) {
    let root = await this.root(rootPath);

    if (!root && createRoot) root = await this.#createRootGroup(rootPath, visibility);

    if (!root) {
      throw new NamespaceError(
        `destination namespace "${rootPath}" does not exist on ${this.connection.host}. ` +
          'Root namespaces are not created unless `create_root_namespace: true` is set on the ' +
          'destination, because auto-creating a top-level group from a typo leaves debris. ' +
          'Create the group, or set that option.',
      );
    }

    if (subgroups.length === 0) return { id: root.id, path: rootPath, kind: root.kind, created: [] };

    if (root.kind === 'user') {
      throw new NamespaceError(
        `"${rootPath}" on ${this.connection.host} is a personal namespace, and GitLab personal namespaces cannot ` +
          `contain subgroups. The mapping needs "${rootPath}/${subgroups.join('/')}". ` +
          'Use `structure: flatten` or `structure: template` for this destination.',
      );
    }

    let parentId = root.id;
    let current = rootPath;
    const created = [];

    for (const segment of subgroups) {
      current = `${current}/${segment}`;
      const group = await this.#ensureGroup(current, segment, parentId, { visibility, autoCreate });
      if (group.createdPath && !this.claimed.has(group.createdPath)) {
        this.claimed.add(group.createdPath);
        created.push(group.createdPath);
      }
      parentId = group.id;
    }

    return { id: parentId, path: current, kind: 'group', created };
  }

  #createRootGroup(rootPath, visibility) {
    let pending = this.rootCreation.get(rootPath);
    if (pending) return pending;

    pending = (async () => {
      if (this.dryRun) {
        this.wouldCreate.add(rootPath);
        return { id: null, kind: 'group', fullPath: rootPath, planned: true };
      }
      const made = await gitlab.createGroup(this.connection, {
        name: rootPath,
        path: rootPath,
        parentId: null,
        visibility,
      });
      const value = { id: made.id, kind: 'group', fullPath: made.fullPath };
      this.roots.set(rootPath, Promise.resolve(value));
      this.created.push(rootPath);
      log.info('created top-level destination group', { connection: this.connection.name, group: rootPath });
      return value;
    })();

    this.rootCreation.set(rootPath, pending);
    pending.catch(() => this.rootCreation.delete(rootPath));
    return pending;
  }

  #ensureGroup(fullPath, segment, parentId, { visibility, autoCreate }) {
    let pending = this.groups.get(fullPath);
    if (pending) return pending;

    pending = (async () => {
      const existing = await gitlab.getGroup(this.connection, fullPath);
      if (existing) return { id: existing.id, kind: 'group', fullPath, createdPath: null };

      if (!autoCreate) {
        throw new NamespaceError(`destination group "${fullPath}" does not exist and auto_create_namespaces is false`);
      }
      if (this.dryRun) {
        this.wouldCreate.add(fullPath);
        return { id: null, kind: 'group', fullPath, createdPath: null, planned: true };
      }

      const made = await gitlab.createGroup(this.connection, { name: segment, path: segment, parentId, visibility });
      this.created.push(fullPath);
      log.info('created destination group', { connection: this.connection.name, group: fullPath });
      return { id: made.id, kind: 'group', fullPath, createdPath: fullPath };
    })();

    this.groups.set(fullPath, pending);
    pending.catch(() => this.groups.delete(fullPath));
    return pending;
  }
}
