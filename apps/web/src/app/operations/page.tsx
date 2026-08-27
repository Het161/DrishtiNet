/**
 * The operator surface: what the pipeline found, and what it wants attention on.
 *
 * Two halves, because an operator does two different jobs. Alerts are pushed — the system decides
 * something matters and says so. Search is pulled — an investigation already has a question and
 * needs the index to answer it. Putting them on one screen keeps the alert that arrives while
 * someone is searching from being missed.
 */
import Link from 'next/link';

import { indexSummary, recentAlerts, availableFilters, searchSignatures } from '@/lib/forensics';
import { AlertFeed } from '@/components/AlertFeed';
import { SignatureSearch } from '@/components/SignatureSearch';
import { NoDatabaseNotice } from '@/components/NoDatabaseNotice';

export const dynamic = 'force-dynamic';

function Stat({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <div className="font-mono text-2xl leading-none tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-[var(--color-muted)]">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] text-[var(--color-muted)] opacity-70">{hint}</div>}
    </div>
  );
}

export default async function OperationsPage() {
  // A hosted preview has no database. Degrade to an explanation rather than a 500.
  let summary, alerts, filters, initial;
  try {
    [summary, alerts, filters, initial] = await Promise.all([
    indexSummary(),
    recentAlerts(50),
    availableFilters(),
      searchSignatures({ limit: 60 }),
    ]);
  } catch {
    return <NoDatabaseNotice page="Operations" />;
  }

  const empty = summary.tracks === 0;

  return (
    <main className="mx-auto max-w-[1600px] px-6 py-6">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Operations</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Live alerts and forensic search, both served from the index — never from video.
          </p>
        </div>
        <Link
          href="/wall"
          className="mr-4 text-sm text-[var(--color-teal)] underline underline-offset-4"
        >
          Video wall
        </Link>
        <Link
          href="/registry"
          className="text-sm text-[var(--color-teal)] underline underline-offset-4"
        >
          Camera registry
        </Link>
      </header>

      {empty ? (
        <div className="rounded-xl border border-[var(--color-high)] bg-[var(--color-surface)] p-5">
          <p className="font-medium text-[var(--color-high)]">The index is empty.</p>
          <p className="mt-2 max-w-2xl text-sm text-[var(--color-muted)]">
            Nothing has been indexed yet, which is not the same as nothing having happened — the
            page is showing that it has no data rather than showing zeroes as if they were findings.
            Run the pipeline over a camera or a development fixture to populate it:
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--color-elevated)] p-3 text-xs">
{`make index-fixture ARGS='--fixture data/fixtures/cam_10_daylight.mp4 \\
  --label "10 char-chowk-road-2-junagadh" --seconds 60'`}
          </pre>
        </div>
      ) : (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat value={summary.detections.toLocaleString()} label="Detections" />
          <Stat value={summary.tracks.toLocaleString()} label="Tracks" />
          <Stat
            value={summary.signatures.toLocaleString()}
            label="Vehicle signatures"
            hint="class + colour + embedding"
          />
          <Stat value={String(summary.cameras)} label="Cameras indexed" />
          <Stat
            value={`${summary.queryMs} ms`}
            label="Index query"
            hint={summary.queryMs < 200 ? 'within the 200 ms budget' : 'over the 200 ms budget'}
          />
          <Stat value={String(alerts.length)} label="Alerts raised" />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <SignatureSearch initial={initial} filters={filters} />
        <AlertFeed initial={alerts} />
      </div>
    </main>
  );
}
