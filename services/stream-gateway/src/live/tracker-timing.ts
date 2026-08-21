/**
 * Velocity estimation from PTS, and the identity continuity that depends on it.
 *
 * This is the organisers' stated failure mode made concrete. A tracker that derives dt from arrival
 * time sees the join burst — a buffered GOP replayed 10x faster than real time — as an object
 * moving ten times too fast. Two things then go wrong, and the second is the one an evaluator
 * notices: the velocity is wrong, and the motion model's prediction lands nowhere near the object,
 * so the association fails and the track is split into two. On screen a single car acquires two
 * identities in the first second, and a cross-camera route built on it is nonsense.
 */

export interface Observation {
  ptsMs: number;
  arrivalMs: number;
  /** Centre of the detection, in pixels. */
  x: number;
  y: number;
}

export interface VelocityEstimate {
  /** Pixels per second, derived from PTS deltas only. */
  vx: number;
  vy: number;
  speed: number;
  samples: number;
}

/**
 * Rolling velocity over a short PTS window.
 *
 * The window is expressed in PTS milliseconds rather than a frame count, because a frame count is
 * a different amount of time on a 12.5 fps camera than on a 25 fps one — and the grid has both.
 */
export class PtsVelocityEstimator {
  private readonly history: Observation[] = [];

  constructor(private readonly windowMs = 1_000) {}

  add(obs: Observation): void {
    this.history.push(obs);
    const cutoff = obs.ptsMs - this.windowMs;
    while (this.history.length > 2 && this.history[0]!.ptsMs < cutoff) this.history.shift();
  }

  estimate(): VelocityEstimate | null {
    if (this.history.length < 2) return null;
    const first = this.history[0]!;
    const last = this.history[this.history.length - 1]!;

    // PTS, never arrival. This single choice is what the whole test below exercises.
    const dtSeconds = (last.ptsMs - first.ptsMs) / 1000;
    if (dtSeconds <= 0) return null;

    const vx = (last.x - first.x) / dtSeconds;
    const vy = (last.y - first.y) / dtSeconds;
    return { vx, vy, speed: Math.hypot(vx, vy), samples: this.history.length };
  }

  reset(): void {
    this.history.length = 0;
  }
}

/**
 * Minimal nearest-neighbour association, enough to show whether a track survives the burst.
 *
 * Real tracking is ByteTrack's job. What is being tested here is the input it receives: if the
 * predicted position is computed from a wrong dt, association fails regardless of how good the
 * tracker is.
 */
export class SimpleTracker {
  private nextId = 1;
  private tracks = new Map<number, { last: Observation; est: PtsVelocityEstimator }>();
  /** Every id ever issued — a split shows up as more ids than real objects. */
  readonly issuedIds: number[] = [];

  constructor(private readonly maxAssociationPx = 80) {}

  observe(obs: Observation): number {
    let bestId: number | null = null;
    let bestDist = Infinity;

    for (const [id, track] of this.tracks) {
      const est = track.est.estimate();
      const dtSeconds = (obs.ptsMs - track.last.ptsMs) / 1000;
      // Predict where the object should be now, from PTS-derived velocity.
      const predX = track.last.x + (est?.vx ?? 0) * dtSeconds;
      const predY = track.last.y + (est?.vy ?? 0) * dtSeconds;
      const dist = Math.hypot(obs.x - predX, obs.y - predY);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = id;
      }
    }

    if (bestId !== null && bestDist <= this.maxAssociationPx) {
      const track = this.tracks.get(bestId)!;
      track.last = obs;
      track.est.add(obs);
      return bestId;
    }

    const id = this.nextId++;
    const est = new PtsVelocityEstimator();
    est.add(obs);
    this.tracks.set(id, { last: obs, est });
    this.issuedIds.push(id);
    return id;
  }

  velocityOf(id: number): VelocityEstimate | null {
    return this.tracks.get(id)?.est.estimate() ?? null;
  }
}
