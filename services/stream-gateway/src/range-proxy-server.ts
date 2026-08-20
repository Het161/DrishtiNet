#!/usr/bin/env tsx
/**
 * Standalone entrypoint for the caching range proxy.
 *
 *   pnpm --filter @drishtinet/stream-gateway exec tsx src/range-proxy-server.ts
 *
 * Then point FFmpeg at the proxy instead of the portal:
 *
 *   ffmpeg -ss 36000 -i http://127.0.0.1:4010/cam/5 -t 60 -c copy out.mp4
 *
 * Everything it does is logged as JSON lines to data/transfer.log, so upstream traffic against
 * shared government infrastructure stays auditable.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RangeProxy, DEFAULT_PROXY_CONFIG } from './range-proxy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const LOG_PATH = resolve(ROOT, 'data/transfer.log');
const CACHE_DIR = resolve(ROOT, '.cache/rangeproxy');

function parseBytes(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*([KMG])?B?$/i.exec(value.trim());
  if (!m) return fallback;
  const scale = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[(m[2] ?? '').toUpperCase()] ?? 1;
  return Math.round(Number(m[1]) * scale);
}

async function main(): Promise<void> {
  await mkdir(dirname(LOG_PATH), { recursive: true });

  const proxy = new RangeProxy({
    ...DEFAULT_PROXY_CONFIG,
    upstreamBase: process.env.SENTINEL_BASE ?? 'https://live.sentinelgujarat.in',
    cacheDir: CACHE_DIR,
    port: Number(process.env.RANGE_PROXY_PORT ?? DEFAULT_PROXY_CONFIG.port),
    rateLimitBytesPerSec: parseBytes(
      process.env.MIRROR_RATE_LIMIT,
      DEFAULT_PROXY_CONFIG.rateLimitBytesPerSec,
    ),
    maxCacheBytes: parseBytes(
      process.env.RANGE_PROXY_CACHE_MAX,
      DEFAULT_PROXY_CONFIG.maxCacheBytes,
    ),
    onLog: (event, fields) => {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        source: 'range-proxy',
        event,
        ...fields,
      });
      void appendFile(LOG_PATH, line + '\n').catch(() => {});
      // Retries and failures are worth seeing live; routine size lookups are not.
      if (event !== 'size') console.error(`[range-proxy] ${event}`, fields);
    },
  });

  const { url, close } = await proxy.start();
  console.error(`range proxy listening on ${url}`);
  console.error(`  upstream : ${process.env.SENTINEL_BASE ?? 'https://live.sentinelgujarat.in'}`);
  console.error(`  cache    : ${CACHE_DIR}`);
  console.error(`  log      : ${LOG_PATH}`);
  console.error(`  example  : ffmpeg -ss 36000 -i ${url}/cam/5 -t 60 -c copy out.mp4`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.error('\nshutting down range proxy');
      void close().then(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
