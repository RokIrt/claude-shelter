#!/usr/bin/env node
// Token Shelter server: watches local Claude Code activity (or plays a simulation) and
// serves the Snapshot plus the game's static files on 127.0.0.1.
//
//   node server.mjs [--port 4780] [--sim <scenario>] [--open]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCollector } from './src/collector/collector.mjs';
import { DEFAULT_PORT, claudeConfigDir, dataDirOf, loadConfig, parsePort } from './src/collector/config.mjs';
import { LOOPBACK, createApp } from './src/collector/http.mjs';

export const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TICK_MS = 1000;

const USAGE = `Token Shelter - your Claude Code activity as an underground shelter.

Usage: token-shelter [options]

  --port <n>     port to listen on (default ${DEFAULT_PORT}; also env PORT or shelter.config.json)
  --sim [name]   play a simulated scenario instead of reading live telemetry
  --open         open the shelter in the default browser
  -h, --help     show this help

The server listens on ${LOOPBACK} only.`;

/** @returns {{port:number|null, sim:string|null, open:boolean, help:boolean}} */
export function parseArgs(argv) {
  const args = { port: null, sim: null, open: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = () => inline ?? (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') ? argv[++i] : undefined);
    if (flag === '--port' || flag === '-p') {
      const raw = value();
      args.port = parsePort(raw);
      if (args.port == null) throw new Error(`--port needs a number between 1 and 65535${raw ? ` (got "${raw}")` : ''}`);
    } else if (flag === '--sim') {
      args.sim = value() ?? '';   // '' = the default scenario
    } else if (flag === '--open') {
      args.open = true;
    } else if (flag === '--help' || flag === '-h') {
      args.help = true;
    } else {
      throw new Error(`unknown option "${arg}"`);
    }
  }
  return args;
}

function openInBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});   // no browser opener here; the URL is printed anyway
    child.unref();
  } catch { /* same */ }
}

/**
 * Start serving. Resolves once the port is bound.
 * @param {{port?:number|null, sim?:string|null, open?:boolean, env?:object,
 *          projectRoot?:string, log?:(msg:string)=>void}} [options]
 * @returns {Promise<{url:string, port:number, close:()=>Promise<void>}>}
 */
export async function startServer(options = {}) {
  const { env = process.env, projectRoot = PROJECT_ROOT, log = console.log } = options;
  const config = loadConfig(projectRoot);
  const envPort = parsePort(env.PORT);
  if (env.PORT && envPort == null) throw new Error(`PORT must be a number between 1 and 65535 (got "${env.PORT}")`);
  const wantedPort = options.port ?? envPort ?? config.port ?? DEFAULT_PORT;

  const startedAt = Date.now();
  let source;      // { tick(): Snapshot, stop(): void }
  let watching;
  if (options.sim != null) {
    const { SCENARIOS, scenarioSnapshot } = await import('./src/shared/scenarios.mjs');
    const name = options.sim || SCENARIOS[0];
    if (!SCENARIOS.includes(name)) throw new Error(`unknown scenario "${name}". Available: ${SCENARIOS.join(', ')}`);
    source = { tick: () => scenarioSnapshot(name, (Date.now() - startedAt) / 1000, Date.now()), stop() {} };
    watching = `simulation "${name}" (no live telemetry, no usage probes)`;
  } else {
    const configDir = claudeConfigDir(env);
    const collector = createCollector({
      configDir,
      dataDir: dataDirOf(projectRoot, env),
      usageIntervalMs: config.usageIntervalSec * 1000,
      extraModels: config.extraModels,
      warn: (msg) => console.warn(`[shelter] ${msg}`),
    });
    collector.start();
    source = { tick: collector.tick, stop: collector.stop };
    watching = `${configDir} (sessions, transcripts, subagents); plan usage every ${config.usageIntervalSec} s via \`claude -p /usage\``;
  }

  let snapshot;
  try {
    snapshot = source.tick();
  } catch (e) {
    source.stop();
    throw e;
  }
  let tickFailed = false;
  const app = createApp({
    projectRoot,
    getSnapshot: () => snapshot,
    getHealth: () => ({
      v: snapshot.v,
      source: snapshot.source,
      scenario: snapshot.scenario,
      at: snapshot.at,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      agents: snapshot.agents.length,
      limitsAt: snapshot.limits.at,
      limitsStale: snapshot.limits.stale,
      listeners: app.clients.size,
    }),
  });

  const ticker = setInterval(() => {
    try {
      snapshot = source.tick();
      tickFailed = false;
    } catch (e) {
      // Keep serving the last good snapshot; say so once, not every second.
      if (!tickFailed) console.error(`[shelter] could not refresh telemetry: ${e.stack ?? e}`);
      tickFailed = true;
      return;
    }
    app.broadcast(snapshot);
  }, TICK_MS);

  let port;
  try {
    port = await app.listen(wantedPort);
  } catch (e) {
    clearInterval(ticker);
    source.stop();
    throw e.code === 'EADDRINUSE'
      ? new Error(`port ${wantedPort} is already in use; pick another with --port or PORT`)
      : e;
  }

  const url = `http://${LOOPBACK}:${port}/`;
  log(`Token Shelter is open at ${url}`);
  log(`Watching ${watching}`);
  if (options.open) openInBrowser(url);

  let closing = null;
  return {
    url,
    port,
    close() {
      closing ??= (async () => {
        clearInterval(ticker);
        source.stop();
        await app.close();
      })();
      return closing;
    },
  };
}

/** Entry point for `node server.mjs` and bin/shelter.mjs. */
export async function runCli(argv = process.argv.slice(2)) {
  let handle;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(USAGE);
      return;
    }
    handle = await startServer(args);
  } catch (e) {
    console.error(`token-shelter: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const shutdown = () => {
    // A second Ctrl+C does not wait.
    process.once('SIGINT', () => process.exit(130));
    handle.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function invokedDirectly() {
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (invokedDirectly()) runCli();
