import { log } from '../logger.js';
import { createTransport, send as sendMail, shouldNotify, buildRunMail, buildHeartbeatMail, LOGO_CID } from '../mail.js';
import { resolveNtfy, notifyRun, notifySource } from './ntfy.js';
import { resolveKuma, send as sendKuma, runPayload, sourcePayload } from './kuma.js';

export class Notifier {
  constructor(config) {
    this.config = config;
    this.transport = config.smtp?.enabled ? createTransport(config.smtp) : null;
    this.ntfy = resolveNtfy(config.ntfy, null);
    this.kuma = resolveKuma(config.uptime_kuma, null);

    this.perSource = new Map();
    for (const source of config.sources ?? []) {
      this.perSource.set(source.name, {
        ntfy: resolveNtfy(config.ntfy, source.ntfy),
        kuma: resolveKuma(config.uptime_kuma, source.uptime_kuma),
      });
    }

    if (!this.transport && !this.ntfy && !this.kuma && !this.hasAnyPerSource()) {
      log.warn('no notification channel is configured (smtp, ntfy or uptime_kuma), failures will only appear in these logs');
    }
  }

  hasAnyPerSource() {
    for (const entry of this.perSource.values()) {
      if (entry.ntfy || entry.kuma) return true;
    }
    return false;
  }

  withLogo(message) {
    const path = this.config.smtp?.logo;
    return path ? { ...message, attachments: [{ filename: 'logo.png', path, cid: LOGO_CID }] } : message;
  }

  get enabled() {
    return Boolean(this.transport || this.ntfy || this.kuma || this.hasAnyPerSource());
  }

  async runFinished(report) {
    if (report.dryRun) {
      log.info('dry run: no notifications sent');
      return;
    }

    const jobs = [];

    if (this.transport && shouldNotify(report, this.config.smtp)) {
      jobs.push(sendMail(this.transport, this.config.smtp, this.withLogo(buildRunMail(report, this.config))));
    } else if (this.transport) {
      log.info('nothing to report by mail', { totals: report.totals });
    }

    if (this.ntfy) jobs.push(notifyRun(this.ntfy, report));

    if (this.kuma) jobs.push(sendKuma(this.kuma, runPayload(report), { scope: 'run' }));

    for (const sourceReport of report.sources) {
      const channels = this.perSource.get(sourceReport.name);
      if (!channels) continue;
      if (channels.ntfy && channels.ntfy.topic !== this.ntfy?.topic) {
        jobs.push(notifySource(channels.ntfy, sourceReport));
      }
      if (channels.kuma && channels.kuma.url !== this.kuma?.url && !sourceReport.disabled) {
        jobs.push(sendKuma(channels.kuma, sourcePayload(sourceReport), { scope: 'source', source: sourceReport.name }));
      }
    }

    const results = await Promise.allSettled(jobs);
    for (const result of results) {
      if (result.status === 'rejected') {
        log.error('a notification channel threw', { error: String(result.reason?.message ?? result.reason) });
      }
    }
  }

  async heartbeat({ state, connections, uptimeMs }) {
    const jobs = [];

    if (this.transport) {
      const message = this.withLogo(await buildHeartbeatMail({ config: this.config, state, connections, uptimeMs }));
      jobs.push(
        sendMail(this.transport, this.config.smtp, message).then((ok) => {
          if (ok) state.lastHeartbeatAt = new Date().toISOString();
          return ok;
        }),
      );
    } else {
      log.warn('a heartbeat is scheduled but no mail transport is configured');
    }

    const results = await Promise.allSettled(jobs);
    return results.some((r) => r.status === 'fulfilled' && r.value);
  }
}
