import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { log, setLevel, registerSecret } from './logger.js';
import { loadConfig, redactedConfig } from './config/load.js';
import { buildConnections } from './connections.js';
import { openState } from './state.js';
import { Job } from './job.js';
import { runSync } from './run.js';
import { Notifier } from './notify/index.js';
import { startMetricsServer } from './metrics.js';
import { parseCron, nextRun, approximateIntervalMs as approximateInterval } from './cron.js';

export class Service {
  constructor(config) {
    this.applyConfig(config);
    this.state = null;
    this.job = null;
    this.running = null;
    this.lastReport = null;
    this.metricsServer = null;
    this.timers = { sync: null, heartbeat: null };
    this.startedAt = Date.now();
    this.shuttingDown = false;
  }

  applyConfig(config) {
    this.config = config;
    setLevel(config.log_level);
    this.connections = buildConnections(config);
    this.notifier = new Notifier(config);
  }

  async start() {
    log.info('git-backup-sync starting', {
      config: this.config.configPath,
      sources: this.config.sources.length,
      connections: Object.keys(this.config.connections).length,
      timezone: this.config.timezone,
      dryRun: this.config.dry_run,
    });
    log.info('resolved configuration', { config: redactedConfig(this.config) });

    await mkdir(this.config.data_dir, { recursive: true });
    this.state ??= await openState(this.config.database);
    log.info('state store opened', { store: this.state.store.describe });

    this.startMetrics();
    this.keepAlive();
    this.schedule();

    if (this.config.run_on_start) {
      await this.sync('startup');
    } else {
      await this.writeHealth();
    }
  }

  startMetrics() {
    if (!this.config.metrics?.enabled || this.metricsServer) return;
    this.metricsServer = startMetricsServer(this.config.metrics, () => ({
      config: this.config,
      state: this.state ?? { sources: {}, runs: [] },
      lastReport: this.lastReport,
      startedAt: this.startedAt,
      health: this.healthSnapshot(),
    }));
  }

  healthSnapshot() {
    if (!this.lastRunFinishedAt) {
      const age = Date.now() - this.startedAt;
      const healthy = age < 6 * 60 * 60 * 1000;
      return { healthy, detail: healthy ? 'no run has finished yet, still within the startup grace period' : 'no run has finished since startup' };
    }
    const spec = safeCron(this.config.schedule.sync);
    const interval = spec ? approximateInterval(spec, this.config.timezone) : null;
    const budget = (interval ?? 24 * 60 * 60 * 1000) * 2;
    const age = Date.now() - new Date(this.lastRunFinishedAt).getTime();
    return {
      healthy: age <= budget,
      detail: `last run finished ${Math.round(age / 60000)} minutes ago`,
    };
  }

  schedule() {
    this.scheduleOne('sync', this.config.schedule.sync, () => this.sync('scheduled'));
    if (this.config.schedule.heartbeat) {
      this.scheduleOne('heartbeat', this.config.schedule.heartbeat, () => this.heartbeat());
    }
  }

  scheduleOne(kind, expr, action) {
    if (this.timers[kind]) clearTimeout(this.timers[kind]);
    if (!expr || this.shuttingDown) return;

    const spec = parseCron(expr);
    const at = nextRun(spec, new Date(), this.config.timezone);
    if (!at) {
      log.warn('schedule never fires, ignoring it', { kind, expr });
      return;
    }
    const delay = Math.max(1000, at.getTime() - Date.now());
    log.info('next occurrence scheduled', { kind, at: at.toISOString(), inMs: delay });

    this.timers[kind] = setTimeout(async () => {
      try {
        await action();
      } catch (err) {
        log.error('scheduled task failed', { kind, error: err.message, stack: err.stack });
      } finally {
        this.scheduleOne(kind, this.config.schedule[kind], action);
      }
    }, delay);
    this.timers[kind].unref?.();
    this.keepAlive();
  }

  keepAlive() {
    if (this.keepAliveTimer) return;
    this.keepAliveTimer = setInterval(() => {}, 60_000);
  }

  async sync(reason, only = null) {
    if (this.running) {
      log.warn('a sync is already running, not starting another', { reason });
      return this.running;
    }
    this.job = new Job({ reason, secrets: Object.values(this.connections).map((c) => c.token) });
    this.running = (async () => {
      await this.state.reload();
      const report = await runSync({
        config: this.config,
        connections: this.connections,
        state: this.state,
        reason,
        only,
        job: this.job,
      });
      if (!report.skipped) {
        this.lastReport = report;
        await this.notifier.runFinished(report);
      }
      await this.writeHealth(report);
      return report;
    })();

    try {
      return await this.running;
    } finally {
      this.running = null;
      this.job = null;
      if (this.timers.sync) {
        log.info('idle', { lastRunFinishedAt: this.lastRunFinishedAt ?? null, nextRunAt: this.nextSyncAt()?.toISOString() ?? null });
      }
    }
  }

  nextSyncAt() {
    const spec = safeCron(this.config.schedule.sync);
    return spec ? nextRun(spec, new Date(), this.config.timezone) : null;
  }

  async heartbeat() {
    await this.notifier.heartbeat({
      state: this.state,
      connections: this.connections,
      uptimeMs: Date.now() - this.startedAt,
    });
  }

  async writeHealth(report) {
    const next = this.nextSyncAt();
    const health = {
      pid: process.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      lastRunFinishedAt: report?.finishedAt ?? this.lastRunFinishedAt ?? null,
      lastRunOk: report ? !report.fatal : (this.lastRunOk ?? null),
      nextRunAt: next?.toISOString() ?? null,
      syncSchedule: this.config.schedule.sync,
      timezone: this.config.timezone,
    };
    if (report?.finishedAt) {
      this.lastRunFinishedAt = report.finishedAt;
      this.lastRunOk = !report.fatal;
    }
    await writeFile(path.join(this.config.data_dir, 'health.json'), JSON.stringify(health, null, 2) + '\n').catch((err) =>
      log.warn('could not write the health file', { error: err.message }),
    );
  }

  async reload() {
    log.info('reloading configuration');
    try {
      const config = await loadConfig({ path: this.config.configPath });
      for (const conn of Object.values(config.connections)) registerSecret(conn.token);
      if (config.database?.password) registerSecret(config.database.password);
      this.applyConfig(config);
      this.schedule();
      this.startMetrics();
      log.info('configuration reloaded', { config: redactedConfig(config) });
    } catch (err) {
      log.error('reload failed, keeping the previous configuration', { error: err.message });
    }
  }

  async shutdown(signal) {
    // A second signal is the escape hatch. Git runs detached so a terminal
    // Ctrl-C cannot kill a transfer half way, which is right for the data and
    // would otherwise leave no way to stop a long clone.
    if (this.shuttingDown) {
      const killed = this.job?.killGit() ?? 0;
      log.warn('second signal, aborting now', { signal, gitProcessesKilled: killed });
      await exitCleanly(130);
    }
    this.shuttingDown = true;
    log.info('shutting down', { signal });
    this.job?.stop(signal);
    for (const timer of Object.values(this.timers)) if (timer) clearTimeout(timer);

    if (this.running) {
      log.info('finishing the repositories already in flight, send the signal again to abort now', {
        gitProcesses: this.job?.runningGit ?? 0,
      });
      await this.running.catch(() => {});
    }
    await this.state?.close().catch((err) => log.error('could not close the state store', { error: err.message }));
    if (this.metricsServer) this.metricsServer.close();
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    log.info('stopped');
    await exitCleanly(0);
  }
}

// stdout is a pipe under `docker compose run`, so writes are async and a bare
// process.exit() drops whatever has not drained, final log line included.
export async function exitCleanly(code) {
  for (const stream of [process.stdout, process.stderr]) {
    await new Promise((resolve) => {
      if (stream.write('')) resolve();
      else stream.once('drain', resolve);
    });
  }
  process.exit(code);
}

function safeCron(expr) {
  try {
    return parseCron(expr);
  } catch {
    return null;
  }
}

export async function healthCommand(config) {
  const { readFile } = await import('node:fs/promises');
  const file = path.join(config.data_dir, 'health.json');
  let health;
  try {
    health = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    log.print(`no health file at ${file}`);
    return 1;
  }
  if (!health.lastRunFinishedAt) {
    const age = Date.now() - new Date(health.startedAt).getTime();
    const ok = age < 6 * 60 * 60 * 1000;
    log.print(ok ? 'no run has finished yet, still within the startup grace period' : 'no run has finished since startup');
    return ok ? 0 : 1;
  }

  const spec = safeCron(config.schedule.sync);
  const interval = spec ? approximateInterval(spec, config.timezone) : null;
  const budget = (interval ?? 24 * 60 * 60 * 1000) * 2;
  const age = Date.now() - new Date(health.lastRunFinishedAt).getTime();

  if (age > budget) {
    log.print(`last run finished ${Math.round(age / 60000)} minutes ago, more than twice the ${Math.round(budget / 60000)} minute budget`);
    return 1;
  }
  log.print(`last run finished ${Math.round(age / 60000)} minutes ago`);
  return 0;
}
