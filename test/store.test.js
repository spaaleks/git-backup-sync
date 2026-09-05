import test from 'node:test';
import assert from 'node:assert/strict';

import { openState } from '../src/state.js';
import { openLock, LockBusyError } from '../src/lock.js';
import { openStore } from '../src/store/index.js';

const postgres = process.env.TEST_DB_HOST
  ? {
      driver: 'postgres',
      host: process.env.TEST_DB_HOST,
      port: Number(process.env.TEST_DB_PORT || 5432),
      name: process.env.TEST_DB_NAME || 'gbs_test',
      user: process.env.TEST_DB_USER || 'gbs',
      password: process.env.TEST_DB_PASSWORD || '',
      ssl: 'disable',
      pool_max: 4,
    }
  : null;

const drivers = [{ name: 'sqlite', database: { driver: 'sqlite', path: ':memory:' } }];
if (postgres) drivers.push({ name: 'postgres', database: postgres });

async function freshState(database) {
  if (database.driver === 'postgres') {
    const pg = (await import('pg')).default;
    const client = new pg.Client({
      host: database.host,
      port: database.port,
      database: database.name,
      user: database.user,
      password: database.password || undefined,
      ssl: false,
    });
    await client.connect();
    await client.query('DROP TABLE IF EXISTS meta, source, repo, run CASCADE');
    await client.end();
  }
  return openState(database);
}

const RECORD = {
  destination: 'gl:mirror/infra/router',
  refs: { 'refs/heads/main': 'a'.repeat(40), 'refs/tags/v1': 'b'.repeat(40) },
  wiki: { refs: { 'refs/heads/master': 'c'.repeat(40) }, lastSuccess: '2026-01-01T00:00:00.000Z' },
  lastSuccess: '2026-01-02T03:04:05.000Z',
  lastSeenAt: '2026-01-02T03:04:06.000Z',
  consecutiveFailures: 0,
  lastError: null,
  sizeBytes: 8 * 1024 ** 3,
  usesLfs: true,
  createdByService: true,
};

for (const { name, database } of drivers) {
  test(`${name}: a repository record round trips unchanged`, async () => {
    const state = await freshState(database);
    try {
      const source = await state.source('github');
      await source.setConnection('gh');
      await source.putRepo('acme/infra/router', RECORD);

      await state.reload();
      assert.deepEqual(state.sources.github.repos['acme/infra/router'], RECORD);
      assert.equal(state.sources.github.connection, 'gh');
    } finally {
      await state.close();
    }
  });

  test(`${name}: a failure record keeps its error and streak`, async () => {
    const state = await freshState(database);
    try {
      const source = await state.source('github');
      await source.putRepo('acme/legacy', {
        ...RECORD,
        lastSuccess: null,
        consecutiveFailures: 4,
        lastError: 'git push --prune --force exited with 1',
      });

      await state.reload();
      const record = state.sources.github.repos['acme/legacy'];
      assert.equal(record.lastSuccess, null);
      assert.equal(record.consecutiveFailures, 4);
      assert.match(record.lastError, /exited with 1/);
    } finally {
      await state.close();
    }
  });

  test(`${name}: forgetting a source takes its repositories with it`, async () => {
    const state = await freshState(database);
    try {
      const source = await state.source('retired');
      await source.putRepo('old/thing', { destination: 'gl:mirror/thing', refs: {} });

      await state.forgetSource('retired');
      await state.reload();

      assert.equal(state.sources.retired, undefined);
      assert.equal((await state.dump()).repo.length, 0, 'the rows cascade');
    } finally {
      await state.close();
    }
  });

  test(`${name}: runs are trimmed to the retention limit, newest kept`, async () => {
    const state = await freshState(database);
    try {
      for (let i = 1; i <= 5; i++) {
        await state.addRun(
          { startedAt: `2026-01-0${i}T00:00:00.000Z`, durationMs: i, reason: 'test', changed: i, failed: 0 },
          { keep: 3 },
        );
      }
      await state.reload();

      assert.equal(state.runs.length, 3);
      assert.equal(state.runs[0].startedAt, '2026-01-03T00:00:00.000Z');
      assert.equal(state.runs.at(-1).startedAt, '2026-01-05T00:00:00.000Z');
      assert.equal(state.runs.at(-1).changed, 5);
    } finally {
      await state.close();
    }
  });

  test(`${name}: opening an existing store keeps what is there`, async () => {
    const state = await freshState(database);
    try {
      await (await state.source('github')).putRepo('a/b', RECORD);
      await state.heartbeatSent('2026-01-01T08:00:00.000Z');

      if (database.driver === 'sqlite') {
        assert.equal(state.lastHeartbeatAt, '2026-01-01T08:00:00.000Z');
        return;
      }

      const again = await openState(database);
      assert.equal(again.lastHeartbeatAt, '2026-01-01T08:00:00.000Z');
      assert.ok(again.sources.github.repos['a/b'], 'the schema is created once, not clobbered');
      await again.close();
    } finally {
      await state.close();
    }
  });
}

test('sqlite: the lock is the file in data_dir', async () => {
  const lock = await openLock({ database: { driver: 'sqlite' }, data_dir: '/tmp/gbs-lock-test' });
  assert.match(lock.describe, /\/tmp\/gbs-lock-test\/sync\.lock$/);
});

test('an unknown driver is named, not guessed at', async () => {
  await assert.rejects(openStore({ driver: 'mysql' }), /unknown database driver "mysql"/);
});

test('postgres: an advisory lock excludes a second holder', { skip: postgres ? false : 'TEST_DB_HOST is not set' }, async () => {
  const store = await openStore(postgres);
  try {
    const config = { database: postgres, data_dir: '/nonexistent' };
    const first = await openLock(config, store);
    const second = await openLock(config, store);

    const release = await first.acquire();
    await assert.rejects(second.acquire(), LockBusyError);

    const held = await first.inspect();
    assert.equal(held.present, true);
    assert.equal(held.stale, false, 'an advisory lock is never stale: it dies with its connection');

    await release();
    const free = await second.acquire();
    await free();

    assert.equal((await first.inspect()).present, false);
  } finally {
    await store.close();
  }
});
