import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { log } from './logger.js';

export const STATE_VERSION = 3;

export function emptyState() {
  return {
    version: STATE_VERSION,
    sources: {},
    runs: [],
    lastHeartbeatAt: null,
    startedAt: new Date().toISOString(),
  };
}

export function statePath(dataDir) {
  return path.join(dataDir, 'state.json');
}

export async function loadState(dataDir) {
  const file = statePath(dataDir);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn('state file could not be read, treating every repository as new', { file, error: err.message });
    } else {
      log.info('no state file yet, this is a first run', { file });
    }
    return emptyState();
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    log.warn('state file is corrupt, treating every repository as new', { file, error: err.message });
    await quarantine(file).catch(() => {});
    return emptyState();
  }

  return migrate(parsed);
}

export function migrate(state) {
  if (!state || typeof state !== 'object') return emptyState();

  const version = Number(state.version) || 1;
  if (version > STATE_VERSION) {
    log.warn('state file was written by a newer version, using it as-is', { version });
  }

  const out = {
    version: STATE_VERSION,
    sources: {},
    runs: Array.isArray(state.runs) ? state.runs : [],
    lastHeartbeatAt: state.lastHeartbeatAt ?? null,
    startedAt: state.startedAt ?? new Date().toISOString(),
  };

  if (version < 3 && state.repos && !state.sources) {
    out.sources.legacy = {
      connection: null,
      repos: normalizeRepos(state.repos),
      lastRunAt: state.lastRunAt ?? null,
    };
    log.warn('migrated a pre-v3 state file; repositories are filed under the source name "legacy"', {
      from: version,
      to: STATE_VERSION,
    });
    return out;
  }

  for (const [name, source] of Object.entries(state.sources || {})) {
    out.sources[name] = {
      connection: source?.connection ?? null,
      repos: normalizeRepos(source?.repos),
      lastRunAt: source?.lastRunAt ?? null,
      lastError: source?.lastError ?? null,
    };
  }
  return out;
}

function normalizeRepos(repos) {
  const out = {};
  for (const [fullPath, entry] of Object.entries(repos || {})) {
    if (!entry || typeof entry !== 'object') continue;
    out[fullPath] = {
      destination: entry.destination ?? null,
      refs: entry.refs && typeof entry.refs === 'object' ? entry.refs : {},
      wiki: entry.wiki ?? null,
      lastSuccess: entry.lastSuccess ?? null,
      lastSeenAt: entry.lastSeenAt ?? null,
      consecutiveFailures: Number(entry.consecutiveFailures) || 0,
      lastError: entry.lastError ?? null,
      sizeBytes: Number(entry.sizeBytes) || 0,
      usesLfs: Boolean(entry.usesLfs),
    };
  }
  return out;
}

export async function saveState(dataDir, state, { keepRuns = 30 } = {}) {
  const file = statePath(dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  const trimmed = { ...state, runs: (state.runs || []).slice(-keepRuns) };
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(trimmed, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}

async function quarantine(file) {
  const target = `${file}.corrupt-${Date.now()}`;
  await rename(file, target);
  log.warn('corrupt state file kept for inspection', { file: target });
}

export function sourceState(state, name) {
  state.sources[name] ??= { connection: null, repos: {}, lastRunAt: null, lastError: null };
  return state.sources[name];
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
