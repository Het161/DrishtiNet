/**
 * The concurrent-pull ceiling, as a pure decision.
 *
 * The organisers give every client its own copy of a stream, so each camera we open is a real cost
 * on infrastructure shared with every other team. LIVE_PULL_MAX bounds that cost. It lives here,
 * apart from the HTTP layer, so the rule can be tested without a socket — and so there is exactly
 * one place to read to find out what our concurrency policy actually is.
 */

/** A camera currently holding an upstream connection. */
export interface PullSlot {
  cameraId: string;
  subscribers: number;
  /**
   * True when the last subscriber has left but ffmpeg is still connected, waiting out the idle
   * timeout. A draining camera still occupies a slot — it still holds a connection open.
   */
  draining: boolean;
}

export type PullDecision =
  | { admit: true; reason: 'already-held' | 'slot-available' }
  | { admit: false; reason: 'ceiling-reached'; drainingSoon: string[] };

/**
 * May we open `cameraId`?
 *
 * Two things this deliberately gets right:
 *
 *  - **Draining cameras count.** Counting only cameras with live subscribers would let a caller
 *    release five and immediately take five more, holding ten connections at once. The connection,
 *    not the subscriber, is the scarce resource.
 *  - **Re-subscribing is always free.** A second viewer on a camera we already pull costs no new
 *    upstream connection, so it is admitted even at the ceiling. Refusing it would push callers
 *    toward opening their own direct connections, which is the outcome the limit exists to prevent.
 */
export function admitPull(
  cameraId: string,
  active: readonly PullSlot[],
  livePullMax: number,
): PullDecision {
  if (active.some((a) => a.cameraId === cameraId)) {
    return { admit: true, reason: 'already-held' };
  }
  if (active.length < livePullMax) {
    return { admit: true, reason: 'slot-available' };
  }
  return {
    admit: false,
    reason: 'ceiling-reached',
    drainingSoon: active.filter((a) => a.draining).map((a) => a.cameraId),
  };
}
