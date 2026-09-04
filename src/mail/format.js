import { parseCron, nextRun } from '../cron.js';

export function nextScheduled(config) {
  try {
    const spec = parseCron(config.schedule.sync);
    return nextRun(spec, new Date(), config.timezone)?.toISOString() ?? null;
  } catch {
    return null;
  }
}

export function indent(text, spaces) {
  const prefix = ' '.repeat(spaces);
  return String(text)
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

export function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

export function firstLine(text) {
  return String(text || '').split('\n').find((l) => l.trim()) ?? '';
}

export function formatDuration(ms) {
  if (!ms && ms !== 0) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
