#!/usr/bin/env tsx
/**
 * Seed the registry from measured reality.
 *
 * Sources, in order of authority:
 *   config/cameras.yaml        — the 31 real cameras (source of truth #1)
 *   data/probe/media_probe.json — measured codec/resolution/fps/duration where we probed
 *   data/seeds/department_suggestions.csv — UNCONFIRMED suggestions only
 *
 * There are no placeholder cameras and no invented coordinates. Where we do not know something,
 * the row says so: `location_status = unverified`, `department_id = NULL`,
 * `status_source = portal_claim`.
 *
 * Idempotent — safe to re-run. It upserts by `portal_id` and never deletes a camera, mirroring
 * scripts/sync_registry.py: a camera that disappears is marked offline, not erased.
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient, type Prisma } from '@prisma/client';
import { parse } from 'yaml';
import { ROLE_PERMISSIONS, PERMISSIONS, type Role } from '@drishtinet/shared/rbac';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const CAMERAS_YAML = resolve(ROOT, 'config/cameras.yaml');
const MEDIA_PROBE = resolve(ROOT, 'data/probe/media_probe.json');
const DEPT_SUGGESTIONS = resolve(ROOT, 'data/seeds/department_suggestions.csv');

const prisma = new PrismaClient();

/** scrypt, so no dependency is added for something the platform already provides. */
function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(plain, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

// ─────────────────────────────────────────────────────────────────────────────

const DEPARTMENTS = [
  { slug: 'police', name: 'Gujarat Police', nameGu: 'ગુજરાત પોલીસ' },
  { slug: 'gsrtc', name: 'GSRTC', nameGu: 'જીએસઆરટીસી' },
  { slug: 'panchayat', name: 'Panchayat', nameGu: 'પંચાયત' },
  { slug: 'municipal', name: 'Municipal Corporation', nameGu: 'મ્યુનિસિપલ કોર્પોરેશન' },
  { slug: 'health', name: 'Health', nameGu: 'આરોગ્ય' },
] as const;

/**
 * Per-camera clock corrections read off the burned-in overlay clocks during Phase 0, all at
 * playback position 1305 s (expected recorded time 21:21:45).
 *
 * The spread is the honest measurement of how well "synchronised" the common timeline really is:
 * ~14 s across cameras 400 km apart.
 */
const TIME_SYNC_READINGS = [
  { portalId: '5', observed: '21:21:40', offsetS: -5, evidence: 'data/samples/cam_5.jpg' },
  { portalId: '11', observed: '21:21:49', offsetS: 4, evidence: 'data/samples/cam_11.jpg' },
  { portalId: '10', observed: '21:21:54', offsetS: 9, evidence: 'data/samples/cam_10.jpg' },
] as const;

interface MediaProbe {
  portal_id: string;
  width: number | null;
  height: number | null;
  codec: string | null;
  actual_fps: number | null;
  duration_s: number | null;
  size_bytes: number | null;
  error: string | null;
}

async function loadMediaProbes(): Promise<Map<string, MediaProbe>> {
  try {
    const raw = JSON.parse(await readFile(MEDIA_PROBE, 'utf8')) as { cameras: MediaProbe[] };
    return new Map(raw.cameras.map((c) => [c.portal_id, c]));
  } catch {
    console.warn('  (no media probe data found — stream metadata will be null)');
    return new Map();
  }
}

/** Minimal CSV reader: the suggestions file is ours and has a fixed shape. */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter((l) => l.trim() && !l.trimStart().startsWith('#'));
  if (lines.length < 2) return [];
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
      } else if (ch === ',' && !quoted) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]!).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = split(line);
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

// ─────────────────────────────────────────────────────────────────────────────

async function seedDepartments(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const d of DEPARTMENTS) {
    const row = await prisma.department.upsert({
      where: { slug: d.slug },
      create: { slug: d.slug, name: d.name, nameGu: d.nameGu },
      update: { name: d.name, nameGu: d.nameGu },
    });
    ids.set(d.slug, row.id);
  }
  console.log(`  departments: ${ids.size}`);
  return ids;
}

async function seedPermissions(): Promise<void> {
  for (const key of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      create: { key, description: key.replace(':', ' — ') },
      update: {},
    });
  }
  let pairs = 0;
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    for (const permissionKey of perms) {
      await prisma.rolePermission.upsert({
        where: { role_permissionKey: { role: role as Role, permissionKey } },
        create: { role: role as Role, permissionKey },
        update: {},
      });
      pairs++;
    }
  }
  console.log(`  permissions: ${PERMISSIONS.length}, role bindings: ${pairs}`);
}

async function seedUsers(deptIds: Map<string, string>): Promise<void> {
  // Dev credentials only. Documented in README; must be rotated for any non-local use.
  const users = [
    { username: 'admin', displayName: 'State Administrator', role: 'state_admin' as Role, dept: null },
    { username: 'dept.police', displayName: 'Police Dept Admin', role: 'department_admin' as Role, dept: 'police' },
    { username: 'operator', displayName: 'Control Room Operator', role: 'control_room_operator' as Role, dept: null },
    { username: 'investigator', displayName: 'Investigator', role: 'investigator' as Role, dept: null },
    { username: 'auditor', displayName: 'Auditor', role: 'auditor' as Role, dept: null },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { username: u.username },
      create: {
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        departmentId: u.dept ? deptIds.get(u.dept) ?? null : null,
        passwordHash: hashPassword(process.env.SEED_PASSWORD ?? 'drishti_dev_only'),
      },
      update: { displayName: u.displayName, role: u.role },
    });
  }
  console.log(`  users: ${users.length} (dev credentials — rotate before any non-local use)`);
}

async function seedCameras(probes: Map<string, MediaProbe>): Promise<Map<string, string>> {
  const cfg = parse(await readFile(CAMERAS_YAML, 'utf8')) as Record<string, any>;
  const ids = new Map<string, string>();

  let verified = 0;
  let unverified = 0;
  let withGeom = 0;

  for (const c of cfg.cameras as Record<string, any>[]) {
    const portalId = String(c.portal_id);
    const data = {
      label: String(c.label),
      labelNumber: c.label_number ?? null,
      name: String(c.name ?? c.label),
      district: c.district ?? null,
      cluster: c.cluster ?? null,
      locationStatus: c.location_status as 'verified' | 'approximate' | 'unverified',
      locationUncertaintyM: Number(c.location_uncertainty_m),
      status: c.status as 'online' | 'degraded' | 'offline',
      statusSource: c.status_source as 'measured' | 'portal_claim',
      lastError: c.last_error ?? null,
      notes: c.notes ?? null,
      lastSeenAt: c.last_seen ? new Date(String(c.last_seen)) : null,
    } satisfies Prisma.CameraUncheckedUpdateInput;

    const camera = await prisma.camera.upsert({
      where: { portalId },
      create: { portalId, ...data },
      // Deliberately does NOT touch departmentId: department assignment is an audited workflow,
      // and a re-seed must never silently undo a human's decision.
      update: data,
    });
    ids.set(portalId, camera.id);

    // geography must be written through raw SQL — Prisma cannot express the type.
    if (c.lat != null && c.lng != null) {
      await prisma.$executeRaw`
        UPDATE cameras
           SET geom = ST_SetSRID(ST_MakePoint(${Number(c.lng)}, ${Number(c.lat)}), 4326)::geography
         WHERE id = ${camera.id}`;
      withGeom++;
    } else {
      await prisma.$executeRaw`UPDATE cameras SET geom = NULL WHERE id = ${camera.id}`;
    }

    if (data.locationStatus === 'verified') verified++;
    if (data.locationStatus === 'unverified') unverified++;

    // Stream row, enriched with whatever we actually measured.
    const probe = probes.get(portalId);
    const existing = await prisma.stream.findFirst({ where: { cameraId: camera.id } });
    const streamData = {
      cameraId: camera.id,
      sourceType: String(c.source_type) as Prisma.StreamUncheckedCreateInput['sourceType'],
      sourceUrl: String(c.source_url),
      codec: probe?.codec ?? c.codec ?? null,
      container: c.container ?? null,
      width: probe?.width ?? null,
      height: probe?.height ?? null,
      fps: probe?.actual_fps ?? null,
      durationSeconds: probe?.duration_s ?? null,
      sizeBytes: probe?.size_bytes != null ? BigInt(probe.size_bytes) : null,
    };
    if (existing) {
      await prisma.stream.update({ where: { id: existing.id }, data: streamData });
    } else {
      await prisma.stream.create({ data: streamData });
    }
  }

  console.log(
    `  cameras: ${ids.size} (${verified} verified location, ${unverified} unverified, ` +
      `${withGeom} with coordinates)`,
  );
  return ids;
}

async function seedTimeSync(cameraIds: Map<string, string>): Promise<void> {
  let n = 0;
  for (const r of TIME_SYNC_READINGS) {
    const cameraId = cameraIds.get(r.portalId);
    if (!cameraId) continue;
    const already = await prisma.timeSync.findFirst({
      where: { cameraId, measuredFrom: 'burned_in_clock', atPositionS: 1305 },
    });
    if (already) continue;
    await prisma.timeSync.create({
      data: {
        cameraId,
        clockOffsetS: r.offsetS,
        measuredFrom: 'burned_in_clock',
        atPositionS: 1305,
        evidencePath: r.evidence,
      },
    });
    n++;
  }
  console.log(`  time_sync: ${n} readings (spread ~14 s across 400 km — the real sync tolerance)`);
}

async function seedDepartmentSuggestions(
  cameraIds: Map<string, string>,
  deptIds: Map<string, string>,
): Promise<void> {
  let n = 0;
  try {
    const rows = parseCsv(await readFile(DEPT_SUGGESTIONS, 'utf8'));
    for (const row of rows) {
      const cameraId = cameraIds.get(row.portal_id ?? '');
      const slug = (row.suggested_department ?? '').toLowerCase();
      const departmentId = deptIds.get(slug);
      if (!cameraId || !departmentId) continue;

      const already = await prisma.departmentAssignment.findFirst({
        where: { cameraId, departmentId, confirmed: false },
      });
      if (already) continue;

      await prisma.departmentAssignment.create({
        data: {
          cameraId,
          departmentId,
          basis: 'label_inference',
          rationale: row.basis ?? null,
          // Never confirmed by a seed. A department is only assigned by a human.
          confirmed: false,
          assignedBy: 'seed:label_inference',
        },
      });
      n++;
    }
  } catch {
    console.warn('  (no department suggestions file)');
  }
  console.log(`  department suggestions: ${n} (UNCONFIRMED — cameras remain unassigned)`);
}

async function seedWatchlist(): Promise<void> {
  const existing = await prisma.watchlist.findFirst({ where: { name: 'Demo watchlist' } });
  if (existing) {
    console.log('  watchlist: already present');
    return;
  }
  const wl = await prisma.watchlist.create({
    data: {
      name: 'Demo watchlist',
      description:
        'Synthetic watchlist for the demo scenario. Contains no real person or vehicle of interest.',
      createdBy: 'seed',
    },
  });
  await prisma.watchlistEntry.create({
    data: {
      watchlistId: wl.id,
      entityType: 'vehicle_plate',
      entityValue: process.env.DEMO_DESIGNATED_PLATE ?? 'GJ01AB1234',
      reason: 'Designated vehicle for the demonstration scenario (synthetic)',
      priority: 'critical',
    },
  });
  console.log('  watchlist: 1 demo list, 1 synthetic entry');
}

async function main(): Promise<void> {
  console.log('seeding DrishtiNet from measured reality\n');
  const probes = await loadMediaProbes();
  const deptIds = await seedDepartments();
  await seedPermissions();
  await seedUsers(deptIds);
  const cameraIds = await seedCameras(probes);
  await seedTimeSync(cameraIds);
  await seedDepartmentSuggestions(cameraIds, deptIds);
  await seedWatchlist();

  await prisma.auditLog.create({
    data: {
      actor: 'seed',
      action: 'registry.seeded',
      entity: 'registry',
      meta: { cameras: cameraIds.size, source: 'config/cameras.yaml' },
    },
  });

  const [summary] = await prisma.$queryRaw<
    { cameras_total: bigint; online: bigint; degraded: bigint; offline: bigint;
      status_unverified: bigint; location_unverified: bigint;
      department_unassigned: bigint; districts_covered: bigint }[]
  >`SELECT * FROM gap_analysis_summary`;

  console.log('\nregistry summary (from gap_analysis_summary):');
  for (const [k, v] of Object.entries(summary ?? {})) {
    console.log(`  ${k.padEnd(24)} ${v}`);
  }
  console.log('\nseed complete.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
