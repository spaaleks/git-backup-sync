import { remoteRefs, withTimeout } from '../mirror.js';

export class VerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerificationError';
  }
}

export async function verifyDestination({ destUrl, destGit, expected }) {
  const wanted = new Map(
    [...expected].filter(([ref]) => ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')),
  );
  const actual = await remoteRefs(destUrl, withTimeout(destGit, 120_000));

  const missing = [];
  const wrong = [];
  for (const [ref, sha] of wanted) {
    const there = actual.get(ref);
    if (there === undefined) missing.push(ref);
    else if (there !== sha) wrong.push({ ref, expected: sha, actual: there });
  }
  const extra = [...actual.keys()].filter((ref) => !wanted.has(ref));

  return { ok: missing.length === 0 && wrong.length === 0 && extra.length === 0, checked: wanted.size, missing, wrong, extra };
}

export function describeVerification(v, destination) {
  const parts = [`the destination ${destination} does not match the mirror after pushing (${v.checked} refs checked)`];
  if (v.missing.length) parts.push(`  missing there: ${v.missing.slice(0, 8).join(', ')}${v.missing.length > 8 ? ` and ${v.missing.length - 8} more` : ''}`);
  if (v.wrong.length) {
    for (const w of v.wrong.slice(0, 8)) {
      parts.push(`  ${w.ref}: expected ${w.expected.slice(0, 8)}, found ${w.actual.slice(0, 8)}`);
    }
    if (v.wrong.length > 8) parts.push(`  and ${v.wrong.length - 8} more refs differ`);
  }
  if (v.extra.length) parts.push(`  present there but not in the mirror: ${v.extra.slice(0, 8).join(', ')}`);
  parts.push('  Something on the destination side rejected or altered part of the push. The backup is not a faithful copy until this clears.');
  return parts.join('\n');
}
