#!/usr/bin/env tsx
/**
 * The alerts service.
 *
 * Consumes finished vehicle signatures from the bus, matches them against the active watchlist,
 * persists whatever matched, and pushes it to every connected operator.
 *
 * ── Why a consumer group ────────────────────────────────────────────────────────────────────────
 *
 * Redis Streams with a consumer group, not pub/sub. Pub/sub drops anything published while nobody
 * is listening, so restarting this service during a demo would silently lose every alert raised in
 * the gap. A consumer group holds unacknowledged entries until they are processed, which is the
 * behaviour a control room needs: an alert missed is an alert that never existed.
 *
 * ── Why SSE and not WebSockets ──────────────────────────────────────────────────────────────────
 *
 * The alert feed is one-directional — the server pushes, the browser listens. SSE reconnects on its
 * own, survives a proxy that buffers, and needs no framing library. Acknowledging an alert is a
 * normal POST, which is the only thing that travels the other way.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Redis } from 'ioredis';
import { Pool } from 'pg';

import { STREAM_KEYS, CONSUMER_GROUPS } from '@drishtinet/shared/events';
import {
  matchSignature,
  type Match,
  type ObservedSignature,
  type WatchlistTarget,
} from './matcher.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');

try {
  process.loadEnvFile(resolve(ROOT, '.env'));
} catch {
  // Absent in the container, where configuration arrives through env_file.
}

const PORT = Number(process.env.ALERTS_PORT ?? 4002);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const DATABASE_URL = (process.env.DATABASE_URL ?? '').split('?')[0];
const CONSUMER_NAME = `alerts-${process.pid}`;

/** Re-read the watchlist at most this often — it changes by human action, not by the second. */
const WATCHLIST_REFRESH_MS = 30_000;

const pool = new Pool({ connectionString: DATABASE_URL });
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });

// ── operator connections ──────────────────────────────────────────────────────

const subscribers = new Set<ServerResponse>();

function broadcast(event: string, data: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subscribers) {
    res.write(frame);
  }
}

// ── watchlist ─────────────────────────────────────────────────────────────────

let watchlist: WatchlistTarget[] = [];
let watchlistLoadedAt = 0;

async function loadWatchlist(force = false): Promise<WatchlistTarget[]> {
  if (!force && Date.now() - watchlistLoadedAt < WATCHLIST_REFRESH_MS) return watchlist;

  const { rows } = await pool.query(
    `select e.id, e.entity_type, e.entity_value, e.reason, e.priority
       from watchlist_entries e
       join watchlists w on w.id = e.watchlist_id
      where e.active and w.active`,
  );

  // Enrolled reference views, when a target has been seen before. A plate entry with no enrolled
  // appearance can only ever match on a legible plate, which on this grid is rare — worth knowing
  // when reading why something did not alert.
  const { rows: enrolled } = await pool.query(
    `select entry_id, embedding from watchlist_embeddings`,
  ).catch(() => ({ rows: [] as { entry_id: string; embedding: number[] }[] }));

  const byEntry = new Map<string, number[][]>();
  for (const row of enrolled) {
    const list = byEntry.get(row.entry_id) ?? [];
    list.push(row.embedding);
    byEntry.set(row.entry_id, list);
  }

  watchlist = rows.map((r) => ({
    entryId: r.id,
    entityType: r.entity_type,
    entityValue: r.entity_value,
    reason: r.reason,
    priority: r.priority,
    embeddings: byEntry.get(r.id),
  }));
  watchlistLoadedAt = Date.now();
  return watchlist;
}

// ── the hot path ──────────────────────────────────────────────────────────────

async function persistAlert(signature: ObservedSignature, match: Match): Promise<unknown> {
  // Measured end to end: from the moment the signature became known to the moment the alert row
  // exists. Reporting only our own share of it would flatter the number that matters.
  const latencyMs = Math.max(0, Math.round(Date.now() - signature.detectedAtMs));

  const id = 'c' + randomUUID().replace(/-/g, '').slice(0, 24);

  // One alert per (track, watchlist entry). A vehicle crossing a junction is identified several
  // times as more views accumulate; without this each sighting would add another line to the
  // operator's screen, and thirty alerts for one car is how a control room learns to ignore the
  // panel entirely. A later, better-supported identification updates the alert in place — and only
  // upward, so a weaker re-read can never quietly downgrade a match already acted on.
  const { rows } = await pool.query(
    `insert into alerts
       (id, source, mock, priority, status, entity_type, entity_value, reason,
        watchlist_entry_id, camera_id, track_id, confidence, repaired, matched_via,
        pipeline_latency_ms, recorded_at, created_at)
     values ($1,$2,false,$3,'new',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
     on conflict (track_id, watchlist_entry_id) where track_id is not null
                                                  and watchlist_entry_id is not null
     do update set
       confidence  = greatest(alerts.confidence, excluded.confidence),
       matched_via = case when excluded.confidence > alerts.confidence
                          then excluded.matched_via else alerts.matched_via end,
       repaired    = case when excluded.confidence > alerts.confidence
                          then excluded.repaired else alerts.repaired end,
       -- recorded_at deliberately NOT updated. It marks when this vehicle was first flagged, which
       -- is what an officer asked to intercept it needs to know. Overwriting it with each later
       -- sighting would leave the alert permanently claiming it had only just been raised.
       last_seen_at = excluded.recorded_at
     returning id, priority, status, entity_type, entity_value, reason, confidence,
               matched_via, repaired, pipeline_latency_ms, recorded_at, created_at,
               track_id, (xmax = 0) as is_new`,
    [
      id,
      match.source,
      match.entry.priority,
      match.entry.entityType,
      match.entry.entityValue,
      match.entry.reason,
      match.entry.entryId,
      signature.cameraId,
      signature.trackId,
      match.confidence,
      match.repaired,
      match.matchedVia,
      latencyMs,
      new Date(signature.recordedAtMs),
    ],
  );

  return {
    ...rows[0],
    cameraLabel: signature.cameraLabel,
    trackId: signature.trackId,
    colour: signature.colour,
    colourUncertain: signature.colourUncertain,
    cls: signature.cls,
  };
}

function parseSignature(fields: Record<string, string>): ObservedSignature {
  return {
    trackId: fields.track_id!,
    cameraId: fields.camera_id!,
    cameraLabel: fields.camera_label ?? '',
    cls: fields.cls ?? 'car',
    colour: fields.colour || null,
    colourConfidence: Number(fields.colour_confidence ?? 0),
    colourUncertain: fields.colour_uncertain === '1' || fields.colour_uncertain === 'true',
    partialPlate: fields.partial_plate || null,
    embedding: fields.embedding ? (JSON.parse(fields.embedding) as number[]) : [],
    embeddingModel: fields.embedding_model || null,
    recordedAtMs: Number(fields.recorded_at_ms ?? 0),
    detectedAtMs: Number(fields.detected_at_ms ?? Date.now()),
  };
}

let processed = 0;
let raised = 0;
const latencies: number[] = [];

async function consume(): Promise<void> {
  const stream = STREAM_KEYS.signatures;
  const group = CONSUMER_GROUPS.alertsEngine;

  try {
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (err) {
    // BUSYGROUP simply means a previous run already created it.
    if (!String(err).includes('BUSYGROUP')) throw err;
  }

  for (;;) {
    const response = (await redis.xreadgroup(
      'GROUP', group, CONSUMER_NAME,
      'COUNT', 50,
      'BLOCK', 5_000,
      'STREAMS', stream, '>',
    )) as [string, [string, string[]][]][] | null;

    if (!response) continue;

    const targets = await loadWatchlist();

    for (const [, entries] of response) {
      for (const [entryId, flat] of entries) {
        try {
          const fields: Record<string, string> = {};
          for (let i = 0; i < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!;

          const signature = parseSignature(fields);
          processed += 1;

          for (const match of matchSignature(signature, targets)) {
            const alert = (await persistAlert(signature, match)) as {
              pipeline_latency_ms: number;
              is_new: boolean;
            };
            if (alert.is_new) {
              raised += 1;
              latencies.push(alert.pipeline_latency_ms);
            }
            // Updates are broadcast too, so a card already on screen shows the better match
            // rather than going stale — but they do not count as a new alert.
            broadcast(alert.is_new ? 'alert' : 'alert.updated', alert);
          }
        } catch (err) {
          // One malformed event must not stall the queue behind it.
          console.error('failed to process signature:', err);
        } finally {
          await redis.xack(stream, group, entryId);
        }
      }
    }
  }
}

// ── http ──────────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/$/, '') || '/';

  if (path === '/health') {
    return json(res, 200, {
      ok: true,
      subscribers: subscribers.size,
      watchlistEntries: watchlist.length,
      signaturesProcessed: processed,
      alertsRaised: raised,
      // The budget in CLAUDE.md is detection → UI under 500 ms. Report the measurement, not the aim.
      latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    });
  }

  if (path === '/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // Nginx and friends buffer text/event-stream by default, which turns a live feed into a
      // batch delivered minutes late.
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    subscribers.add(res);
    // A heartbeat keeps intermediaries from closing an idle connection during a quiet period,
    // which on a control-room wall would look exactly like the system having died.
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      subscribers.delete(res);
    });
    return;
  }

  if (path === '/alerts') {
    const { rows } = await pool.query(
      `select a.id, a.priority, a.status, a.entity_type, a.entity_value, a.reason,
              a.confidence, a.matched_via, a.repaired, a.pipeline_latency_ms,
              a.recorded_at, a.created_at, c.label as camera_label
         from alerts a join cameras c on c.id = a.camera_id
        order by a.created_at desc limit 100`,
    );
    return json(res, 200, { count: rows.length, alerts: rows });
  }

  json(res, 404, { error: 'not found', routes: ['GET /health', 'GET /stream', 'GET /alerts'] });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nalerts: port ${PORT} is already in use.`);
    console.error(`  stop it : lsof -ti:${PORT} | xargs kill\n`);
  } else {
    console.error(`\nalerts: could not listen on ${PORT}: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, async () => {
  console.error(`alerts on http://127.0.0.1:${PORT}`);
  await redis.connect();
  await loadWatchlist(true);
  console.error(`  watchlist : ${watchlist.length} active entries`);
  console.error(`  consuming : ${STREAM_KEYS.signatures}`);
  consume().catch((err) => {
    console.error('consumer stopped:', err);
    process.exit(1);
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const res of subscribers) res.end();
    void redis.quit().finally(() => pool.end().finally(() => process.exit(0)));
  });
}
