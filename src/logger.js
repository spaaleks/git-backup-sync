const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel = LEVELS.info;

let logStream = process.stdout;

export class Redactor {
  #parent;
  #secrets = new Set();
  #sorted = [];

  constructor(parent = null) {
    this.#parent = parent;
  }

  add(value) {
    if (typeof value !== 'string' || value.length < 6) return;
    if (this.#secrets.has(value)) return;
    this.#secrets.add(value);
    this.#sorted = [...this.#secrets].sort((a, b) => b.length - a.length);
  }

  clear() {
    this.#secrets.clear();
    this.#sorted = [];
  }

  redact(value) {
    const own = this.#apply(value);
    return this.#parent ? this.#parent.redact(own) : own;
  }

  #apply(value) {
    if (this.#sorted.length === 0) return value;
    if (typeof value === 'string') {
      let out = value;
      for (const s of this.#sorted) {
        if (out.includes(s)) out = out.split(s).join('***');
      }
      return out;
    }
    if (Array.isArray(value)) return value.map((v) => this.#apply(v));
    if (value && typeof value === 'object') {
      if (value instanceof Error) return this.#apply(value.message);
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.#apply(v);
      return out;
    }
    return value;
  }
}

export const rootRedactor = new Redactor();

export function registerSecret(value) {
  rootRedactor.add(value);
}

export function clearSecrets() {
  rootRedactor.clear();
}

export function redact(value) {
  return rootRedactor.redact(value);
}

export function setLevel(level) {
  if (level in LEVELS) currentLevel = LEVELS[level];
}

export function getLevel() {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === currentLevel);
}

export function setLogStream(stream) {
  logStream = stream;
}

function emit(level, msg, fields, redactor) {
  if (LEVELS[level] > currentLevel) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: redactor.redact(String(msg)),
    ...(fields ? redactor.redact(fields) : {}),
  };
  let line;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ ts: record.ts, level, msg: record.msg, err: 'unserialisable log fields' });
  }
  logStream.write(line + '\n');
}

export const log = {
  error: (msg, fields) => emit('error', msg, fields, rootRedactor),
  warn: (msg, fields) => emit('warn', msg, fields, rootRedactor),
  info: (msg, fields) => emit('info', msg, fields, rootRedactor),
  debug: (msg, fields) => emit('debug', msg, fields, rootRedactor),
  print: (text = '') => process.stdout.write(rootRedactor.redact(String(text)) + '\n'),
};

export function child(context, redactor = rootRedactor) {
  return {
    error: (msg, fields) => emit('error', msg, { ...context, ...fields }, redactor),
    warn: (msg, fields) => emit('warn', msg, { ...context, ...fields }, redactor),
    info: (msg, fields) => emit('info', msg, { ...context, ...fields }, redactor),
    debug: (msg, fields) => emit('debug', msg, { ...context, ...fields }, redactor),
  };
}
