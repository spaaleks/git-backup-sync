import { mkdir, rm, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { runGit, pushMirror } from '../mirror.js';

export const kind = 'directory';

export function targetPath(mapping) {
  return path.join(mapping.root, mapping.path);
}

export async function check(mapping) {
  const root = mapping.root;
  try {
    const info = await stat(root);
    if (!info.isDirectory()) return { ok: false, reason: `destination path "${root}" is not a directory` };
  } catch (err) {
    if (err.code !== 'ENOENT') return { ok: false, reason: `destination path "${root}" is not usable: ${err.message}` };
    try {
      await mkdir(root, { recursive: true });
    } catch (mkErr) {
      return { ok: false, reason: `cannot create destination path "${root}": ${mkErr.message}` };
    }
  }
  return { ok: true };
}

export async function ensureTarget(mapping, { env, timeoutMs }) {
  const target = mapping.format === 'bare' ? `${targetPath(mapping)}.git` : targetPath(mapping);
  await mkdir(path.dirname(target), { recursive: true });

  let created = false;
  if (mapping.format === 'bare') {
    if (!(await exists(path.join(target, 'HEAD')))) {
      await runGit(['init', '--bare', '--quiet', target], { env, timeoutMs });
      created = true;
    }
  }
  return { target, created, url: target };
}

export async function deliver(mapping, { mirrorDir, target, env, timeoutMs, defaultBranch, pushMode }) {
  if (mapping.format === 'bare') {
    await pushMirror(mirrorDir, target, env, timeoutMs, pushMode);
    // Without this HEAD keeps whatever `git init --bare` chose, and cloning the
    // backup checks out a branch that does not exist: an empty working tree.
    if (defaultBranch) {
      const ref = `refs/heads/${defaultBranch}`;
      const { stdout } = await runGit(['--git-dir', target, 'for-each-ref', '--format=%(refname)', ref], { env, timeoutMs });
      if (stdout.trim() === ref) {
        await runGit(['--git-dir', target, 'symbolic-ref', 'HEAD', ref], { env, timeoutMs });
      }
    }
    return;
  }

  const branch = defaultBranch;
  if (!branch) return;

  if (!(await exists(path.join(target, '.git')))) {
    await rm(target, { recursive: true, force: true });
    await runGit(['clone', '--no-hardlinks', '--branch', branch, mirrorDir, target], { env, timeoutMs });
    return;
  }

  await runGit(['remote', 'set-url', 'origin', mirrorDir], { cwd: target, env, timeoutMs });
  await runGit(['fetch', '--prune', '--quiet', 'origin'], { cwd: target, env, timeoutMs });
  await runGit(['checkout', '--quiet', '-B', branch, `origin/${branch}`], { cwd: target, env, timeoutMs });
  await runGit(['reset', '--hard', '--quiet', `origin/${branch}`], { cwd: target, env, timeoutMs });
  await runGit(['clean', '-qfd'], { cwd: target, env, timeoutMs });
}

export function verifiable(mapping) {
  return mapping.format === 'bare';
}

export async function archive(target) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const to = `${target}.archived-${stamp}`;
  await rename(target, to);
  return to;
}

export async function remove(target) {
  await rm(target, { recursive: true, force: true });
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
