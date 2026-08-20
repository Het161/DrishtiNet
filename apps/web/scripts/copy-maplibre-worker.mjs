/**
 * Copy MapLibre's CSP worker into public/ so it is served from our own origin.
 *
 * Runs before every build and before dev. The file is a build artifact of a dependency, so it is
 * copied rather than committed — but it MUST exist at runtime, and the demo machine has no network
 * to fall back on, so a missing worker fails the build loudly here instead of silently producing a
 * map that never loads.
 */
import { copyFile, mkdir, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, '../public/maplibre');

const maplibreDist = dirname(require.resolve('maplibre-gl/dist/maplibre-gl-csp.js'));
const files = ['maplibre-gl-csp-worker.js'];

await mkdir(PUBLIC_DIR, { recursive: true });
for (const file of files) {
  const from = resolve(maplibreDist, file);
  try {
    await access(from);
  } catch {
    console.error(`FATAL: ${from} not found — maplibre-gl is not installed correctly.`);
    process.exit(1);
  }
  await copyFile(from, resolve(PUBLIC_DIR, file));
  console.log(`maplibre worker -> public/maplibre/${file}`);
}
