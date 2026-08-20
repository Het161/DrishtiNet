/**
 * Caching HTTP range proxy for the Sentinel portal.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────
 *
 * The portal's origin serves *ranged* GETs reliably at any depth — measured on camera 5 (2.5 GB):
 * byte ranges at 10 %, 50 %, 85 % and 95 % all returned `206` with full payloads. But an
 * **un-ranged** GET frequently returns `200` with an empty body, and that is the very first thing
 * FFmpeg does when you point it at a URL. Because these MP4s are not `faststart`, FFmpeg then has
 * to reach the `moov` atom at the end of the file before it can seek at all. The result:
 *
 *     ffmpeg -ss 36000 -i https://…/stream/5   →   "Stream ends prematurely at 0"
 *
 * That is not a mirroring inconvenience. `services/stream-gateway/src/publisher.ts` runs exactly
 * that command for the live video wall, so the fragile path is the one the demo stands on.
 *
 * This proxy sits in front and guarantees three things FFmpeg cannot get from the origin directly:
 *
 *   1. **Every upstream request is ranged.** An un-ranged client GET is served by walking chunks,
 *      so the origin never sees the request shape that fails.
 *   2. **Each chunk is retried independently** with exponential backoff and jitter. A single flaky
 *      chunk no longer kills a 12-hour seek.
 *   3. **Hot regions are cached on disk.** FFmpeg re-reads `moov` on every open; after the first
 *      fetch that is local. Repeated seeks stop costing the portal anything at all.
 *
 * It is also the politeness enforcement point: one upstream request in flight per camera and a
 * global token-bucket rate limit, regardless of how many consumers are attached.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { request } from 'undici';

export interface RangeProxyConfig {
  upstreamBase: string;
  cacheDir: string;
  /** Hard ceiling on disk used by the chunk cache. Evicted least-recently-used first. */
  maxCacheBytes: number;
  chunkSize: number;
  /** Global throttle across every camera, in bytes per second. */
  rateLimitBytesPerSec: number;
  port: number;
  userAgent: string;
  onLog?: (event: string, fields: Record<string, unknown>) => void;
}

export const DEFAULT_PROXY_CONFIG: Omit<RangeProxyConfig, 'cacheDir' | 'upstreamBase'> = {
  maxCacheBytes: 2 * 1024 * 1024 * 1024, // 2 GiB — disk is scarce on the demo laptop
  chunkSize: 4 * 1024 * 1024, // 4 MiB
  rateLimitBytesPerSec: 2 * 1024 * 1024, // 2 MB/s, per CLAUDE.md
  port: 4010,
  userAgent:
    'DrishtiNet-Sentinel2026/0.1 (Gujarat Police Innovation Challenge participant; hetpatelsk@gmail.com)',
};

const MAX_CHUNK_ATTEMPTS = 6;

/** Parse `bytes=start-end`. Returns null for absent/unsupported forms (multi-range, suffix). */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;

  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    // Suffix form: last N bytes. FFmpeg uses this to find `moov`, so it must work.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/** Which chunk indices cover [start, end]. */
export function chunksFor(start: number, end: number, chunkSize: number): number[] {
  const first = Math.floor(start / chunkSize);
  const last = Math.floor(end / chunkSize);
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

/** Simple token bucket. Shared by every camera so total upstream draw stays bounded. */
class RateLimiter {
  private tokens: number;
  private last = Date.now();

  constructor(private readonly bytesPerSec: number) {
    this.tokens = bytesPerSec;
  }

  async take(bytes: number): Promise<void> {
    // Never deadlock on a request larger than one second's budget.
    let remaining = Math.min(bytes, this.bytesPerSec * 8);
    while (remaining > 0) {
      const now = Date.now();
      this.tokens = Math.min(
        this.bytesPerSec,
        this.tokens + ((now - this.last) / 1000) * this.bytesPerSec,
      );
      this.last = now;
      if (this.tokens >= 1) {
        const spend = Math.min(this.tokens, remaining);
        this.tokens -= spend;
        remaining -= spend;
      }
      if (remaining > 0) await new Promise((r) => setTimeout(r, 100));
    }
  }
}

export class RangeProxy {
  private readonly sizes = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<Buffer>>();
  /** One upstream request per camera at a time — the politeness rule, enforced structurally. */
  private readonly cameraLocks = new Map<string, Promise<unknown>>();
  private readonly limiter: RateLimiter;
  private cacheBytes = 0;

  constructor(private readonly cfg: RangeProxyConfig) {
    this.limiter = new RateLimiter(cfg.rateLimitBytesPerSec);
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.cfg.onLog?.(event, fields);
  }

  private upstreamUrl(cameraId: string): string {
    return `${this.cfg.upstreamBase.replace(/\/$/, '')}/stream/${encodeURIComponent(cameraId)}`;
  }

  private chunkPath(cameraId: string, index: number): string {
    const safe = createHash('sha1').update(cameraId).digest('hex').slice(0, 12);
    return join(this.cfg.cacheDir, safe, `${index}.bin`);
  }

  /** Serialise upstream work per camera without blocking other cameras. */
  private async withCameraLock<T>(cameraId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.cameraLocks.get(cameraId) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    // Keep the chain alive but never let a rejection poison the next waiter.
    this.cameraLocks.set(cameraId, run.then(() => undefined, () => undefined));
    return run;
  }

  /** File size via a 1-byte ranged GET — costs one byte and works when plain GET does not. */
  async size(cameraId: string): Promise<number> {
    const cached = this.sizes.get(cameraId);
    if (cached !== undefined) return cached;

    const res = await this.withCameraLock(cameraId, () =>
      request(this.upstreamUrl(cameraId), {
        method: 'GET',
        headers: { range: 'bytes=0-0', 'user-agent': this.cfg.userAgent },
        headersTimeout: 30_000,
        bodyTimeout: 30_000,
      }),
    );
    await res.body.arrayBuffer(); // drain

    const contentRange = res.headers['content-range'];
    const raw = Array.isArray(contentRange) ? contentRange[0] : contentRange;
    const total = raw?.split('/')[1];
    if (!total || !/^\d+$/.test(total)) {
      throw new Error(`upstream did not report a size for camera ${cameraId}`);
    }
    const size = Number(total);
    this.sizes.set(cameraId, size);
    this.log('size', { camera: cameraId, size });
    return size;
  }

  private async readCachedChunk(cameraId: string, index: number): Promise<Buffer | null> {
    try {
      return await readFile(this.chunkPath(cameraId, index));
    } catch {
      return null;
    }
  }

  private async writeCachedChunk(cameraId: string, index: number, data: Buffer): Promise<void> {
    const path = this.chunkPath(cameraId, index);
    try {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, data);
      this.cacheBytes += data.byteLength;
      if (this.cacheBytes > this.cfg.maxCacheBytes) await this.evict();
    } catch (err) {
      // A cache write failure must never fail the request it was trying to accelerate.
      this.log('cache_write_failed', { camera: cameraId, index, error: String(err) });
    }
  }

  /** Least-recently-used eviction down to 80 % of the cap. */
  private async evict(): Promise<void> {
    try {
      const entries: { path: string; atime: number; size: number }[] = [];
      for (const dir of await readdir(this.cfg.cacheDir)) {
        const dirPath = join(this.cfg.cacheDir, dir);
        for (const file of await readdir(dirPath).catch(() => [])) {
          const p = join(dirPath, file);
          const s = await stat(p).catch(() => null);
          if (s?.isFile()) entries.push({ path: p, atime: s.atimeMs, size: s.size });
        }
      }
      entries.sort((a, b) => a.atime - b.atime);
      let total = entries.reduce((n, e) => n + e.size, 0);
      const target = this.cfg.maxCacheBytes * 0.8;
      for (const e of entries) {
        if (total <= target) break;
        await unlink(e.path).catch(() => {});
        total -= e.size;
      }
      this.cacheBytes = total;
      this.log('cache_evicted', { bytes: total });
    } catch (err) {
      this.log('cache_evict_failed', { error: String(err) });
    }
  }

  /**
   * One chunk, from cache or upstream. Concurrent callers for the same chunk share a single fetch,
   * so a burst of FFmpeg reads never multiplies into duplicate upstream requests.
   */
  async chunk(cameraId: string, index: number): Promise<Buffer> {
    const key = `${cameraId}:${index}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const task = (async () => {
      const cached = await this.readCachedChunk(cameraId, index);
      if (cached) return cached;

      const size = await this.size(cameraId);
      const start = index * this.cfg.chunkSize;
      if (start >= size) return Buffer.alloc(0);
      const end = Math.min(start + this.cfg.chunkSize - 1, size - 1);

      let lastError: unknown = null;
      for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS; attempt++) {
        try {
          await this.limiter.take(end - start + 1);
          const buf = await this.withCameraLock(cameraId, async () => {
            const res = await request(this.upstreamUrl(cameraId), {
              method: 'GET',
              headers: {
                range: `bytes=${start}-${end}`,
                'user-agent': this.cfg.userAgent,
              },
              headersTimeout: 30_000,
              bodyTimeout: 120_000,
            });
            if (res.statusCode !== 206 && res.statusCode !== 200) {
              await res.body.dump();
              throw new Error(`upstream HTTP ${res.statusCode}`);
            }
            return Buffer.from(await res.body.arrayBuffer());
          });

          // The origin's failure mode is a success status with an empty body — treat it as failure.
          if (buf.byteLength === 0) throw new Error('upstream returned an empty body');

          await this.writeCachedChunk(cameraId, index, buf);
          return buf;
        } catch (err) {
          lastError = err;
          const backoff = Math.min(30_000, 2 ** attempt * 500) * (0.5 + Math.random());
          this.log('chunk_retry', {
            camera: cameraId, index, attempt: attempt + 1,
            error: String(err), backoffMs: Math.round(backoff),
          });
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
      throw new Error(`chunk ${index} for camera ${cameraId} failed: ${String(lastError)}`);
    })().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, task);
    return task;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/cam\/([^/]+)$/.exec(url.pathname);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cached: [...this.sizes.keys()] }));
      return;
    }
    if (!match) {
      res.writeHead(404).end('not found');
      return;
    }

    const cameraId = decodeURIComponent(match[1]!);
    let size: number;
    try {
      size = await this.size(cameraId);
    } catch (err) {
      this.log('size_failed', { camera: cameraId, error: String(err) });
      res.writeHead(502, { 'content-type': 'text/plain' }).end(`upstream unavailable: ${err}`);
      return;
    }

    const range = parseRangeHeader(req.headers.range, size);
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const length = end - start + 1;

    // Advertising range support is what lets FFmpeg seek instead of streaming from byte 0.
    const headers: Record<string, string> = {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      'content-length': String(length),
    };
    if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;

    if (req.method === 'HEAD') {
      res.writeHead(range ? 206 : 200, headers).end();
      return;
    }

    res.writeHead(range ? 206 : 200, headers);

    try {
      for (const index of chunksFor(start, end, this.cfg.chunkSize)) {
        if (res.destroyed) return; // client (FFmpeg) seeked away or exited
        const buf = await this.chunk(cameraId, index);
        if (buf.byteLength === 0) break;

        const chunkStart = index * this.cfg.chunkSize;
        const sliceFrom = Math.max(0, start - chunkStart);
        const sliceTo = Math.min(buf.byteLength, end - chunkStart + 1);
        if (sliceTo <= sliceFrom) continue;

        const slice = buf.subarray(sliceFrom, sliceTo);
        if (!res.write(slice)) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
      res.end();
    } catch (err) {
      this.log('stream_failed', { camera: cameraId, start, end, error: String(err) });
      res.destroy();
    }
  }

  async start(): Promise<{ url: string; close: () => Promise<void> }> {
    await mkdir(this.cfg.cacheDir, { recursive: true });
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => res.destroyed || res.destroy());
    });
    // Long seeks legitimately take minutes; the default 2-minute timeout would kill them.
    server.requestTimeout = 0;
    server.headersTimeout = 0;

    await new Promise<void>((resolve) => server.listen(this.cfg.port, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${this.cfg.port}`;
    this.log('proxy_started', { url, upstream: this.cfg.upstreamBase });

    return {
      url,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }
}
