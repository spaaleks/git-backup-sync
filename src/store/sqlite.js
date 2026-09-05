import { DatabaseSync } from 'node:sqlite';
import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS source (
  name        TEXT PRIMARY KEY,
  connection  TEXT,
  last_run_at TEXT,
  last_error  TEXT
);

CREATE TABLE IF NOT EXISTS repo (
  source_name          TEXT    NOT NULL REFERENCES source(name) ON DELETE CASCADE,
  full_path            TEXT    NOT NULL,
  destination          TEXT,
  refs_json            TEXT    NOT NULL DEFAULT '{}',
  wiki_json            TEXT,
  last_success         TEXT,
  last_seen_at         TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  size_bytes           INTEGER NOT NULL DEFAULT 0,
  uses_lfs             INTEGER NOT NULL DEFAULT 0,
  created_by_service   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_name, full_path)
);

CREATE TABLE IF NOT EXISTS run (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     TEXT,
  duration_ms    INTEGER,
  reason         TEXT,
  dry_run        INTEGER NOT NULL DEFAULT 0,
  changed        INTEGER NOT NULL DEFAULT 0,
  failed         INTEGER NOT NULL DEFAULT 0,
  fatal          TEXT,
  by_source_json TEXT NOT NULL DEFAULT '{}'
);
`;

export class SqliteStore {
  constructor(file) {
    this.file = file;
    this.db = null;
  }

  get describe() {
    return `sqlite at ${this.file}`;
  }

  async open() {
    if (this.file !== ':memory:') await mkdir(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    if (this.file !== ':memory:') await chmod(this.file, 0o600).catch(() => {});
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);

    const found = this.#meta('schema_version');
    if (found === null) this.#setMeta('schema_version', String(SCHEMA_VERSION));
    else if (Number(found) > SCHEMA_VERSION) {
      throw new Error(
        `${this.file} was written by a newer schema (version ${found}, this build understands ${SCHEMA_VERSION})`,
      );
    }
    if (this.#meta('started_at') === null) this.#setMeta('started_at', new Date().toISOString());
    return this;
  }

  async readAll() {
    const sources = {};
    for (const row of this.db.prepare('SELECT * FROM source').all()) {
      sources[row.name] = {
        connection: row.connection,
        lastRunAt: row.last_run_at,
        lastError: row.last_error,
        repos: {},
      };
    }
    for (const row of this.db.prepare('SELECT * FROM repo').all()) {
      const source = sources[row.source_name];
      if (source) source.repos[row.full_path] = toRecord(row);
    }
    return {
      startedAt: this.#meta('started_at') ?? new Date().toISOString(),
      lastHeartbeatAt: this.#meta('last_heartbeat_at'),
      sources,
      runs: this.db.prepare('SELECT * FROM run ORDER BY id').all().map(toRun),
    };
  }

  async putSource(name, { connection = null, lastRunAt = null, lastError = null } = {}) {
    this.db
      .prepare(
        `INSERT INTO source (name, connection, last_run_at, last_error) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET connection = excluded.connection,
                                         last_run_at = excluded.last_run_at,
                                         last_error = excluded.last_error`,
      )
      .run(name, connection, lastRunAt, lastError);
  }

  async deleteSource(name) {
    this.db.prepare('DELETE FROM source WHERE name = ?').run(name);
  }

  async putRepo(sourceName, fullPath, record) {
    this.db
      .prepare(
        `INSERT INTO repo (source_name, full_path, destination, refs_json, wiki_json, last_success,
                           last_seen_at, consecutive_failures, last_error, size_bytes, uses_lfs, created_by_service)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_name, full_path) DO UPDATE SET
           destination = excluded.destination,
           refs_json = excluded.refs_json,
           wiki_json = excluded.wiki_json,
           last_success = excluded.last_success,
           last_seen_at = excluded.last_seen_at,
           consecutive_failures = excluded.consecutive_failures,
           last_error = excluded.last_error,
           size_bytes = excluded.size_bytes,
           uses_lfs = excluded.uses_lfs,
           created_by_service = excluded.created_by_service`,
      )
      .run(
        sourceName,
        fullPath,
        record.destination ?? null,
        JSON.stringify(record.refs ?? {}),
        record.wiki ? JSON.stringify(record.wiki) : null,
        record.lastSuccess ?? null,
        record.lastSeenAt ?? null,
        Number(record.consecutiveFailures) || 0,
        record.lastError ?? null,
        Number(record.sizeBytes) || 0,
        record.usesLfs ? 1 : 0,
        record.createdByService ? 1 : 0,
      );
  }

  async deleteRepo(sourceName, fullPath) {
    this.db.prepare('DELETE FROM repo WHERE source_name = ? AND full_path = ?').run(sourceName, fullPath);
  }

  async addRun(entry, { keep = 30 } = {}) {
    this.db
      .prepare(
        `INSERT INTO run (started_at, duration_ms, reason, dry_run, changed, failed, fatal, by_source_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.startedAt ?? null,
        Number(entry.durationMs) || 0,
        entry.reason ?? null,
        entry.dryRun ? 1 : 0,
        Number(entry.changed) || 0,
        Number(entry.failed) || 0,
        entry.fatal ?? null,
        JSON.stringify(entry.bySource ?? {}),
      );
    this.db
      .prepare('DELETE FROM run WHERE id NOT IN (SELECT id FROM run ORDER BY id DESC LIMIT ?)')
      .run(Math.max(1, keep));
  }

  async setHeartbeatAt(at) {
    this.#setMeta('last_heartbeat_at', at);
  }

  async dump() {
    const meta = {};
    for (const row of this.db.prepare('SELECT key, value FROM meta').all()) meta[row.key] = row.value;
    return {
      driver: 'sqlite',
      file: this.file,
      meta,
      source: this.db.prepare('SELECT * FROM source ORDER BY name').all(),
      repo: this.db.prepare('SELECT * FROM repo ORDER BY source_name, full_path').all(),
      run: this.db.prepare('SELECT * FROM run ORDER BY id').all(),
    };
  }

  async close() {
    this.db?.close();
    this.db = null;
  }

  #meta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }

  #setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}

function toRecord(row) {
  return {
    destination: row.destination,
    refs: parseJson(row.refs_json, {}),
    wiki: parseJson(row.wiki_json, null),
    lastSuccess: row.last_success,
    lastSeenAt: row.last_seen_at,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    sizeBytes: row.size_bytes,
    usesLfs: Boolean(row.uses_lfs),
    createdByService: Boolean(row.created_by_service),
  };
}

function toRun(row) {
  return {
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    reason: row.reason,
    dryRun: Boolean(row.dry_run),
    changed: row.changed,
    failed: row.failed,
    fatal: row.fatal,
    bySource: parseJson(row.by_source_json, {}),
  };
}

function parseJson(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
