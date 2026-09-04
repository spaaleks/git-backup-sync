const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel = LEVELS.info;

let logStream = process.stdout;

const secrets = new Set();
let secretsSorted = [];

export function registerSecret(value) {
  if (typeof value !== 'string' || value.length < 6) return;
  if (secrets.has(value)) return;
  secrets.add(value);
  secretsSorted = [...secrets].sort((a, b) => b.length - a.length);
}

export function clearSecrets() {
  secrets.clear();
  secretsSorted = [];
}

export function redact(value) {
  if (secretsSorted.length === 0) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const s of secretsSorted) {
      if (out.includes(s)) out = out.split(s).join('***');
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    if (value instanceof Error) return redact(value.message);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out;
  }
  return value;
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

function emit(level, msg, fields) {
  if (LEVELS[level] > currentLevel) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: redact(String(msg)),
    ...(fields ? redact(fields) : {}),
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
  error: (msg, fields) => emit('error', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  debug: (msg, fields) => emit('debug', msg, fields),
  print: (text = '') => process.stdout.write(redact(String(text)) + '\n'),
};

export function child(context) {
  return {
    error: (msg, fields) => emit('error', msg, { ...context, ...fields }),
    warn: (msg, fields) => emit('warn', msg, { ...context, ...fields }),
    info: (msg, fields) => emit('info', msg, { ...context, ...fields }),
    debug: (msg, fields) => emit('debug', msg, { ...context, ...fields }),
  };
}
