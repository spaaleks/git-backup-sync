import { readFile } from 'node:fs/promises';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   text PRIMARY KEY,
  value text
);

CREATE TABLE IF NOT EXISTS source (
  name        text PRIMARY KEY,
  connection  text,
  last_run_at timestamptz,
  last_error  text
);

CREATE TABLE IF NOT EXISTS repo (
  source_name          text        NOT NULL REFERENCES source(name) ON DELETE CASCADE,
  full_path            text        NOT NULL,
  destination          text,
  refs_json            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  wiki_json            jsonb,
  last_success         timestamptz,
  last_seen_at         timestamptz,
  consecutive_failures integer     NOT NULL DEFAULT 0,
  last_error           text,
  size_bytes           bigint      NOT NULL DEFAULT 0,
  uses_lfs             boolean     NOT NULL DEFAULT false,
  created_by_service   boolean     NOT NULL DEFAULT false,
  PRIMARY KEY (source_name, full_path)
);

CREATE TABLE IF NOT EXISTS run (
  id             bigserial PRIMARY KEY,
  started_at     timestamptz,
  duration_ms    integer   NOT NULL DEFAULT 0,
  reason         text,
  dry_run        boolean   NOT NULL DEFAULT false,
  changed        integer   NOT NULL DEFAULT 0,
  failed         integer   NOT NULL DEFAULT 0,
  fatal          text,
  by_source_json jsonb     NOT NULL DEFAULT '{}'::jsonb
);
`;

export class PostgresStore {
  constructor(database) {
    this.database = database;
    this.pool = null;
  }

  get describe() {
    const { user, host, port, name } = this.database;
    return `postgres at ${user}@${host}:${port}/${name}`;
  }

  async open() {
    const { Pool } = (await import('pg')).default;
    this.pool = new Pool({
      host: this.database.host,
      port: this.database.port,
      database: this.database.name,
      user: this.database.user,
      password: this.database.password || undefined,
      max: this.database.pool_max,
      ssl: await sslOptions(this.database),
      application_name: 'git-backup-sync',
    });

    await this.pool.query(SCHEMA);

    const found = await this.#meta('schema_version');
    if (found === null) await this.#setMeta('schema_version', String(SCHEMA_VERSION));
    else if (Number(found) > SCHEMA_VERSION) {
      throw new Error(
        `${this.database.name} was written by a newer schema (version ${found}, this build understands ${SCHEMA_VERSION})`,
      );
    }
    if ((await this.#meta('started_at')) === null) await this.#setMeta('started_at', new Date().toISOString());
    return this;
  }

  async readAll() {
    const sources = {};
    const { rows: sourceRows } = await this.pool.query('SELECT * FROM source');
    for (const row of sourceRows) {
      sources[row.name] = {
        connection: row.connection,
        lastRunAt: iso(row.last_run_at),
        lastError: row.last_error,
        repos: {},
      };
    }
    const { rows: repoRows } = await this.pool.query('SELECT * FROM repo');
    for (const row of repoRows) {
      const source = sources[row.source_name];
      if (source) source.repos[row.full_path] = toRecord(row);
    }
    const { rows: runRows } = await this.pool.query('SELECT * FROM run ORDER BY id');
    return {
      startedAt: (await this.#meta('started_at')) ?? new Date().toISOString(),
      lastHeartbeatAt: await this.#meta('last_heartbeat_at'),
      sources,
      runs: runRows.map(toRun),
    };
  }

  async putSource(name, { connection = null, lastRunAt = null, lastError = null } = {}) {
    await this.pool.query(
      `INSERT INTO source (name, connection, last_run_at, last_error) VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET connection = excluded.connection,
                                        last_run_at = excluded.last_run_at,
                                        last_error = excluded.last_error`,
      [name, connection, lastRunAt, lastError],
    );
  }

  async deleteSource(name) {
    await this.pool.query('DELETE FROM source WHERE name = $1', [name]);
  }

  async putRepo(sourceName, fullPath, record) {
    await this.pool.query(
      `INSERT INTO repo (source_name, full_path, destination, refs_json, wiki_json, last_success,
                         last_seen_at, consecutive_failures, last_error, size_bytes, uses_lfs, created_by_service)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (source_name, full_path) DO UPDATE SET
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
      [
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
        Boolean(record.usesLfs),
        Boolean(record.createdByService),
      ],
    );
  }

  async deleteRepo(sourceName, fullPath) {
    await this.pool.query('DELETE FROM repo WHERE source_name = $1 AND full_path = $2', [sourceName, fullPath]);
  }

  async addRun(entry, { keep = 30 } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO run (started_at, duration_ms, reason, dry_run, changed, failed, fatal, by_source_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.startedAt ?? null,
          Number(entry.durationMs) || 0,
          entry.reason ?? null,
          Boolean(entry.dryRun),
          Number(entry.changed) || 0,
          Number(entry.failed) || 0,
          entry.fatal ?? null,
          JSON.stringify(entry.bySource ?? {}),
        ],
      );
      await client.query('DELETE FROM run WHERE id NOT IN (SELECT id FROM run ORDER BY id DESC LIMIT $1)', [
        Math.max(1, keep),
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async setHeartbeatAt(at) {
    await this.#setMeta('last_heartbeat_at', at);
  }

  async dump() {
    const meta = {};
    const { rows } = await this.pool.query('SELECT key, value FROM meta');
    for (const row of rows) meta[row.key] = row.value;
    return {
      driver: 'postgres',
      database: `${this.database.host}:${this.database.port}/${this.database.name}`,
      meta,
      source: (await this.pool.query('SELECT * FROM source ORDER BY name')).rows,
      repo: (await this.pool.query('SELECT * FROM repo ORDER BY source_name, full_path')).rows.map((row) => ({
        ...row,
        size_bytes: Number(row.size_bytes),
      })),
      run: (await this.pool.query('SELECT * FROM run ORDER BY id')).rows.map((row) => ({
        ...row,
        id: Number(row.id),
      })),
    };
  }

  async close() {
    await this.pool?.end();
    this.pool = null;
  }

  async #meta(key) {
    const { rows } = await this.pool.query('SELECT value FROM meta WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  }

  async #setMeta(key, value) {
    await this.pool.query(
      'INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  }
}

// libpq semantics: `require` encrypts without proving who is on the other end,
// `verify-full` is the one that authenticates the server.
async function sslOptions({ ssl, ssl_ca: caPath, host }) {
  if (ssl === 'disable') return false;
  if (ssl === 'verify-full') {
    return {
      rejectUnauthorized: true,
      servername: host,
      ...(caPath ? { ca: await readFile(caPath, 'utf8') } : {}),
    };
  }
  return { rejectUnauthorized: false };
}

function toRecord(row) {
  return {
    destination: row.destination,
    refs: row.refs_json ?? {},
    wiki: row.wiki_json ?? null,
    lastSuccess: iso(row.last_success),
    lastSeenAt: iso(row.last_seen_at),
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    sizeBytes: Number(row.size_bytes),
    usesLfs: row.uses_lfs,
    createdByService: row.created_by_service,
  };
}

function toRun(row) {
  return {
    startedAt: iso(row.started_at),
    durationMs: row.duration_ms,
    reason: row.reason,
    dryRun: row.dry_run,
    changed: row.changed,
    failed: row.failed,
    fatal: row.fatal,
    bySource: row.by_source_json ?? {},
  };
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : (value ?? null);
}
