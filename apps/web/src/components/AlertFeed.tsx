'use client';

/**
 * The live alert feed.
 *
 * Seeded from Postgres on the server so a reload never starts empty, then kept current over SSE.
 * The two must not disagree, so an arriving alert replaces any row with the same id rather than
 * being prepended blindly — a duplicate in a control room reads as a second sighting.
 */
import { useEffect, useRef, useState } from 'react';

import type { RecentAlert } from '@/lib/forensics';

const PRIORITY_COLOUR: Record<string, string> = {
  critical: 'var(--color-critical)',
  high: 'var(--color-high)',
  medium: 'var(--color-medium)',
  low: 'var(--color-low)',
};

const ALERTS_URL = process.env.NEXT_PUBLIC_ALERTS_URL ?? 'http://localhost:4002';

type Connection = 'connecting' | 'live' | 'offline';

export function AlertFeed({ initial }: { initial: RecentAlert[] }) {
  const [alerts, setAlerts] = useState<RecentAlert[]>(initial);
  const [connection, setConnection] = useState<Connection>('connecting');
  const seen = useRef(new Set(initial.map((a) => a.id)));

  useEffect(() => {
    const source = new EventSource(`${ALERTS_URL}/stream`);

    source.onopen = () => setConnection('live');

    source.onmessage = (event) => {
      try {
        const alert = JSON.parse(event.data) as RecentAlert;
        if (!alert?.id || seen.current.has(alert.id)) return;
        seen.current.add(alert.id);
        setAlerts((current) => [alert, ...current].slice(0, 100));
      } catch {
        // A malformed frame is not worth tearing the feed down for.
      }
    };

    source.onerror = () => {
      // EventSource reconnects on its own. Say the feed is offline rather than leaving a stale
      // list looking live — an operator watching a frozen feed believes nothing is happening.
      setConnection('offline');
    };

    return () => source.close();
  }, []);

  return (
    <aside className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <h2 className="text-sm font-semibold">Live alerts</h2>
        <span className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{
              background:
                connection === 'live'
                  ? 'var(--color-teal)'
                  : connection === 'connecting'
                    ? 'var(--color-muted)'
                    : 'var(--color-critical)',
            }}
          />
          {connection === 'live' ? 'live' : connection === 'connecting' ? 'connecting…' : 'feed offline'}
        </span>
      </header>

      {alerts.length === 0 ? (
        <p className="px-4 py-6 text-sm text-[var(--color-muted)]">
          No alerts raised. The watchlist is being matched against every vehicle signature as it is
          written; nothing has matched yet.
        </p>
      ) : (
        <ul className="max-h-[720px] divide-y divide-[var(--color-border)] overflow-y-auto">
          {alerts.map((alert) => (
            <li key={alert.id} className="px-4 py-3">
              <div className="flex items-baseline gap-2">
                <span
                  className="rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide"
                  style={{
                    color: PRIORITY_COLOUR[alert.priority],
                    background: 'var(--color-elevated)',
                  }}
                >
                  {alert.priority}
                </span>
                <span className="text-sm font-medium">{alert.entityValue}</span>
                {alert.mock && (
                  // Required: anything touched by a mocked external system says so on screen.
                  <span className="rounded bg-[var(--color-elevated)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-[var(--color-high)]">
                    mock
                  </span>
                )}
              </div>

              <p className="mt-1 text-xs text-[var(--color-muted)]">{alert.reason}</p>

              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-muted)]">
                <dt>Camera</dt>
                <dd className="text-[var(--color-text)]">{alert.cameraName}</dd>
                <dt>Matched via</dt>
                <dd className="text-[var(--color-text)]">
                  {alert.matchedVia ?? '—'}
                  {alert.repaired && (
                    // A repaired plate reading is weaker evidence and must never look identical
                    // to a clean one.
                    <span className="ml-1 text-[var(--color-high)]">(repaired reading)</span>
                  )}
                </dd>
                <dt>Confidence</dt>
                <dd className="font-mono tabular-nums text-[var(--color-text)]">
                  {alert.confidence.toFixed(2)}
                </dd>
                {alert.pipelineLatencyMs !== null && (
                  <>
                    <dt>Detection → alert</dt>
                    <dd
                      className="font-mono tabular-nums"
                      style={{
                        color:
                          alert.pipelineLatencyMs <= 500
                            ? 'var(--color-teal)'
                            : 'var(--color-high)',
                      }}
                    >
                      {alert.pipelineLatencyMs} ms
                    </dd>
                  </>
                )}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
