#!/usr/bin/env node
/**
 * Refuse to start a second dev stack on top of a running one.
 *
 * Without this, `npm run dev` with a server already up fails halfway: the gateway reports its port
 * clash clearly, then Next throws a raw EADDRINUSE stack, and the pair reads like two unrelated
 * faults rather than the one banal cause — a dev server is already running, quite possibly in
 * another terminal tab or left behind by an earlier session. Say that once, up front.
 *
 * A port being busy is not always our own server, so this reports what actually holds it rather
 * than assuming, and never kills anything: deciding what to stop is the developer's call.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

const PORTS = [
  { port: Number(process.env.WEB_PORT ?? 3000), what: 'web app' },
  { port: Number(process.env.STREAM_GATEWAY_PORT ?? 4001), what: 'stream gateway' },
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

/** Who holds it? Best-effort — lsof is absent on some systems and that must not be fatal. */
function holder(port) {
  try {
    const pids = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
    if (pids.length === 0) return null;
    const desc = execFileSync('ps', ['-o', 'command=', '-p', pids[0]], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { pid: pids[0], desc: desc.slice(0, 72) };
  } catch {
    return null;
  }
}

const busy = [];
for (const entry of PORTS) {
  if (await inUse(entry.port)) busy.push({ ...entry, holder: holder(entry.port) });
}

if (busy.length === 0) process.exit(0);

const ports = busy.map((b) => b.port).join(',');
console.error('\nA dev server is already running.\n');
for (const b of busy) {
  const who = b.holder ? `pid ${b.holder.pid} — ${b.holder.desc}` : 'unknown process';
  console.error(`  port ${b.port} (${b.what}) is held by ${who}`);
}
console.error('\nIf that is your dev server, it is still serving http://localhost:3000 — use it.');
console.error('To restart instead, stop it first:\n');
console.error(`  lsof -ti:${ports} | xargs kill`);
console.error('\nOr run this stack on different ports:\n');
console.error('  WEB_PORT=3001 STREAM_GATEWAY_PORT=4002 npm run dev\n');
process.exit(1);
