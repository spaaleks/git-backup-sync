import nodemailer from 'nodemailer';
import { log } from '../logger.js';
import { sleep } from '../connections.js';

export function createTransport(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
  });
}

export function fromField(smtp) {
  const raw = String(smtp.from ?? '').trim();
  const angled = raw.match(/<([^>]*)>\s*$/);
  const address = angled ? angled[1].trim() : raw;
  const inline = angled ? raw.slice(0, angled.index).trim().replace(/^"(.*)"$/, '$1') : '';
  const name = String(smtp.from_name ?? '').trim() || inline;
  return name ? { name, address } : address;
}

export async function send(transport, smtp, message) {
  const attempts = (smtp.retries ?? 3) + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const info = await transport.sendMail({
        from: fromField(smtp),
        to: smtp.to.join(', '),
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: message.attachments ?? [],
      });
      log.info('mail sent', { subject: message.subject, to: smtp.to.length, messageId: info.messageId });
      return true;
    } catch (err) {
      const last = attempt === attempts;
      log[last ? 'error' : 'warn']('mail delivery failed', { attempt, attempts, error: err.message });
      if (last) {
        log.error('undelivered mail body follows', { subject: message.subject, body: message.text });
        return false;
      }
      await sleep(Math.min(2000 * 2 ** (attempt - 1), 30_000));
    }
  }
  return false;
}

export function shouldNotify(report, smtp) {
  if (!smtp?.enabled) return false;
  if (report.dryRun) return false;
  if (report.skipped) return false;

  const on = new Set(smtp.notify_on || []);
  const t = report.totals ?? {};
  const hasFailure = Boolean(report.fatal) || (t.failed ?? 0) > 0 || (t.failedSources ?? 0) > 0;
  const hasChange = (t.new ?? 0) + (t.changed ?? 0) + (t.moved ?? 0) + (t.vanished ?? 0) + (t.remapped ?? 0) > 0;

  if (on.has('always')) return true;
  if (hasFailure && on.has('failures')) return true;
  if (hasChange && on.has('changes')) return true;
  return false;
}
