/**
 * Mock government-system endpoints.
 *
 * Every response says it is a mock three times over — in the body, in a header, and in the OpenAPI
 * description — because the one failure mode that would genuinely damage this submission is an
 * evaluator believing we have live access to a police records system.
 *
 * The endpoints exist to prove the integration shape: an alert can be enriched from an external
 * record system, the platform degrades sensibly when one is unavailable, and every enriched field
 * keeps its provenance. Replacing a mock with the real system should be a URL and a credential.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';

import { SYSTEMS, findVahan, VAHAN_FIXTURE, type SystemId } from './registry.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
try {
  process.loadEnvFile(resolve(REPO_ROOT, '.env'));
} catch {
  // Container: configuration arrives through env_file instead.
}

const PORT = Number(process.env.INTEGRATIONS_PORT ?? 4003);

/**
 * Simulated round-trip latency, in ms.
 *
 * Real government APIs are not instant, and a platform tuned against a zero-latency mock will look
 * fast in a demo and stall in production. Enrichment is therefore built to be asynchronous, and this
 * makes that visible rather than theoretical.
 */
const SIMULATED_LATENCY_MS = Number(process.env.MOCK_LATENCY_MS ?? 180);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify({ ...(body as object), mock: true }, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    // A second, transport-level statement of the same fact, for anyone reading a capture rather
    // than the rendered page.
    'x-drishtinet-mock': 'true',
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}

function notFound(res: ServerResponse, system: SystemId, query: string): void {
  // A miss is a legitimate answer, not an error: most vehicles are not on any list, and an
  // integration that treats "no record" as a failure will bury operators in false problems.
  json(res, 404, {
    system,
    found: false,
    query,
    message: `No ${SYSTEMS[system].name} record for ${query} in the demonstration fixture.`,
  });
}

const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'DrishtiNet mock government integrations',
    version: '0.1.0',
    description:
      'MOCK ONLY. These endpoints imitate the shape of VAHAN, SARTHI, eGujCop (CCTNS), AFIS and ' +
      'NAFIS so the platform can demonstrate alert enrichment. No live access to any of these ' +
      'systems is held, and no real record is served. Every response carries mock: true.',
  },
  paths: {
    '/vahan/{plate}': {
      get: {
        summary: 'MOCK vehicle registration lookup',
        parameters: [{ name: 'plate', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Mock registration record' }, 404: { description: 'Not in fixture' } },
      },
    },
    '/sarthi/{licence}': {
      get: { summary: 'MOCK driving licence lookup', responses: { 200: { description: 'Mock licence record' } } },
    },
    '/egujcop/vehicle/{plate}': {
      get: { summary: 'MOCK stolen-vehicle / wanted check', responses: { 200: { description: 'Mock CCTNS record' } } },
    },
    '/afis/status': { get: { summary: 'Integration-readiness statement only. Performs no matching.' } },
    '/nafis/status': { get: { summary: 'Integration-readiness statement only. Performs no matching.' } },
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
    });
    return res.end();
  }

  if (path === '/' || path === '/health') {
    return json(res, 200, {
      ok: true,
      systems: Object.values(SYSTEMS).map((s) => ({
        id: s.id,
        name: s.name,
        operator: s.operator,
        provides: s.provides,
        accessNote: s.accessNote,
      })),
      note: 'Every system here is a local mock. No live government access is held.',
    });
  }

  if (path === '/openapi.json') return json(res, 200, openapi);

  await delay(SIMULATED_LATENCY_MS);

  const vahan = /^\/vahan\/([^/]+)$/.exec(path);
  if (vahan) {
    const plate = decodeURIComponent(vahan[1]!);
    const record = findVahan(plate);
    if (!record) return notFound(res, 'vahan', plate);
    return json(res, 200, {
      system: 'vahan',
      found: true,
      record: {
        plate: record.plate,
        make: record.make,
        model: record.model,
        colour: record.colour,
        vehicleClass: record.vehicleClass,
        fuel: record.fuel,
        registeredAt: record.registeredAt,
        ownerName: record.ownerName,
        insuranceValidTo: record.insuranceValidTo,
        fitnessValidTo: record.fitnessValidTo,
        // Computed rather than stored, so the fixture cannot drift out of date silently.
        insuranceExpired: new Date(record.insuranceValidTo) < new Date(),
      },
    });
  }

  const egujcop = /^\/egujcop\/vehicle\/([^/]+)$/.exec(path);
  if (egujcop) {
    const plate = decodeURIComponent(egujcop[1]!);
    const record = findVahan(plate);
    if (!record?.stolen) {
      return json(res, 200, {
        system: 'egujcop',
        found: false,
        query: plate,
        message: 'Not listed as stolen or wanted in the demonstration fixture.',
      });
    }
    return json(res, 200, {
      system: 'egujcop',
      found: true,
      record: { plate: record.plate, status: 'reported_stolen', ...record.stolen },
    });
  }

  const sarthi = /^\/sarthi\/([^/]+)$/.exec(path);
  if (sarthi) {
    const licence = decodeURIComponent(sarthi[1]!);
    return json(res, 200, {
      system: 'sarthi',
      found: true,
      record: {
        licenceNumber: licence,
        holderName: 'FICTIONAL — Demo Holder',
        validTo: '2031-08-14',
        categories: ['LMV', 'MCWG'],
        note: 'Synthetic. SARTHI is not queried.',
      },
    });
  }

  const biometric = /^\/(afis|nafis)\/status$/.exec(path);
  if (biometric) {
    const system = biometric[1] as 'afis' | 'nafis';
    // Deliberately not a lookup endpoint. CLAUDE.md commits to documented integration-readiness
    // only, and shipping something that *looks* like biometric matching would break that commitment
    // even if it returned fixture data.
    return json(res, 200, {
      system,
      matchingPerformed: false,
      readiness: 'documented_only',
      message:
        `${SYSTEMS[system].name} integration is documented as ready, not implemented. This ` +
        `platform performs no biometric matching and stores no biometric data.`,
      wouldRequire: SYSTEMS[system].accessNote,
    });
  }

  json(res, 404, {
    error: 'not found',
    routes: [
      'GET /health',
      'GET /openapi.json',
      'GET /vahan/:plate',
      'GET /egujcop/vehicle/:plate',
      'GET /sarthi/:licence',
      'GET /afis/status',
      'GET /nafis/status',
    ],
    fixturePlates: VAHAN_FIXTURE.map((r) => r.plate),
  });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nintegrations: port ${PORT} is already in use.`);
    console.error(`  stop it : lsof -ti:${PORT} | xargs kill\n`);
  } else {
    console.error(`\nintegrations: could not listen on ${PORT}: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.error(`integrations (MOCK) on http://127.0.0.1:${PORT}`);
  console.error(`  systems  : ${Object.keys(SYSTEMS).join(', ')}`);
  console.error(`  latency  : ${SIMULATED_LATENCY_MS}ms simulated`);
  console.error('  note     : no live government access is held; every response is synthetic');
});
