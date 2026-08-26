/**
 * One vehicle's route across the grid.
 *
 * Reached from a search result or an alert. The page's job is not to look confident — it is to let
 * an investigator see exactly how much of this is evidence and how much is inference, because a
 * route is a chain of probabilistic matches presented as a sequence of facts, and that is a
 * dangerous shape unless every link shows its own strength.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { reconstructRoute, APPEARANCE_THRESHOLD, MAX_PLAUSIBLE_SPEED_KMH } from '@/lib/route';

export const dynamic = 'force-dynamic';

function clock(value: Date): string {
  return new Date(value).toLocaleTimeString('en-GB', { hour12: false });
}

export default async function RoutePage({ params }: { params: Promise<{ trackId: string }> }) {
  const { trackId } = await params;
  const route = await reconstructRoute(trackId);
  if (!route) notFound();

  // The seed is the sighting the operator picked, which after chronological ordering may sit
  // anywhere in the sequence — not necessarily first.
  const seed = route.sightings.find((s) => s.trackId === route.seedTrackId) ?? route.sightings[0]!;
  const onlySighting = route.sightings.length === 1;

  return (
    <main className="mx-auto max-w-4xl px-6 py-6">
      <header className="mb-6">
        <Link
          href="/operations"
          className="text-sm text-[var(--color-teal)] underline underline-offset-4"
        >
          ← Operations
        </Link>
        <h1 className="mt-3 text-xl font-semibold tracking-tight">
          Route — <span className="capitalize">{seed.colour ?? 'unknown'} {seed.cls}</span>
        </h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {route.sightings.length} sighting{route.sightings.length === 1 ? '' : 's'} · reconstructed
          in {route.queryMs} ms
        </p>
      </header>

      {onlySighting ? (
        <div className="mb-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <p className="font-medium">Seen once, on one camera.</p>
          <p className="mt-2 max-w-2xl text-sm text-[var(--color-muted)]">
            No other camera recorded a vehicle matching this one closely enough to be the same. That
            is a finding, not a failure — most vehicles pass a single camera and are never seen
            again.
          </p>
        </div>
      ) : null}

      <ol className="relative mb-6">
        {route.sightings.map((s, i) => (
          <li key={s.trackId} className="relative flex gap-4 pb-6 last:pb-0">
            {i < route.sightings.length - 1 && (
              <span
                aria-hidden
                className="absolute left-[11px] top-6 h-full w-px bg-[var(--color-border)]"
              />
            )}
            <span
              aria-hidden
              className="relative z-10 mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-elevated)] font-mono text-[11px]"
            >
              {i + 1}
            </span>

            <div className="min-w-0 flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {s.cameraName}
                  {s.trackId === route.seedTrackId && (
                    <span className="ml-2 rounded bg-[var(--color-elevated)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-[var(--color-teal)]">
                      selected
                    </span>
                  )}
                </span>
                <span className="font-mono text-xs tabular-nums text-[var(--color-muted)]">
                  {clock(s.recordedAt)}
                </span>
              </div>

              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
                <dt>Appearance</dt>
                <dd className="text-[var(--color-text)]">
                  <span className="capitalize">{s.colour ?? 'unknown'} {s.cls}</span>
                  {s.colourUncertain && (
                    <span className="ml-1 text-[var(--color-high)]">colour uncertain</span>
                  )}
                </dd>

                {s.similarity !== null && (
                  <>
                    <dt>Match to selected</dt>
                    <dd className="font-mono tabular-nums text-[var(--color-text)]">
                      {s.similarity.toFixed(3)}
                      <span className="ml-1 text-[var(--color-muted)]">
                        (threshold {APPEARANCE_THRESHOLD})
                      </span>
                    </dd>
                  </>
                )}

                {i > 0 && (
                  <>
                    <dt>Leg</dt>
                    <dd>
                      {s.legVerifiable ? (
                        <span className="text-[var(--color-text)]">
                          {s.legKm !== null && <>{s.legKm} km</>}
                          {s.legSpeedKmh !== null && (
                            <span className="ml-1 font-mono tabular-nums">
                              · {s.legSpeedKmh} km/h
                            </span>
                          )}
                          {s.legSpeedKmh === null && s.legKm !== null && (
                            <span className="ml-1 text-[var(--color-muted)]">
                              · effectively the same place
                            </span>
                          )}
                        </span>
                      ) : (
                        // The distinction that matters most on this page.
                        <span className="text-[var(--color-high)]">
                          not verifiable — {s.cameraName} has no placed position
                        </span>
                      )}
                    </dd>
                  </>
                )}

                <dt>Position</dt>
                <dd>
                  {s.lat === null ? (
                    <span className="text-[var(--color-high)]">unplaced</span>
                  ) : (
                    <span className="text-[var(--color-muted)]">
                      {s.positionApproximate ? 'approximate' : 'verified'}
                    </span>
                  )}
                </dd>
              </dl>
            </div>
          </li>
        ))}
      </ol>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm">
        <h2 className="font-semibold">How this route was built</h2>
        <p className="mt-2 max-w-2xl text-[var(--color-muted)]">
          Every sighting had to look like the selected one (cosine ≥ {APPEARANCE_THRESHOLD}), be the
          same class of vehicle, and sit somewhere the vehicle could actually have reached from the
          sighting before it in time — under {MAX_PLAUSIBLE_SPEED_KMH} km/h between cameras.
        </p>

        {route.rejectedAsImpossible > 0 && (
          <p className="mt-3 max-w-2xl text-[var(--color-muted)]">
            <strong className="text-[var(--color-text)]">
              {route.rejectedAsImpossible} lookalike
              {route.rejectedAsImpossible === 1 ? ' was' : 's were'} rejected
            </strong>{' '}
            as physically impossible — similar enough to fool an appearance model, but in a place
            this vehicle could not have been at that time.
          </p>
        )}

        {route.unverifiableLegs > 0 && (
          <p className="mt-3 max-w-2xl text-[var(--color-high)]">
            {route.unverifiableLegs} leg{route.unverifiableLegs === 1 ? '' : 's'} could not be
            checked, because a camera on the route has no placed position. Placing it on the{' '}
            <Link href="/registry" className="underline underline-offset-4">
              registry map
            </Link>{' '}
            would let the system confirm or reject that leg instead of leaving it open.
          </p>
        )}
      </section>
    </main>
  );
}
