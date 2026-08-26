#!/usr/bin/env node
/**
 * Start Next on the configured port.
 *
 * The script used to be `next dev -p ${WEB_PORT:-3000}`, which is a *shell* expansion: it reads the
 * shell environment, not the repository's .env. So setting WEB_PORT in .env moved every other part
 * of the stack — the gateway, Playwright, next.config — while Next itself kept binding 3000, and
 * the only symptom was an EADDRINUSE naming a port nobody had configured.
 *
 * Loading .env here, before Next is spawned, means one file decides the port and everything agrees
 * with it. An explicit shell variable still wins, which is what `WEB_PORT=3005 npm run dev` relies
 * on and what containers pass through env_file.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // No .env — the default below is correct.
}

const port = process.env.WEB_PORT ?? '3000';
const args = process.argv.slice(2);

const child = spawn('next', [...args, '-p', port], {
  stdio: 'inherit',
  env: process.env,
  shell: false,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error(`could not start next: ${err.message}`);
  process.exit(1);
});
