export class ValidationError extends Error {
  constructor(errors) {
    const list = errors.map((e) => `  ${e.path || '<root>'}: ${e.message}`).join('\n');
    super(`configuration is invalid:\n${list}`);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

export const S = {
  string: (opts = {}) => ({ type: 'string', ...opts }),
  number: (opts = {}) => ({ type: 'number', ...opts }),
  boolean: (opts = {}) => ({ type: 'boolean', ...opts }),
  array: (items, opts = {}) => ({ type: 'array', items, ...opts }),
  object: (props, opts = {}) => ({ type: 'object', props, ...opts }),
  record: (values, opts = {}) => ({ type: 'record', values, ...opts }),
  any: (opts = {}) => ({ type: 'any', ...opts }),
  listOf: (items, opts = {}) => ({ type: 'list-of', items, ...opts }),
  union: (variants, opts = {}) => ({ type: 'union', variants, ...opts }),
};

function fail(errors, path, message) {
  errors.push({ path, message });
  return undefined;
}

function validateNode(node, schema, path, errors) {
  if (node === null || node === undefined) {
    if (schema.type === 'object' && schema.default !== undefined) {
      return validateNode(schema.default, { ...schema, default: undefined }, path, errors);
    }
    if (schema.default !== undefined) return structuredClone(schema.default);
    if (schema.nullable) return null;
    return undefined;
  }

  switch (schema.type) {
    case 'any':
      return node;

    case 'string': {
      if (typeof node !== 'string') {
        if (typeof node === 'number' || typeof node === 'boolean') node = String(node);
        else return fail(errors, path, `expected a string, got ${describe(node)}`);
      }
      if (schema.enum && !schema.enum.includes(node)) {
        return fail(errors, path, `must be one of ${schema.enum.join(', ')} (got ${JSON.stringify(node)})`);
      }
      if (schema.pattern && !schema.pattern.test(node)) {
        return fail(errors, path, schema.patternMessage || `does not match ${schema.pattern}`);
      }
      if (schema.nonEmpty && node.trim() === '') {
        return fail(errors, path, 'must not be empty');
      }
      if (schema.regex) {
        try {
          new RegExp(node);
        } catch (err) {
          return fail(errors, path, `is not a valid regular expression: ${err.message}`);
        }
      }
      return node;
    }

    case 'number': {
      let n = node;
      if (typeof n === 'string') {
        if (n.trim() === '' || Number.isNaN(Number(n))) {
          return fail(errors, path, `expected a number, got ${JSON.stringify(node)}`);
        }
        n = Number(n);
      }
      if (typeof n !== 'number' || Number.isNaN(n)) {
        return fail(errors, path, `expected a number, got ${describe(node)}`);
      }
      if (schema.integer && !Number.isInteger(n)) return fail(errors, path, 'must be a whole number');
      if (schema.min !== undefined && n < schema.min) return fail(errors, path, `must be >= ${schema.min}`);
      if (schema.max !== undefined && n > schema.max) return fail(errors, path, `must be <= ${schema.max}`);
      return n;
    }

    case 'boolean': {
      if (typeof node === 'boolean') return node;
      if (typeof node === 'string') {
        const v = node.trim().toLowerCase();
        if (['true', 'yes', '1', 'on'].includes(v)) return true;
        if (['false', 'no', '0', 'off'].includes(v)) return false;
      }
      return fail(errors, path, `expected true or false, got ${describe(node)}`);
    }

    case 'array': {
      if (!Array.isArray(node)) return fail(errors, path, `expected a list, got ${describe(node)}`);
      if (schema.minItems && node.length < schema.minItems) {
        return fail(errors, path, `needs at least ${schema.minItems} item(s)`);
      }
      return node.map((item, i) => validateNode(item, schema.items, `${path}[${i}]`, errors));
    }

    case 'list-of': {
      const items = Array.isArray(node) ? node : [node];
      return items.map((item, i) =>
        validateNode(item, schema.items, Array.isArray(node) ? `${path}[${i}]` : path, errors),
      );
    }

    case 'union': {
      const attempts = [];
      for (const variant of schema.variants) {
        const errors = [];
        const value = validateNode(node, variant, path, errors);
        if (errors.length === 0) return value;
        attempts.push(errors);
      }
      return fail(errors, path, `does not match any accepted shape (${attempts[0][0]?.message ?? 'unknown'})`);
    }

    case 'record': {
      if (!isPlainObject(node)) return fail(errors, path, `expected a mapping, got ${describe(node)}`);
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = validateNode(v, schema.values, `${path ? path + '.' : ''}${k}`, errors);
      }
      if (schema.minEntries && Object.keys(out).length < schema.minEntries) {
        fail(errors, path, `needs at least ${schema.minEntries} entr(y|ies)`);
      }
      return out;
    }

    case 'object': {
      if (!isPlainObject(node)) return fail(errors, path, `expected a mapping, got ${describe(node)}`);
      const out = {};
      const known = new Set(Object.keys(schema.props));

      for (const key of Object.keys(node)) {
        if (!known.has(key)) {
          const suggestion = nearest(key, [...known]);
          fail(
            errors,
            `${path ? path + '.' : ''}${key}`,
            `unknown key${suggestion ? `, did you mean "${suggestion}"?` : ''}`,
          );
        }
      }

      for (const [key, sub] of Object.entries(schema.props)) {
        const childPath = `${path ? path + '.' : ''}${key}`;
        const raw = node[key];
        if (raw === undefined || raw === null) {
          if (sub.required) {
            fail(errors, childPath, 'is required');
            continue;
          }
          if (sub.default !== undefined) out[key] = validateNode(sub.default, { ...sub, default: undefined }, childPath, errors);
          else if (raw === null && sub.nullable) out[key] = null;
          continue;
        }
        const value = validateNode(raw, sub, childPath, errors);
        if (value !== undefined) out[key] = value;
      }
      return out;
    }

    default:
      throw new Error(`internal: unknown schema type ${schema.type}`);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  return typeof v === 'object' ? 'a mapping' : `${typeof v} ${JSON.stringify(v)}`;
}

function nearest(word, candidates) {
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = distance(word, c);
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  return bestScore <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export function validate(doc, schema) {
  const errors = [];
  const value = validateNode(doc, schema, '', errors);
  if (errors.length) throw new ValidationError(errors);
  return value;
}
