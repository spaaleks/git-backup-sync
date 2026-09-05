#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../src/config/load.js';
import { openState } from '../../../src/state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = await loadConfig({ path: path.join(here, 'config.yml') });
const seed = JSON.parse(await readFile(path.join(here, 'seed.json'), 'utf8'));
const state = await openState(config.database);

for (const [name, source] of Object.entries(seed.sources)) {
  const st = await state.source(name);
  await st.setConnection(source.connection);
  for (const [fullPath, record] of Object.entries(source.repos)) await st.putRepo(fullPath, record);
  await st.finished(source.lastRunAt);
}
for (const run of seed.runs) await state.addRun(run, { keep: seed.runs.length });
if (seed.lastHeartbeatAt) await state.heartbeatSent(seed.lastHeartbeatAt);
await state.close();

process.stdout.write(`seeded ${config.database.path}\n`);
