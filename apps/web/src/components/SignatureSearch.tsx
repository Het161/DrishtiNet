'use client';

/**
 * Forensic search over the vehicle index.
 *
 * The filters are the ones an operator actually has from a witness — vehicle type, colour, which
 * camera. Plate is offered but is rarely populated on this grid, and the interface says so rather
 * than leaving an empty column looking like a failure.
 *
 * Every result carries the pipeline's own uncertainty with it. A colour the pipeline flagged as
 * unreliable is shown as unreliable here; it is never rounded up into a confident answer on the way
 * to the screen, because an operator acting on "white truck" deserves to know the light was too
 * poor to be sure.
 */
import Link from 'next/link';
import { useState, useTransition } from 'react';

import type { SearchResult, SignatureHit } from '@/lib/forensics';
import { runSearch } from '@/app/operations/actions';

interface Props {
  initial: SearchResult;
  filters: {
    classes: string[];
    colours: string[];
    cameras: { id: string; label: string; name: string }[];
  };
}

const SWATCH: Record<string, string> = {
  white: '#e6eaf2', grey: '#8a93a6', black: '#2a3140', red: '#ef4444',
  blue: '#3b82f6', green: '#22c55e', yellow: '#eab308', orange: '#f97316',
  purple: '#a855f7',
};

function timeOf(value: Date | string): string {
  return new Date(value).toLocaleTimeString('en-GB', { hour12: false });
}

export function SignatureSearch({ initial, filters }: Props) {
  const [result, setResult] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({ cls: '', colour: '', cameraId: '', plate: '' });

  function update(patch: Partial<typeof form>) {
    const next = { ...form, ...patch };
    setForm(next);
    startTransition(async () => setResult(await runSearch(next)));
  }

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <h2 className="mr-auto text-sm font-semibold">Forensic search</h2>
        <span className="font-mono text-xs tabular-nums text-[var(--color-muted)]">
          {result.total.toLocaleString()} signatures ·{' '}
          <span style={{ color: result.queryMs < 200 ? 'var(--color-teal)' : 'var(--color-high)' }}>
            {result.queryMs} ms
          </span>
        </span>
      </header>

      <div className="flex flex-wrap gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <select
          aria-label="Vehicle type"
          value={form.cls}
          onChange={(e) => update({ cls: e.target.value })}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 py-1.5 text-sm"
        >
          <option value="">Any type</option>
          {filters.classes.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <select
          aria-label="Colour"
          value={form.colour}
          onChange={(e) => update({ colour: e.target.value })}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 py-1.5 text-sm"
        >
          <option value="">Any colour</option>
          {filters.colours.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <select
          aria-label="Camera"
          value={form.cameraId}
          onChange={(e) => update({ cameraId: e.target.value })}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 py-1.5 text-sm"
        >
          <option value="">Any camera</option>
          {filters.cameras.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <input
          aria-label="Partial plate"
          value={form.plate}
          onChange={(e) => update({ plate: e.target.value })}
          placeholder="Partial plate"
          className="w-40 rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 py-1.5 text-sm"
        />

        {pending && <span className="self-center text-xs text-[var(--color-muted)]">searching…</span>}
      </div>

      {result.hits.length === 0 ? (
        <p className="px-4 py-8 text-sm text-[var(--color-muted)]">
          Nothing matches those filters.
        </p>
      ) : (
        <div className="max-h-[720px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--color-elevated)] text-left text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
              <tr>
                <th className="px-4 py-2 font-semibold">Vehicle</th>
                <th className="px-4 py-2 font-semibold">Colour</th>
                <th className="px-4 py-2 font-semibold">Camera</th>
                <th className="px-4 py-2 font-semibold">Seen</th>
                <th className="px-4 py-2 font-semibold">Plate</th>
                <th className="px-4 py-2 font-semibold">Re-ID</th>
              </tr>
            </thead>
            <tbody>
              {result.hits.map((hit: SignatureHit) => (
                <tr key={hit.trackId} className="border-t border-[var(--color-border)]">
                  <td className="px-4 py-2">
                    <Link
                      href={`/operations/route/${hit.trackId}`}
                      className="capitalize text-[var(--color-teal)] underline-offset-4 hover:underline"
                      title="Reconstruct this vehicle's route across cameras"
                    >
                      {hit.cls}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-1.5">
                      {hit.colour && (
                        <span
                          aria-hidden
                          className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-[var(--color-border)]"
                          style={{ background: SWATCH[hit.colour] ?? 'var(--color-muted)' }}
                        />
                      )}
                      <span className="capitalize">{hit.colour ?? 'unknown'}</span>
                      {hit.colourUncertain && (
                        <span
                          className="text-[10px] uppercase text-[var(--color-high)]"
                          title="Light was too poor for the colour to be reliable"
                        >
                          uncertain
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-[var(--color-muted)]">{hit.cameraName}</td>
                  <td className="px-4 py-2 font-mono text-xs tabular-nums text-[var(--color-muted)]">
                    {timeOf(hit.firstSeen)}
                    <span className="opacity-50"> · {hit.frameCount}f</span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {hit.partialPlate ?? (
                      <span
                        className="text-[var(--color-muted)]"
                        title="Plates on this grid measure ~41 px wide — detectable, not readable"
                      >
                        not legible
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-[var(--color-muted)]">
                    {hit.hasEmbedding ? (
                      <span className="text-[var(--color-teal)]">enrolled</span>
                    ) : (
                      'none'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
