import { openStore } from './store/index.js';

export class SourceState {
  #store;
  #name;

  constructor(store, name, data = {}) {
    this.#store = store;
    this.#name = name;
    this.connection = data.connection ?? null;
    this.lastRunAt = data.lastRunAt ?? null;
    this.lastError = data.lastError ?? null;
    this.repos = data.repos ?? {};
  }

  async putRepo(fullPath, record) {
    this.repos[fullPath] = record;
    await this.#store.putRepo(this.#name, fullPath, record);
  }

  async deleteRepo(fullPath) {
    delete this.repos[fullPath];
    await this.#store.deleteRepo(this.#name, fullPath);
  }

  async setConnection(connection) {
    this.connection = connection ?? null;
    await this.#persist();
  }

  async setError(message) {
    this.lastError = message ?? null;
    await this.#persist();
  }

  async finished(at = new Date().toISOString()) {
    this.lastRunAt = at;
    this.lastError = null;
    await this.#persist();
  }

  #persist() {
    return this.#store.putSource(this.#name, {
      connection: this.connection,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
    });
  }
}

export class State {
  #store;

  constructor(store, data = {}) {
    this.#store = store;
    this.#hydrate(data);
  }

  get store() {
    return this.#store;
  }

  async reload() {
    this.#hydrate(await this.#store.readAll());
    return this;
  }

  #hydrate(data) {
    this.startedAt = data.startedAt ?? new Date().toISOString();
    this.lastHeartbeatAt = data.lastHeartbeatAt ?? null;
    this.runs = data.runs ?? [];
    this.sources = {};
    for (const [name, source] of Object.entries(data.sources ?? {})) {
      this.sources[name] = new SourceState(this.#store, name, source);
    }
  }

  async source(name) {
    if (!this.sources[name]) {
      this.sources[name] = new SourceState(this.#store, name);
      await this.#store.putSource(name, {});
    }
    return this.sources[name];
  }

  async forgetSource(name) {
    delete this.sources[name];
    await this.#store.deleteSource(name);
  }

  async addRun(entry, { keep = 30 } = {}) {
    this.runs.push(entry);
    this.runs = this.runs.slice(-keep);
    await this.#store.addRun(entry, { keep });
  }

  async heartbeatSent(at = new Date().toISOString()) {
    this.lastHeartbeatAt = at;
    await this.#store.setHeartbeatAt(at);
  }

  dump() {
    return this.#store.dump();
  }

  close() {
    return this.#store.close();
  }
}

export async function openState(database) {
  const store = await openStore(database);
  return new State(store, await store.readAll());
}

export function memoryState() {
  return openState({ driver: 'sqlite', path: ':memory:' });
}

export function orphanedSources(state, config) {
  const configured = new Set(config.sources.map((s) => s.name));
  return Object.entries(state.sources)
    .filter(([name]) => !configured.has(name))
    .map(([name, source]) => ({
      name,
      repos: Object.keys(source.repos || {}).length,
      lastRunAt: source.lastRunAt,
    }));
}
