import { Clock, Radio } from 'lucide-react';

import { RegistryShell } from '@/components/RegistryShell';
import { getRegistry } from '@/lib/registry';
import { getTimeContext } from '@/lib/time-shift';
import { translator } from '@/lib/i18n';

// The registry reflects live camera health, so it must never be statically cached.
export const dynamic = 'force-dynamic';

export default async function RegistryPage() {
  const [data, time] = await Promise.all([getRegistry(), Promise.resolve(getTimeContext())]);
  const tr = translator('en');

  return (
    <main className="flex h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <span className="text-base font-semibold tracking-tight">
            {tr('app.name')}
          </span>
          <span className="text-xs text-[var(--color-muted)]">{tr('registry.title')}</span>
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
          {time.timeShifted && (
            <span className="rounded-md border border-[var(--color-saffron)] px-2 py-1 font-medium text-[var(--color-saffron)]">
              {tr('time.shifted')}
            </span>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <RegistryShell data={data} />
      </div>
    </main>
  );
}
