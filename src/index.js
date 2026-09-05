#!/usr/bin/env node
import { log, setLevel, setLogStream, registerSecret } from './logger.js';
import { loadConfig, ConfigError, DEFAULT_CONFIG_PATH } from './config/load.js';
import { openState } from './state.js';
import { checkConfig, explain, printConfigDump, dumpState } from './cli.js';
import { cleanup } from './cleanup.js';
import { unlock } from './unlock.js';
import { previewMail } from './preview.js';
import { Service, healthCommand, exitCleanly } from './service.js';

const USAGE = `git-backup-sync

  git-backup-sync                     run the scheduler (the container default)
  git-backup-sync --check-config      validate, resolve every mapping, print the plan
  git-backup-sync --explain <repo>    show how one repository resolves
  git-backup-sync --cleanup <source>  undo what a source wrote: list the
                                      destination projects, mirrors and state
                                      that would be removed. The source is not
                                      touched. (add --yes to apply, --force to
                                      include destinations that have commits,
                                      --purge to skip the deletion delay)
  git-backup-sync --once [source...]  run one sync now and exit. With no source,
                                      every enabled source runs.
  git-backup-sync --heartbeat         send a heartbeat mail now and exit
  git-backup-sync --unlock            show the sync lock, remove it if stale
  git-backup-sync --state             print the state store as JSON
  git-backup-sync --preview-mail      render a report from stored state and send
                                      it, contacting no repository
                                      [--heartbeat-template] [--html <path>]
  git-backup-sync --health            exit 0 if the last run is recent enough

Signals (to a running scheduler):
  SIGUSR1   run a sync now
  SIGHUP    reload the config, keeping the old one if the new one is invalid
  SIGTERM   finish the current repository, write state, exit
  git-backup-sync --help

Environment:
  CONFIG_PATH   path to the YAML config (default ${DEFAULT_CONFIG_PATH})
`;

function parseArgs(argv) {
  const args = { mode: 'daemon' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check-config') args.mode = 'check-config';
    else if (arg === '--once') args.mode = 'once';
    else if (arg === '--heartbeat') args.mode = 'heartbeat';
    else if (arg === '--health') args.mode = 'health';
    else if (arg === '--unlock') args.mode = 'unlock';
    else if (arg === '--state') args.mode = 'state';
    else if (arg === '--preview-mail') args.mode = 'preview-mail';
    else if (arg === '--heartbeat-template') args.previewKind = 'heartbeat';
    else if (arg === '--html') args.htmlPath = argv[++i];
    else if (arg === '--help' || arg === '-h') args.mode = 'help';
    else if (arg === '--explain') {
      args.mode = 'explain';
      args.query = argv[++i];
    } else if (arg.startsWith('--explain=')) {
      args.mode = 'explain';
      args.query = arg.slice('--explain='.length);
    } else if (arg === '--cleanup') {
      args.mode = 'cleanup';
      args.source = argv[++i];
    } else if (arg.startsWith('--cleanup=')) {
      args.mode = 'cleanup';
      args.source = arg.slice('--cleanup='.length);
    } else if (arg === '--yes') {
      args.yes = true;
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--keep-state') {
      args.keepState = true;
    } else if (arg === '--purge') {
      args.purge = true;
    } else if (arg === '--config') {
      args.config = argv[++i];
    } else if (!arg.startsWith('-') && args.mode === 'once') {
      (args.only ??= []).push(arg);
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  if (args.mode === 'explain' && !args.query) throw new Error('--explain needs a repository path or name');
  if (args.mode === 'cleanup' && !args.source) throw new Error('--cleanup needs a source name');
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (args.mode === 'help') {
    process.stdout.write(USAGE);
    await exitCleanly(0);
  }

  let config;
  try {
    config = await loadConfig({ path: args.config || process.env.CONFIG_PATH || DEFAULT_CONFIG_PATH });
  } catch (err) {
    if (err instanceof ConfigError || err.name === 'InterpolationError') {
      process.stderr.write(`${err.message}\n`);
      await exitCleanly(1);
    }
    throw err;
  }
  setLevel(config.log_level);
  for (const conn of Object.values(config.connections)) registerSecret(conn.token);
  if (config.smtp?.password) registerSecret(config.smtp.password);
  if (config.database?.password) registerSecret(config.database.password);

  if (args.mode === 'check-config' || args.mode === 'explain') {
    setLogStream(process.stderr);
    setLevel('warn');
    await exitCleanly(args.mode === 'check-config' ? await checkConfig(config) : await explain(config, args.query));
  }

  if (args.mode === 'cleanup') {
    setLogStream(process.stderr);
    setLevel('warn');
    await exitCleanly(await cleanup(config, { source: args.source, yes: args.yes, force: args.force, keepState: args.keepState, purge: args.purge }));
  }
  if (args.mode === 'health') await exitCleanly(await healthCommand(config));

  if (args.mode === 'preview-mail') {
    await exitCleanly(await previewMail(config, { htmlPath: args.htmlPath, kind: args.previewKind }));
  }

  if (args.mode === 'unlock') {
    setLogStream(process.stderr);
    setLevel('warn');
    await exitCleanly(await unlock(config, { force: args.force }));
  }

  if (args.mode === 'state') {
    setLogStream(process.stderr);
    setLevel('warn');
    await exitCleanly(await dumpState(config));
  }

  const service = new Service(config);

  const onSignal = (signal) =>
    service.shutdown(signal).catch(async (err) => {
      // A shutdown that throws would otherwise leave the process hanging with
      // nothing left to call process.exit.
      log.error('shutdown failed, exiting anyway', { signal, error: err.message });
      await exitCleanly(1);
    });

  process.on('SIGTERM', () => void onSignal('SIGTERM'));
  process.on('SIGINT', () => void onSignal('SIGINT'));
  process.on('SIGHUP', () => void service.reload().catch((err) => log.error('reload failed', { error: err.message })));
  process.on('SIGUSR1', () => {
    log.info('sync requested by signal', { signal: 'SIGUSR1' });
    void service.sync('manual').catch((err) => log.error('manual sync failed', { error: err.message }));
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', { error: String(reason?.message ?? reason), stack: reason?.stack });
  });

  if (args.mode === 'once') {
    if (args.only?.length) {
      const known = new Set(config.sources.map((src) => src.name));
      const unknown = args.only.filter((name) => !known.has(name));
      if (unknown.length) {
        process.stderr.write(
          `no source named ${unknown.map((n) => `"${n}"`).join(', ')} in ${config.configPath}. ` +
            `Known sources: ${[...known].join(', ')}\n`,
        );
        await exitCleanly(2);
      }
    }
    printConfigDump(config);
    service.state = await openState(config.database);
    const report = await service.sync('manual', args.only);
    await service.state.close();
    await exitCleanly(report.fatal || report.totals?.failed ? 1 : 0);
  }

  if (args.mode === 'heartbeat') {
    service.state = await openState(config.database);
    await service.heartbeat();
    await service.state.close();
    await exitCleanly(0);
  }

  await service.start();
}

main().catch(async (err) => {
  log.error('fatal', { error: err.message, stack: err.stack });
  await exitCleanly(1);
});
