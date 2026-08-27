#!/usr/bin/env node
/**
 * Refuse to start a second dev stack on top of a running one.
 *
 * Without this, `npm run dev` with a server already up fails halfway: the gateway reports its port
 * clash clearly, then Next throws a raw EADDRINUSE stack, and the pair reads like two unrelated
 * faults rather than the one banal cause.
 *
 * The cause is not always the same, though, and the difference matters. A port can be held by our
 * own dev server left running in another tab, or by an entirely different project — this machine
 * also runs one on 3000. Telling someone to "use it" when the server belongs to another repository
 * sends them to the wrong application, so this reports which it is rather than assuming.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Read the same .env the services will. Checking process.env alone meant this guard tested the
// default ports while the stack started on the configured ones — so it blocked a start over a port
// nothing was about to use, and named the wrong project as the obstacle.
try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // No .env yet; the defaults below are correct in that case.
}

const PORTS = [
  { port: Number(process.env.WEB_PORT ?? 3000), what: 'web app', varName: 'WEB_PORT' },
  {
    port: Number(process.env.STREAM_GATEWAY_PORT ?? 4001),
    what: 'stream gateway',
    varName: 'STREAM_GATEWAY_PORT',
  },
];

/** Bind-test rather than scan: the only question that matters is whether we could listen. */
function inUse(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, '::');
  });
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * Who holds the port, and is it us?
 *
 * The working directory is the honest answer to "is this ours" — the command line of a Next server
 * is just `next-server (vX)` and says nothing about which project it belongs to.
 */
function holder(port) {
  try {
    const pids = sh('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).split('\n').filter(Boolean);
    if (pids.length === 0) return null;
    const pid = pids[0];
    const command = sh('ps', ['-o', 'command=', '-p', pid]).slice(0, 60);
    let cwd = null;
    try {
      const line = sh('lsof', ['-p', pid, '-a', '-d', 'cwd', '-Fn'])
        .split('\n')
        .find((l) => l.startsWith('n'));
      if (line) cwd = line.slice(1);
    } catch {
      // lsof can refuse the cwd of a process it cannot inspect; the pid alone is still useful.
    }
    // Services are started from their own package directory, not the repo root, so anything
    // *inside* the repository is still this project. Comparing against the root alone reported our
    // own gateway as a stranger.
    const ours = cwd === REPO_ROOT || (cwd !== null && cwd.startsWith(REPO_ROOT + '/'));
    return { pid, command, cwd, ours };
  } catch {
    return null;
  }
}

/** Ports already spoken for in .env, so a suggested alternative does not create a fresh clash. */
function reservedPorts() {
  const reserved = new Set();
  try {
    for (const line of readFileSync(resolve(REPO_ROOT, '.env'), 'utf8').split('\n')) {
      const match = /^[A-Z_]*PORT\s*=\s*(\d+)/.exec(line.trim());
      if (match) reserved.add(Number(match[1]));
    }
  } catch {
    // No .env yet — the defaults below are still worth avoiding.
  }
  for (const p of [3000, 4001, 4002, 4003, 5433, 6380, 8001, 8554, 8888, 8889, 9000]) {
    reserved.add(p);
  }
  return reserved;
}

function suggestFree(from, reserved, taken) {
  let candidate = from;
  while (reserved.has(candidate) || taken.has(candidate)) candidate += 1;
  taken.add(candidate);
  return candidate;
}

/**
 * Are the backing services up?
 *
 * Postgres and Redis stop with the Docker daemon, and the daemon stops on its own — three times in
 * one working session here. The failure that follows is not obviously about that: the app starts
 * fine, then every page 500s on a Prisma connection error, and the alerts service reports an empty
 * bus. Saying it up front costs one TCP probe and saves reading a stack trace to rediscover it.
 */
async function checkBackingServices() {
  const services = [
    { name: 'Postgres', port: Number(process.env.POSTGRES_PORT ?? 5433) },
    { name: 'Redis', port: Number(process.env.REDIS_PORT ?? 6380) },
  ];
  const down = [];
  for (const s of services) {
    const reachable = await new Promise((resolve) => {
      const socket = connect({ port: s.port, host: '127.0.0.1' });
      const done = (ok) => { socket.destroy(); resolve(ok); };
      socket.setTimeout(1200);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
    if (!reachable) down.push(s);
  }
  return down;
}

const backingDown = await checkBackingServices();
if (backingDown.length > 0) {
  console.error('\nThe backing services are not running.\n');
  for (const s of backingDown) console.error(`  ${s.name} is not answering on port ${s.port}`);
  console.error('\nThe app would start and then fail on every database query. Start them first:\n');
  console.error('  make infra\n');
  console.error('If that fails, the Docker daemon is probably stopped — open Docker Desktop.\n');
  process.exit(1);
}

const busy = [];
for (const entry of PORTS) {
  if (await inUse(entry.port)) busy.push({ ...entry, holder: holder(entry.port) });
}

if (busy.length === 0) process.exit(0);

console.error('\nCannot start: a port this stack needs is already in use.\n');

let anyOurs = false;
let anyForeign = false;

for (const b of busy) {
  const h = b.holder;
  if (!h) {
    console.error(`  port ${b.port} (${b.what}) is held by an unknown process`);
    continue;
  }
  anyOurs ||= h.ours;
  anyForeign ||= h.cwd !== null && !h.ours;
  const whose = h.ours ? 'this project' : h.cwd ? `another project — ${h.cwd}` : 'unknown project';
  console.error(`  port ${b.port} (${b.what}) is held by pid ${h.pid}, ${whose}`);
  console.error(`      ${h.command}`);
}

console.error('');
if (anyOurs) {
  // Only ever offer to kill our own ports. Listing every busy port here would hand over a command
  // that stops another project's server as a side effect of restarting ours.
  const oursPorts = busy.filter((b) => b.holder?.ours).map((b) => b.port);
  console.error(
    oursPorts.length === busy.length
      ? 'That is this project, already serving. Use it, or restart with:'
      : 'Some of those are ours. To stop only this project’s:',
  );
  console.error(`\n  lsof -ti:${oursPorts.join(',')} | xargs kill\n`);
}
if (anyForeign) {
  // The important case. Nothing on that port belongs to us, so "just use it" would open the wrong
  // application, and killing someone else's server is not a decision this script should make.
  console.error('That server belongs to a different project, so it is not serving DrishtiNet.');
  console.error('Either stop it yourself, or run this stack on free ports:\n');
  const reserved = reservedPorts();
  const taken = new Set();
  const overrides = busy
    .map((b) => `${b.varName}=${suggestFree(b.port + 1, reserved, taken)}`)
    .join(' ');
  console.error(`  ${overrides} npm run dev\n`);
}

process.exit(1);
