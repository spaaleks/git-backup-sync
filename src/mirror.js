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

export function gitContext(connection, { timeoutMs, job }) {
  return { env: gitEnv(connection), timeoutMs, registry: job?.git ?? null };
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
        reject(
          new GitError(`git ${args[0]} timed out after ${limit}`, { stderr: stderr.trim(), args }),
        );
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

export async function pushMirror(dir, destUrl, git, mode = 'refspecs') {
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
