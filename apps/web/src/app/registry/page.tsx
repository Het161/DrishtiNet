import Link from 'next/link';
import { Clock, Radio } from 'lucide-react';

import { RegistryShell } from '@/components/RegistryShell';
import { getRegistry } from '@/lib/registry';
import { hasPmtilesArchives } from '@/lib/basemap';
import { getSession, can } from '@/lib/auth';
import { logoutAction } from '@/app/actions/auth';
import { getTimeContext } from '@/lib/time-shift';
import { translator } from '@/lib/i18n';

// The registry reflects live camera health, so it must never be statically cached.
export const dynamic = 'force-dynamic';

export default async function RegistryPage() {
  const [data, pmtiles, session] = await Promise.all([
    getRegistry(),
    hasPmtilesArchives(),
    getSession(),
  ]);
  const time = getTimeContext();
  const tr = translator('en');

  return (
    <main className="flex h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <span className="text-base font-semibold tracking-tight">
            {tr('app.name')}
          </span>
          <span className="text-xs text-[var(--color-muted)]">{tr('registry.title')}</span>
          {/* Without a link here the analytics half of the system is unreachable — someone signing
              in lands on the registry and has no way to discover that anything else exists. */}
          <nav className="flex items-center gap-3 text-xs">
            <span className="text-[var(--color-border)]">|</span>
            <Link
              href="/operations"
              className="text-[var(--color-teal)] underline-offset-4 hover:underline"
            >
              Operations
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-4 text-xs">
          {/* What the footage is actually showing. The wall clock alone would misrepresent it. */}
          <span className="flex items-center gap-1.5 text-[var(--color-muted)]">
            <Radio size={13} className="text-[var(--color-teal)]" />
            {tr('time.recorded')} <span className="mono text-[var(--color-text)]">{time.recordedLabel}</span>
          </span>
          <span className="flex items-center gap-1.5 text-[var(--color-muted)]" title={time.slotLabel}>
            <Clock size={13} />
            <span className="mono">{time.hoursUntilRollover.toFixed(1)}h</span> to rollover
          </span>
          {session ? (
            <form action={logoutAction}>
              <button className="text-[var(--color-muted)] hover:text-[var(--color-text)]">
                {session.displayName} · sign out
              </button>
            </form>
          ) : (
            <a href="/login" className="text-[var(--color-saffron)]">Sign in to place cameras</a>
          )}
          {time.timeShifted && (
            <span className="rounded-md border border-[var(--color-saffron)] px-2 py-1 font-medium text-[var(--color-saffron)]">
              {tr('time.shifted')}
            </span>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <RegistryShell data={data} hasPmtiles={pmtiles} canPlace={can(session, 'camera:write')} />
      </div>
    </main>
  );
}
