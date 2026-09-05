import { SqliteStore } from './sqlite.js';

export { SqliteStore } from './sqlite.js';

export async function openStore(database) {
  const store = await build(database);
  try {
    return await store.open();
  } catch (err) {
    throw new Error(`cannot open the state store (${store.describe}): ${err.message}`, { cause: err });
  }
}

async function build(database) {
  if (database.driver === 'sqlite') return new SqliteStore(database.path);
  if (database.driver === 'postgres') {
    const { PostgresStore } = await import('./postgres.js');
    return new PostgresStore(database);
  }
  throw new Error(`unknown database driver "${database.driver}"`);
}
