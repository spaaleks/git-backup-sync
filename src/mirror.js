import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';

export class GitError extends Error {
  constructor(message, { stderr, code, signal, args } = {}) {
    super(message);
    this.name = 'GitError';
    this.stderr = stderr;
    this.code = code;
    this.signal = signal;
    this.args = args;
  }
}

export function gitEnv(connection) {
  return {
    GIT_SSH_COMMAND: connection.gitSshCommand(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
    GIT_CONFIG_NOSYSTEM: '1',
    // Without this a host-level core.hooksPath runs the operator's hooks here.
    GIT_CONFIG_GLOBAL: '/dev/null',
    HOME: process.env.HOME || '/tmp',
    LC_ALL: 'C',
    PATH: process.env.PATH,
  };
}

export class GitRegistry {
  #running = new Set();

  get size() {
    return this.#running.size;
  }

  add(proc) {
    this.#running.add(proc);
  }

  delete(proc) {
    this.#running.delete(proc);
  }

  killAll(signal = 'SIGKILL') {
    const count = this.#running.size;
    for (const proc of this.#running) {
      try {
        process.kill(-proc.pid, signal);
      } catch {
        try {
          proc.kill(signal);
        } catch {
        }
      }
    }
    return count;
  }
}

export function gitContext(connection, { timeoutMs, job, slice = null, log = null }) {
  return { env: gitEnv(connection), timeoutMs, registry: job?.git ?? null, slice, log };
}

export function withTimeout(git, ms) {
  return { ...git, timeoutMs: Math.min(git.timeoutMs, ms) };
}

export function runGit(args, { cwd, env = {}, timeoutMs = 30 * 60_000, input, registry = null } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      env: { ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group, so Ctrl-C on the terminal does not kill transfers.
      detached: true,
    });

    registry?.add(proc);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // The group, not just git: fetch and push delegate to helper processes.
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      stdout += d;
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
    });
    proc.on('error', (err) => {
      registry?.delete(proc);
      clearTimeout(timer);
      reject(new GitError(`failed to run git: ${err.message}`, { args }));
    });
    proc.on('close', (code, signal) => {
      registry?.delete(proc);
      clearTimeout(timer);
      if (timedOut) {
        const limit = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minutes` : `${Math.round(timeoutMs / 1000)}s`;
        const err = new GitError(`git ${args[0]} timed out after ${limit}`, { stderr: stderr.trim(), args });
        err.timedOut = true;
        reject(err);
        return;
      }
      if (code !== 0) {
        const err = new GitError(
          signal
            ? `git ${args[0]} was killed by ${signal}`
            : `git ${args.join(' ')} exited with ${code}`,
          { stderr: stderr.trim(), code, signal, args },
        );
        err.interrupted = signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGHUP';
        reject(err);
        return;
      }
      resolve({ stdout, stderr, code });
    });

    if (input !== undefined) proc.stdin.end(input);
    else proc.stdin.end();
  });
}

export async function isMirror(dir) {
  try {
    const s = await stat(path.join(dir, 'HEAD'));
    return s.isFile();
  } catch {
    return false;
  }
}

export function parseRefs(stdout) {
  const refs = new Map();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    if (sp < 0) continue;
    refs.set(trimmed.slice(0, sp), trimmed.slice(sp + 1));
  }
  return refs;
}

export async function snapshotRefs(dir, git) {
  if (!(await isMirror(dir))) return new Map();
  const { stdout } = await runGit(['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: dir, ...git });
  return parseRefs(stdout);
}

const INTERNAL_REF_PREFIXES = ['refs/pull/', 'refs/merge-requests/', 'refs/keep-around/', 'refs/pipelines/', 'refs/environments/'];

export function isInternalRef(ref) {
  return INTERNAL_REF_PREFIXES.some((p) => ref.startsWith(p));
}

export async function pruneInternalRefs(dir, git) {
  const { stdout } = await runGit(['for-each-ref', '--format=%(refname)'], { cwd: dir, ...git });
  const doomed = stdout.split('\n').map((l) => l.trim()).filter((l) => l && isInternalRef(l));
  if (doomed.length === 0) return 0;
  const input = doomed.map((ref) => `delete ${ref}\n`).join('');
  await runGit(['update-ref', '--stdin'], { cwd: dir, ...git, input });
  return doomed.length;
}

export async function fetchMirror(dir, sshUrl, git) {
  const exists = await isMirror(dir);
  if (!exists) {
    await mkdir(path.dirname(dir), { recursive: true });
    const tmp = `${dir}.tmp-${process.pid}`;
    await rm(tmp, { recursive: true, force: true });
    try {
      await runGit(['clone', '--mirror', '--quiet', sshUrl, tmp], { ...git });
      const { rename } = await import('node:fs/promises');
      await rename(tmp, dir);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    return { cloned: true };
  }

  await runGit(['remote', 'set-url', 'origin', sshUrl], { cwd: dir, ...git });
  await runGit(['remote', 'update', '--prune'], { cwd: dir, ...git });
  return { cloned: false };
}

export function slicePolicy(config) {
  return {
    enabled: config.slice_large_pushes,
    thresholdBytes: config.slice_threshold_mb * 1024 * 1024,
  };
}

const SLICE_FIRST = 8;
const SLICE_SHARE = 0.5;
const SLICE_GROWTH = 4;
const SLICE_HEADS = 25;

async function objectBytes(dir, git) {
  const { stdout } = await runGit(['count-objects', '-v'], { cwd: dir, ...withTimeout(git, 60_000) });
  // count-objects reports KiB, and loose objects are not in size-pack.
  const kib = (key) => Number(new RegExp(`^${key}: (\\d+)$`, 'm').exec(stdout)?.[1] ?? 0);
  return (kib('size') + kib('size-pack')) * 1024;
}

async function countRevs(dir, git, args) {
  const { stdout } = await runGit(['rev-list', '--count', ...args], { cwd: dir, ...withTimeout(git, 10 * 60_000) });
  return Number(stdout.trim()) || 0;
}

async function destinationTips(dir, destUrl, git) {
  const shas = [...new Set((await remoteRefs(destUrl, withTimeout(git, 10 * 60_000))).values())];
  if (!shas.length) return [];

  const { stdout: types } = await runGit(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    cwd: dir,
    ...withTimeout(git, 60_000),
    input: `${shas.join('\n')}\n`,
  });
  return types
    .split('\n')
    .map((l) => l.trim().split(' '))
    .filter(([, type]) => type === 'commit' || type === 'tag')
    .map(([sha]) => sha);
}

export async function planSeed(dir, destUrl, git) {
  const packed = await objectBytes(dir, git);
  if (packed < git.slice.thresholdBytes) return null;

  const not = (await destinationTips(dir, destUrl, git)).map((sha) => `^${sha}`);
  const total = await countRevs(dir, git, ['--branches']);
  const missing = await countRevs(dir, git, ['--branches', ...not]);
  if (!total || missing < 2) return null;

  const bytes = Math.round(packed * (missing / total));
  if (bytes < git.slice.thresholdBytes) return null;

  const { stdout } = await runGit(
    ['for-each-ref', '--sort=-committerdate', '--format=%(objectname) %(refname)', 'refs/heads'],
    { cwd: dir, ...withTimeout(git, 60_000) },
  );
  const parsed = stdout
    .split('\n')
    .map((l) => l.trim().split(' '))
    .filter(([sha, ref]) => sha && ref);

  // HEAD first, so an empty destination gets its default branch rather than
  // whichever branch happens to carry the history.
  const { stdout: head } = await runGit(['symbolic-ref', '--quiet', 'HEAD'], {
    cwd: dir,
    ...withTimeout(git, 60_000),
  }).catch(() => ({ stdout: '' }));
  const isHead = ([, ref]) => ref === head.trim();
  const heads = [...parsed.filter(isHead), ...parsed.filter((h) => !isHead(h))].slice(0, SLICE_HEADS);

  let lead = null;
  for (const [sha, ref] of heads) {
    const ahead = await countRevs(dir, git, [sha, ...not]);
    if (!lead || ahead > lead.ahead) lead = { sha, ref, ahead };
    if (lead.ahead >= missing * 0.9) break;
  }
  if (!lead || lead.ahead < 2) return null;

  const { stdout: list } = await runGit(['rev-list', '--reverse', lead.sha, ...not], {
    cwd: dir,
    ...withTimeout(git, 10 * 60_000),
  });
  const revs = list.split('\n').map((l) => l.trim()).filter(Boolean);
  return revs.length < 2 ? null : { ref: lead.ref, revs, bytes };
}

export async function seedPush(dir, destUrl, git) {
  const plan = await planSeed(dir, destUrl, git);
  if (!plan) return null;

  const { ref, revs } = plan;
  git.log?.info('the destination is far behind, delivering the history in slices first', {
    branch: ref,
    commits: revs.length,
    megabytes: Math.round(plan.bytes / 1024 / 1024),
  });

  const target = git.timeoutMs * SLICE_SHARE;
  const started = Date.now();
  let done = 0;
  let size = Math.max(1, Math.ceil(revs.length / SLICE_FIRST));
  let slices = 0;

  while (done < revs.length) {
    const take = Math.min(size, revs.length - done);
    const at = Date.now();
    try {
      await runGit(['push', '--quiet', destUrl, `${revs[done + take - 1]}:${ref}`], { cwd: dir, ...git });
    } catch (err) {
      if (!err.timedOut) {
        git.log?.warn('slicing stopped, the whole push is attempted instead', {
          branch: ref,
          delivered: done,
          error: err.message,
        });
        break;
      }
      if (take === 1) {
        err.message += `\none commit of ${ref} does not fit in git_timeout_minutes, so no slice can be small enough.`;
        throw err;
      }
      size = Math.floor(take / 2);
      git.log?.debug('a slice timed out, halving it', { branch: ref, commits: size });
      continue;
    }

    done += take;
    slices++;
    const perMs = take / Math.max(Date.now() - at, 1);
    size = Math.max(1, Math.min(Math.round(perMs * target), take * SLICE_GROWTH));
  }

  if (!slices) return null;
  const summary = { branch: ref, slices, commits: done, seconds: Math.round((Date.now() - started) / 1000) };
  git.log?.info('delivered the history in slices, the rest goes in one push', summary);
  return summary;
}

export async function pushMirror(dir, destUrl, git, mode = 'refspecs') {
  if (git.slice?.enabled) {
    // An interrupted push leaves nothing behind, so a repository too big for one
    // timeout never lands. Slices land one at a time and the next run resumes.
    const seeded = await seedPush(dir, destUrl, git);
    if (seeded) git.onSeed?.(seeded);
  }

  const args =
    mode === 'mirror'
      ? ['push', '--mirror', '--quiet', destUrl]
      : [
          'push',
          '--prune',
          '--force',
          '--quiet',
          '--atomic',
          destUrl,
          'refs/heads/*:refs/heads/*',
          'refs/tags/*:refs/tags/*',
          'refs/notes/*:refs/notes/*',
        ];
  const { stderr } = await runGit(args, { cwd: dir, ...git });
  return stderr.trim();
}

export async function detectLfs(dir, git, defaultBranch) {
  const refs = [defaultBranch && `refs/heads/${defaultBranch}`, 'HEAD'].filter(Boolean);
  for (const ref of refs) {
    try {
      const { stdout } = await runGit(['show', `${ref}:.gitattributes`], { cwd: dir, ...withTimeout(git, 60_000) });
      if (/filter=lfs/.test(stdout)) return true;
    } catch {
    }
  }
  return false;
}

export async function transferLfs(dir, sourceUrl, destUrl, sourceGit, destGit) {
  await runGit(['lfs', 'fetch', '--all', sourceUrl], { cwd: dir, ...sourceGit });
  await runGit(['lfs', 'push', '--all', destUrl], { cwd: dir, ...destGit });
}

export async function hasGitLfs() {
  try {
    await runGit(['lfs', 'version'], { timeoutMs: 15_000, env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp' } });
    return true;
  } catch {
    return false;
  }
}

export async function remoteRefs(url, git) {
  const { stdout } = await runGit(['ls-remote', '--heads', '--tags', url], { cwd: undefined, ...git });
  const refs = new Map();
  for (const line of stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) continue;
    if (ref.endsWith('^{}')) continue;
    if (isInternalRef(ref)) continue;
    refs.set(ref, sha);
  }
  return refs;
}

export async function listMirrors(dataDir, sourceName) {
  const root = path.join(dataDir, 'mirrors', sourceName);
  const found = [];
  const walk = async (dir, prefix) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name.endsWith('.git')) {
        const bare = rel.replace(/\.git$/, '');
        found.push({ dir: full, fullPath: bare.replace(/\.wiki$/, ''), wiki: bare.endsWith('.wiki') });
      } else {
        await walk(full, rel);
      }
    }
  };
  await walk(root, '');
  return found;
}

export async function directorySize(dir) {
  let total = 0;
  const walk = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        try {
          total += (await stat(full)).size;
        } catch {
        }
      }
    }
  };
  await walk(dir);
  return total;
}

export function mirrorDir(dataDir, sourceName, fullPath) {
  return path.join(dataDir, 'mirrors', sourceName, `${fullPath}.git`);
}
