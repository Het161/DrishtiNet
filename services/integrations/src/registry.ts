/**
 * Mock government systems.
 *
 * ── Why these are mocks, and why that is stated everywhere ───────────────────────────────────────
 *
 * VAHAN, SARTHI, eGujCop (CCTNS), AFIS and NAFIS are real systems holding real records about real
 * people. We have no access to any of them and will not pretend otherwise: every response here is
 * generated from a small local fixture, every payload carries `mock: true`, every HTTP response
 * carries an `X-DrishtiNet-Mock` header, and the interface renders a MOCK badge beside anything they
 * touched.
 *
 * That discipline is not decoration. A demonstration that quietly implies live access to a police
 * criminal-records system is making a claim about data-sharing agreements that do not exist, and an
 * evaluator who later discovers it has to discount everything else in the submission too.
 *
 * What this service is genuinely for is proving the *integration shape* — that the platform can
 * enrich an alert from an external record system, degrade when one is unavailable, and keep the
 * provenance of every field. Swapping a mock for a real endpoint should then be a URL change and a
 * credential, not a redesign.
 */

export type SystemId = 'vahan' | 'sarthi' | 'egujcop' | 'afis' | 'nafis';

export interface MockSystem {
  id: SystemId;
  name: string;
  operator: string;
  /** What the real system would answer, so the mock's scope is never mistaken for the real one. */
  provides: string;
  /** Why we cannot call the real one. Shown in the UI and in the HLD. */
  accessNote: string;
}

export const SYSTEMS: Record<SystemId, MockSystem> = {
  vahan: {
    id: 'vahan',
    name: 'VAHAN',
    operator: 'Ministry of Road Transport & Highways',
    provides: 'Vehicle registration: owner, make, model, colour, fuel, insurance and fitness status',
    accessNote:
      'Live access requires an MoRTH data-sharing agreement and a whitelisted source IP. Not held.',
  },
  sarthi: {
    id: 'sarthi',
    name: 'SARTHI',
    operator: 'Ministry of Road Transport & Highways',
    provides: 'Driving licence: holder, validity, categories, endorsements',
    accessNote: 'Same agreement as VAHAN. Not held.',
  },
  egujcop: {
    id: 'egujcop',
    name: 'eGujCop (CCTNS)',
    operator: 'Gujarat Police',
    provides: 'Stolen vehicles, wanted persons, missing persons, FIR linkage',
    accessNote:
      'Access is granted per-officer inside the police network. A hackathon entry has none, and the ' +
      'system is not reachable from outside it.',
  },
  afis: {
    id: 'afis',
    name: 'AFIS',
    operator: 'State Crime Records Bureau',
    provides: 'Fingerprint identification against the state ten-print database',
    accessNote:
      'Biometric. Integration-readiness only — this platform performs no biometric matching and ' +
      'stores no biometric data.',
  },
  nafis: {
    id: 'nafis',
    name: 'NAFIS',
    operator: 'National Crime Records Bureau',
    provides: 'National fingerprint identification, cross-state',
    accessNote: 'Biometric. Integration-readiness only, as AFIS.',
  },
};

/**
 * The fixture behind the mocks.
 *
 * Deliberately tiny and obviously synthetic. Plates follow the Gujarat format so the shared parser
 * exercises properly, but the owners are named as fictional and no real registration is used.
 */
export interface VahanRecord {
  plate: string;
  make: string;
  model: string;
  colour: string;
  vehicleClass: string;
  fuel: string;
  registeredAt: string;
  ownerName: string;
  insuranceValidTo: string;
  fitnessValidTo: string;
  /** Set when eGujCop also lists it, so the two mocks agree with each other. */
  stolen?: { firNumber: string; reportedOn: string; policeStation: string };
}

export const VAHAN_FIXTURE: VahanRecord[] = [
  {
    plate: 'GJ01AB1234',
    make: 'Maruti Suzuki',
    model: 'Swift',
    colour: 'White',
    vehicleClass: 'LMV',
    fuel: 'Petrol',
    registeredAt: 'Ahmedabad RTO (GJ-01)',
    ownerName: 'FICTIONAL — Demo Owner One',
    insuranceValidTo: '2027-03-31',
    fitnessValidTo: '2029-01-15',
    stolen: {
      firNumber: 'FICTIONAL/2026/00417',
      reportedOn: '2026-05-02',
      policeStation: 'Navrangpura (demo)',
    },
  },
  {
    plate: 'GJ18CD5678',
    make: 'Tata Motors',
    model: 'Nexon',
    colour: 'Blue',
    vehicleClass: 'LMV',
    fuel: 'Diesel',
    registeredAt: 'Gandhinagar RTO (GJ-18)',
    ownerName: 'FICTIONAL — Demo Owner Two',
    insuranceValidTo: '2026-11-30',
    fitnessValidTo: '2028-07-09',
  },
  {
    plate: 'GJ11EF9012',
    make: 'Mahindra',
    model: 'Bolero',
    colour: 'Silver',
    vehicleClass: 'LMV',
    fuel: 'Diesel',
    registeredAt: 'Junagadh RTO (GJ-11)',
    ownerName: 'FICTIONAL — Demo Owner Three',
    insuranceValidTo: '2025-12-31', // deliberately expired, so the UI has something to flag
    fitnessValidTo: '2027-04-22',
  },
];

export function findVahan(plate: string): VahanRecord | undefined {
  const key = plate.toUpperCase().replace(/\s+/g, '');
  return VAHAN_FIXTURE.find((r) => r.plate === key);
}
