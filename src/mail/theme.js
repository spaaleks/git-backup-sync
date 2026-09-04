// Inline styles and tables only: mail clients strip <style> and predate flexbox.

export const ACCENT = '#ec483b';

const INK = '#363636';

export const OK = '#2f855a';
export const WARN = '#b7791f';
export const NEUTRAL = '#5f6b7a';

const S = {
  page: 'margin:0;background:#f6f6f6',
  card:
    'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
    'color:#1a1a1a;max-width:840px;margin:0 auto;padding:26px 30px;background:#fff',
  h1: 'font-size:25px;line-height:1.25;margin:0 0 6px;color:#111',
  sub: 'margin:0 0 18px;color:#777;font-size:13px',
  rule: `border:none;border-top:2px solid ${ACCENT};margin:0 0 30px`,
  hr: 'border:none;border-top:1px solid #ececec;margin:20px 0',
  h2: `font-size:18px;margin:24px 0 8px;color:${ACCENT};border-bottom:1px solid #ececec;padding-bottom:5px`,
  h3: 'font-size:14px;margin:18px 0 4px;color:#333',
  p: 'margin:8px 0;font-size:14px;line-height:1.62',
  table: 'border-collapse:collapse;width:100%;margin:14px 0',
  th: 'text-align:left;padding:7px 11px;border-bottom:2px solid #ddd;font-size:13px;color:#333',
  td: 'padding:6px 11px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top',
  code: 'background:#f3f3f3;padding:1px 5px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px',
  pre: 'background:#f7f7f7;border-left:3px solid #ddd;padding:9px 12px;margin:8px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:#444',
  quote: `margin:10px 0;padding:8px 14px;border-left:3px solid ${ACCENT};background:#fdf1ef;color:#444;font-size:14px`,
  foot: 'margin:18px 0 0;color:#999;font-size:12px;line-height:1.6',
};

const STATUS_COLOURS = {
  new: OK,
  changed: '#2c5f8a',
  unchanged: NEUTRAL,
  failed: ACCENT,
  interrupted: INK,
  vanished: WARN,
  excluded: '#6b4c9a',
  moved: '#0f766e',
  'moved-away': '#0f766e',
  remapped: '#7b1020',
  planned: NEUTRAL,
  other: NEUTRAL,
};

const STATUS_SHORT = {
  new: 'NEW',
  changed: 'CHG',
  unchanged: 'OK',
  failed: 'FAIL',
  interrupted: 'INT',
  vanished: 'GONE',
  excluded: 'EXCL',
  moved: 'MOVE',
  'moved-away': 'MOVE',
  remapped: 'REMAP',
  planned: 'PLAN',
};

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
  })[c]);
}

export const doc = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>` +
  `<body style="${S.page}"><div style="${S.card}">${body}</div></body></html>`;

export const logo = (cid, width = 100) =>
  `<img src="cid:${cid}" width="${width}" alt="" style="display:block;width:${width}px;max-width:100%;` +
  `height:auto;border:0;outline:none;text-decoration:none;margin:0 0 20px">`;

export const h1 = (text, subtitle, logoCid = null) =>
  (logoCid ? logo(logoCid) : '') +
  `<h1 style="${S.h1}">${escapeHtml(text)}</h1>` +
  (subtitle ? `<p style="${S.sub}">${escapeHtml(subtitle)}</p>` : '') +
  `<hr style="${S.rule}">`;

export const h2 = (text) => `<h2 style="${S.h2}">${escapeHtml(text)}</h2>`;
export const h3 = (text) => `<p style="${S.h3}"><strong>${escapeHtml(text)}</strong></p>`;
export const p = (html) => `<p style="${S.p}">${html}</p>`;
export const hr = () => `<hr style="${S.hr}">`;
export const quote = (text) => `<blockquote style="${S.quote}">${escapeHtml(text)}</blockquote>`;
export const code = (text) => `<code style="${S.code}">${escapeHtml(text)}</code>`;
export const pre = (text) => `<pre style="${S.pre}">${escapeHtml(text)}</pre>`;
export const foot = (text) => `<p style="${S.foot}">${text}</p>`;

export function badge(text, colour = NEUTRAL) {
  return (
    `<span style="display:inline-block;background:${colour};color:#fff;font-size:11px;font-weight:700;` +
    `letter-spacing:.3px;text-transform:uppercase;padding:2px 8px;border-radius:10px;vertical-align:middle">` +
    `${escapeHtml(text)}</span>`
  );
}

export const statusBadge = (status) =>
  badge(STATUS_SHORT[status] ?? String(status).slice(0, 5), STATUS_COLOURS[status] ?? STATUS_COLOURS.other);

export const shortStatus = (status) => STATUS_SHORT[status] ?? String(status).slice(0, 5).toUpperCase();

export function table(headers, rows) {
  if (rows.length === 0) return '';
  const head = headers.map((h) => `<th style="${S.th}">${escapeHtml(h)}</th>`).join('');
  const body = rows
    .map((cells) => `<tr>${cells.map((c) => `<td style="${S.td}">${c}</td>`).join('')}</tr>`)
    .join('');
  return `<table style="${S.table}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
export function bar(value, max, width = 160) {
  const px = max > 0 ? Math.max(2, Math.round((value / max) * width)) : 2;
  return (
    `<span style="display:inline-block;background:${ACCENT};height:9px;width:${px}px;border-radius:2px;` +
    `vertical-align:middle"></span>`
  );
}
