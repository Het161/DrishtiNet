import Link from 'next/link';

/**
 * What a page shows when it cannot reach the database.
 *
 * This exists because of where the page is likely to be seen. The hosted preview has no database —
 * the platform is designed to run offline on one machine, and Postgres, Redis, MediaMTX and the
 * analytics process cannot exist on serverless hosting. Without this, a screening committee opening
 * the link gets HTTP 500, which reads as a broken submission rather than a deployment that was
 * never meant to carry the whole system.
 *
 * So the page says what it is, what is missing and why, and where the working thing lives. An
 * honest empty state is worth more than a stack trace, and far more than a page pretending to have
 * data it does not have.
 */
export function NoDatabaseNotice({ page }: { page: string }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-widest text-[var(--color-saffron,#FF8A3D)]">
        Hosted preview
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        {page} needs the database, and this deployment has none.
      </h1>

      <p className="mt-4 text-[var(--color-muted)]">
        DrishtiNet runs offline on a single machine: PostgreSQL with PostGIS, Redis, MediaMTX, a
        Python analytics process and a service holding live alert connections open. None of that can
        run on serverless hosting, and the on-site evaluation has no internet — so the product was
        built to need neither.
      </p>

      <p className="mt-4 text-[var(--color-muted)]">
        This preview exists so the platform can be looked at without setting it up. The pages that
        need no data work; the ones that read the index say so, rather than returning an error and
        leaving you to guess.
      </p>

      <div className="mt-8 rounded-xl border border-[var(--color-border,#273042)] bg-[var(--color-surface,#121722)] p-5">
        <h2 className="text-sm font-semibold">To see it with data</h2>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--color-elevated,#1B2230)] p-3 text-xs leading-relaxed">
{`git clone https://github.com/Het161/DrishtiNet
make setup && make infra && make migrate
make analytics-deps
npm run dev            # web on :3001`}
        </pre>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          Screenshots of every screen with real data are in the{' '}
          <a
            href="https://github.com/Het161/DrishtiNet#the-operations-screen"
            className="text-[var(--color-teal,#2DD4BF)] underline underline-offset-4"
          >
            repository README
          </a>
          , alongside the measured latencies and the evidence behind them.
        </p>
      </div>

      <nav className="mt-8 flex gap-4 text-sm">
        <Link href="/" className="text-[var(--color-teal,#2DD4BF)] underline underline-offset-4">
          Home
        </Link>
        <a
          href="https://github.com/Het161/DrishtiNet"
          className="text-[var(--color-teal,#2DD4BF)] underline underline-offset-4"
        >
          Source
        </a>
      </nav>
    </main>
  );
}
