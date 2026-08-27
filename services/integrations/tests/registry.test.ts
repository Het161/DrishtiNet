import { describe, expect, it } from 'vitest';

import { SYSTEMS, VAHAN_FIXTURE, findVahan } from '../src/registry.js';

/**
 * These tests are about honesty, not behaviour.
 *
 * The one failure mode that would genuinely damage this submission is an evaluator believing the
 * platform holds live access to VAHAN or to a police criminal-records system. That belief would not
 * come from a crash — it would come from a plausible-looking response nobody labelled. So what is
 * asserted here is mostly that the labels are present and the fixtures are visibly synthetic.
 */

describe('the mock systems declare what they are', () => {
  it('names every system, its operator, and why we cannot call it', () => {
    for (const system of Object.values(SYSTEMS)) {
      expect(system.name.length).toBeGreaterThan(0);
      expect(system.operator.length).toBeGreaterThan(0);
      // The access note is what stops "integration ready" being read as "integrated".
      expect(system.accessNote.length).toBeGreaterThan(20);
    }
  });

  it('covers exactly the five systems CLAUDE.md commits to mocking', () => {
    expect(Object.keys(SYSTEMS).sort()).toEqual(['afis', 'egujcop', 'nafis', 'sarthi', 'vahan']);
  });

  it('describes the biometric systems as readiness only', () => {
    // Facial and fingerprint recognition are documented integration-readiness, never implemented.
    for (const id of ['afis', 'nafis'] as const) {
      expect(SYSTEMS[id].accessNote.toLowerCase()).toContain('integration-readiness only');
    }
  });
});

describe('the fixture is visibly synthetic', () => {
  it('marks every owner as fictional', () => {
    // A realistic-looking name attached to a registration is the detail that would make someone
    // believe this is a real record.
    for (const record of VAHAN_FIXTURE) {
      expect(record.ownerName).toMatch(/^FICTIONAL/);
    }
  });

  it('marks any FIR number as fictional', () => {
    for (const record of VAHAN_FIXTURE) {
      if (record.stolen) expect(record.stolen.firNumber).toMatch(/FICTIONAL/);
    }
  });

  it('uses well-formed Gujarat plates, so the real parser is exercised', () => {
    for (const record of VAHAN_FIXTURE) {
      expect(record.plate).toMatch(/^GJ\d{2}[A-Z]{1,2}\d{4}$/);
    }
  });

  it('is small enough that nobody mistakes it for a database', () => {
    expect(VAHAN_FIXTURE.length).toBeLessThan(10);
  });
});

describe('lookup', () => {
  it('finds a plate regardless of spacing or case', () => {
    expect(findVahan('gj01ab1234')?.make).toBe('Maruti Suzuki');
    expect(findVahan('GJ 01 AB 1234')?.make).toBe('Maruti Suzuki');
  });

  it('returns nothing for a plate not in the fixture', () => {
    // A miss is a legitimate answer: most vehicles are on no list at all.
    expect(findVahan('GJ99ZZ0000')).toBeUndefined();
  });

  it('keeps the two vehicle systems agreeing with each other', () => {
    /**
     * The stolen-vehicle flag lives on the same record VAHAN serves, so eGujCop cannot report a
     * plate stolen that VAHAN has never registered. Two mocks that contradict each other would
     * produce an enrichment panel that is internally inconsistent on screen.
     */
    const stolen = VAHAN_FIXTURE.filter((r) => r.stolen);
    expect(stolen.length).toBeGreaterThan(0);
    for (const record of stolen) {
      expect(findVahan(record.plate)).toBeDefined();
    }
  });

  it('includes an expired-insurance case worth surfacing', () => {
    // Without one, the enrichment panel has nothing to flag and the demo shows only happy paths.
    const expired = VAHAN_FIXTURE.filter((r) => new Date(r.insuranceValidTo) < new Date());
    expect(expired.length).toBeGreaterThan(0);
  });
});
