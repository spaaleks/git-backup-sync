import { writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { log, setLevel, registerSecret } from './logger.js';
import { loadConfig, redactedConfig } from './config/load.js';
import { buildConnections } from './connections.js';
import { loadState, saveState, statePath } from './state.js';
import { runSync, requestStop } from './run.js';
import { killAllGit, runningGitCount } from './mirror.js';
import { Notifier } from './notify/index.js';
import { startMetricsServer } from './metrics.js';
import { parseCron, nextRun, approximateIntervalMs as approximateInterval } from './cron.js';

export class Service {
  constructor(config) {
    this.applyConfig(config);
    this.state = null;
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
    this.state = await loadState(this.config.data_dir);

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
    this.running = (async () => {
      await this.#reloadStateIfChanged();
      const report = await runSync({
        config: this.config,
        connections: this.connections,
        state: this.state,
        reason,
        only,
      });
      if (!report.skipped) {
        this.lastReport = report;
        await saveState(this.config.data_dir, this.state, { keepRuns: this.config.keep_runs });
        this.stateMtimeMs = await stateMtimeMs(this.config.data_dir);
        await this.notifier.runFinished(report);
      }
      await this.writeHealth(report);
      return report;
    })();

    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  async #reloadStateIfChanged() {
    const current = await stateMtimeMs(this.config.data_dir);
    if (current === null || this.stateMtimeMs === current) return;
    if (this.stateMtimeMs !== undefined) {
      log.info('state file changed on disk since our last write, reloading it');
    }
    this.state = await loadState(this.config.data_dir);
    this.stateMtimeMs = current;
  }

  async heartbeat() {
    const ok = await this.notifier.heartbeat({
      state: this.state,
      connections: this.connections,
      uptimeMs: Date.now() - this.startedAt,
    });
    if (ok) await saveState(this.config.data_dir, this.state, { keepRuns: this.config.keep_runs });
  }

  async writeHealth(report) {
    const spec = safeCron(this.config.schedule.sync);
    const next = spec ? nextRun(spec, new Date(), this.config.timezone) : null;
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
      const killed = killAllGit();
      log.warn('second signal, aborting now', { signal, gitProcessesKilled: killed });
      await exitCleanly(130);
    }
    this.shuttingDown = true;
    log.info('shutting down', { signal });
    requestStop();
    for (const timer of Object.values(this.timers)) if (timer) clearTimeout(timer);

    if (this.running) {
      log.info('finishing the repositories already in flight, send the signal again to abort now', {
        gitProcesses: runningGitCount(),
      });
      await this.running.catch(() => {});
    }
    if (this.state) {
      await saveState(this.config.data_dir, this.state, { keepRuns: this.config.keep_runs }).catch((err) =>
        log.error('could not write state during shutdown', { error: err.message }),
      );
    }
    if (this.metricsServer) this.metricsServer.close();
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    log.info('stopped');
    await exitCleanly(0);
  }
}

export async function exitCleanly(code) {
  await new Promise((resolve) => {
    if (process.stdout.write('')) resolve();
    else process.stdout.once('drain', resolve);
  });
  process.exit(code);
}

async function stateMtimeMs(dataDir) {
  try {
    return (await stat(statePath(dataDir))).mtimeMs;
  } catch {
    return null;
  }
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
