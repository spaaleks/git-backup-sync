const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, nameOffset: 1 },
  { name: 'dow', min: 0, max: 6, names: DAYS, nameOffset: 0 },
];

export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  }
  const spec = {};
  parts.forEach((part, i) => {
    const field = FIELDS[i];
    spec[field.name] = parseField(part, field);
    spec[`${field.name}Restricted`] = part !== '*';
  });
  spec.expr = String(expr).trim();
  return spec;
}

function parseField(part, field) {
  const set = new Set();
  for (const chunk of part.split(',')) {
    const [range, stepText] = chunk.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid step "${stepText}" in ${field.name} field`);
    }
    let lo;
    let hi;
    if (range === '*') {
      lo = field.min;
      hi = field.max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = toNumber(a, field);
      hi = toNumber(b, field);
    } else {
      lo = toNumber(range, field);
      hi = stepText === undefined ? lo : field.max;
    }
    if (lo > hi) throw new Error(`range ${range} is inverted in ${field.name} field`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  if (field.name === 'dow' && set.has(7)) {
    set.delete(7);
    set.add(0);
  }
  if (set.size === 0) throw new Error(`${field.name} field matches nothing`);
  return set;
}

function toNumber(text, field) {
  const lower = String(text).trim().toLowerCase();
  if (field.names) {
    const idx = field.names.indexOf(lower.slice(0, 3));
    if (idx >= 0) return idx + field.nameOffset;
  }
  const n = Number(lower);
  const max = field.name === 'dow' ? 7 : field.max;
  if (!Number.isInteger(n) || n < field.min || n > max) {
    throw new Error(`"${text}" is out of range for the ${field.name} field (${field.min}-${field.max})`);
  }
  return n === 7 && field.name === 'dow' ? 0 : n;
}

const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function zoneFields(date, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    dow: DAYS.indexOf(String(get('weekday')).toLowerCase().slice(0, 3)),
  };
}

function matches(spec, f) {
  if (!spec.minute.has(f.minute)) return false;
  if (!spec.hour.has(f.hour)) return false;
  if (!spec.month.has(f.month)) return false;
  const domOk = spec.dom.has(f.day);
  const dowOk = spec.dow.has(f.dow);
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

const MINUTE = 60_000;

export function nextRun(spec, from = new Date(), timeZone = 'UTC') {
  let t = Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE;
  const limit = t + 366 * 24 * 60 * MINUTE;

  while (t <= limit) {
    const date = new Date(t);
    const f = zoneFields(date, timeZone);

    const dateOk =
      spec.month.has(f.month) &&
      (spec.domRestricted && spec.dowRestricted
        ? spec.dom.has(f.day) || spec.dow.has(f.dow)
        : spec.domRestricted
          ? spec.dom.has(f.day)
          : spec.dowRestricted
            ? spec.dow.has(f.dow)
            : true);

    if (!dateOk) {
      t += (24 * 60 - (f.hour * 60 + f.minute)) * MINUTE;
      continue;
    }
    if (!spec.hour.has(f.hour)) {
      t += (60 - f.minute) * MINUTE;
      continue;
    }
    if (matches(spec, f)) return date;
    t += MINUTE;
  }
  return null;
}

export function approximateIntervalMs(spec, timeZone = 'UTC', from = new Date()) {
  const a = nextRun(spec, from, timeZone);
  if (!a) return null;
  const b = nextRun(spec, a, timeZone);
  if (!b) return null;
  return b.getTime() - a.getTime();
}
