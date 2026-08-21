import { describe, expect, it } from 'vitest';

import { admitPull, type PullSlot } from './pull-budget.js';

const held = (cameraId: string): PullSlot => ({ cameraId, subscribers: 1, draining: false });
const draining = (cameraId: string): PullSlot => ({ cameraId, subscribers: 0, draining: true });

describe('admitPull — the concurrent upstream ceiling', () => {
  it('admits while under the ceiling', () => {
    const d = admitPull('10', [held('5'), held('16')], 5);
    expect(d).toEqual({ admit: true, reason: 'slot-available' });
  });

  it('refuses the (LIVE_PULL_MAX + 1)th distinct camera', () => {
    const active = ['1', '2', '3', '4', '5'].map(held);
    const d = admitPull('10', active, 5);
    expect(d.admit).toBe(false);
  });

  /**
   * The bug this guards against: counting only live subscribers would let a caller release five
   * cameras and immediately take five more, holding ten upstream connections at once. ffmpeg is
   * still connected during the idle window, so a draining camera still spends a slot.
   */
  it('counts draining cameras against the ceiling', () => {
    const active = ['1', '2', '3', '4', '5'].map(draining);
    const d = admitPull('10', active, 5);
    expect(d.admit).toBe(false);
    if (!d.admit) expect(d.drainingSoon).toEqual(['1', '2', '3', '4', '5']);
  });

  it('names only the draining cameras as the ones that free up on their own', () => {
    const active = [held('1'), draining('2'), held('3'), draining('4'), held('5')];
    const d = admitPull('10', active, 5);
    expect(d.admit).toBe(false);
    if (!d.admit) expect(d.drainingSoon).toEqual(['2', '4']);
  });

  /**
   * A second viewer on a camera we already pull costs no new upstream connection. Refusing it would
   * push callers toward opening their own direct connections — the outcome the limit exists to
   * prevent.
   */
  it('admits a re-subscribe to a camera already held, even at the ceiling', () => {
    const active = ['1', '2', '3', '4', '5'].map(held);
    const d = admitPull('3', active, 5);
    expect(d).toEqual({ admit: true, reason: 'already-held' });
  });

  it('admits a re-subscribe to a draining camera, cancelling its idle stop', () => {
    const active = [held('1'), held('2'), held('3'), held('4'), draining('5')];
    const d = admitPull('5', active, 5);
    expect(d).toEqual({ admit: true, reason: 'already-held' });
  });

  it('refuses everything at a ceiling of zero', () => {
    expect(admitPull('10', [], 0).admit).toBe(false);
  });

  it('never admits past the ceiling across a full subscribe sequence', () => {
    const active: PullSlot[] = [];
    const admitted: string[] = [];
    for (const id of ['1', '2', '3', '4', '5', '6', '7', '8']) {
      if (admitPull(id, active, 5).admit) {
        active.push(held(id));
        admitted.push(id);
      }
    }
    expect(admitted).toEqual(['1', '2', '3', '4', '5']);
    expect(active).toHaveLength(5);
  });
});
