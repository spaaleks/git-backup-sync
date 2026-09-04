import { isInternalRef } from './mirror.js';

const CATEGORIES = [
  { key: 'branches', prefix: 'refs/heads/', label: 'branch' },
  { key: 'tags', prefix: 'refs/tags/', label: 'tag' },
  { key: 'notes', prefix: 'refs/notes/', label: 'note ref' },
];

function categoryOf(ref) {
  return CATEGORIES.find((c) => ref.startsWith(c.prefix))?.key ?? 'other';
}

function shortName(ref) {
  const cat = CATEGORIES.find((c) => ref.startsWith(c.prefix));
  return cat ? ref.slice(cat.prefix.length) : ref;
}

export function refsToState(refs) {
  const out = {};
  for (const [ref, sha] of refs) {
    if (isInternalRef(ref)) continue;
    if (categoryOf(ref) === 'other') continue;
    out[ref] = sha;
  }
  return out;
}

export function stateToRefs(obj) {
  return new Map(Object.entries(obj || {}));
}

export function diffRefs(before, after) {
  const changes = {
    branches: { created: [], updated: [], deleted: [] },
    tags: { created: [], updated: [], deleted: [] },
    notes: { created: [], updated: [], deleted: [] },
  };
  let total = 0;

  const relevant = (ref) => !isInternalRef(ref) && categoryOf(ref) !== 'other';

  for (const [ref, sha] of after) {
    if (!relevant(ref)) continue;
    const cat = categoryOf(ref);
    if (!before.has(ref)) {
      changes[cat].created.push({ ref, name: shortName(ref), to: sha });
      total++;
    } else if (before.get(ref) !== sha) {
      changes[cat].updated.push({ ref, name: shortName(ref), from: before.get(ref), to: sha });
      total++;
    }
  }
  for (const [ref, sha] of before) {
    if (!relevant(ref)) continue;
    if (!after.has(ref)) {
      changes[categoryOf(ref)].deleted.push({ ref, name: shortName(ref), from: sha });
      total++;
    }
  }

  return { ...changes, total, changed: total > 0 };
}

const PLURAL = { branches: 'branch', tags: 'tag', notes: 'note ref' };

export function describeChanges(changes) {
  const parts = [];
  for (const cat of ['branches', 'tags', 'notes']) {
    for (const action of ['created', 'updated', 'deleted']) {
      const n = changes[cat]?.[action]?.length ?? 0;
      if (n) parts.push(`${n} ${plural(PLURAL[cat], n)} ${action}`);
    }
  }
  return parts.join(', ') || 'no ref changes';
}

export function listChanges(changes, limit = 12) {
  const lines = [];
  for (const cat of ['branches', 'tags', 'notes']) {
    for (const action of ['created', 'updated', 'deleted']) {
      for (const item of changes[cat]?.[action] ?? []) {
        const shas =
          action === 'updated'
            ? `${short(item.from)}..${short(item.to)}`
            : action === 'created'
              ? short(item.to)
              : short(item.from);
        lines.push(`${PLURAL[cat]} ${action}: ${item.name} (${shas})`);
      }
    }
  }
  if (lines.length > limit) {
    const extra = lines.length - limit;
    return [...lines.slice(0, limit), `... and ${extra} more ref change${extra === 1 ? '' : 's'}`];
  }
  return lines;
}

function short(sha) {
  return sha ? sha.slice(0, 8) : '-';
}

function plural(word, n) {
  if (n === 1) return word;
  return word.endsWith('h') ? `${word}es` : `${word}s`;
}

// Matched by shared commit, never by name: "utils" in two accounts is exactly
// the case that must not be merged.
export function detectMoves(vanished, fresh) {
  const moves = [];
  const usedFresh = new Set();
  const usedVanished = new Set();

  for (const gone of vanished) {
    const goneShas = new Set(Object.values(gone.refs || {}));
    if (goneShas.size === 0) continue;

    for (const arrival of fresh) {
      if (usedFresh.has(arrival)) continue;
      const arrivalShas = Object.values(arrival.refs || {});
      if (arrivalShas.length === 0) continue;
      const overlap = arrivalShas.filter((sha) => goneShas.has(sha));
      if (overlap.length > 0) {
        moves.push({ from: gone, to: arrival, sharedRefs: overlap.length });
        usedFresh.add(arrival);
        usedVanished.add(gone);
        break;
      }
    }
  }

  return {
    moves,
    stillVanished: vanished.filter((v) => !usedVanished.has(v)),
    stillNew: fresh.filter((f) => !usedFresh.has(f)),
  };
}
