'use client';

/**
 * The registry: persistent map on the left, camera table and gap panel on the right.
 *
 * The asymmetric split-pane is the point — the map is never a modal or a tab, because a control
 * room reasons geographically. Selection is shared: clicking a marker highlights the row and
 * clicking a row flies the map.
 */
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  Camera as CameraIcon,
  CircleHelp,
  MapPin,
  Search,
  ShieldQuestion,
} from 'lucide-react';

import { RegistryMap } from './RegistryMap';
import type { RegistryCamera, RegistryData } from '@/lib/registry';
import { translator, type Locale } from '@/lib/i18n';

const STATUS_COLOUR: Record<RegistryCamera['status'], string> = {
  online: 'var(--color-online)',
  degraded: 'var(--color-degraded)',
  offline: 'var(--color-offline)',
};

const LOCATION_LABEL: Record<RegistryCamera['locationStatus'], string> = {
  verified: 'Verified',
  approximate: 'Approximate',
  unverified: 'Unverified',
};

function Stat({
  icon,
  label,
  value,
  tone = 'normal',
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  tone?: 'normal' | 'warn';
}) {
  return (
    <div className="panel flex items-center gap-3 px-4 py-3">
      <span
        className="shrink-0"
        style={{ color: tone === 'warn' ? 'var(--color-degraded)' : 'var(--color-teal)' }}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="mono text-lg leading-none">{value}</div>
        <div className="truncate text-xs text-[var(--color-muted)]">{label}</div>
      </div>
    </div>
  );
}

export function RegistryShell({
  data,
  hasPmtiles = false,
  locale = 'en',
}: {
  data: RegistryData;
  hasPmtiles?: boolean;
  locale?: Locale;
}) {
  const tr = translator(locale);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | RegistryCamera['status']>('all');
  const [onlyUnknown, setOnlyUnknown] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.cameras.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (onlyUnknown && c.locationStatus === 'verified' && c.departmentLabel) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.portalId.includes(q) ||
        (c.district ?? '').toLowerCase().includes(q) ||
        (c.cluster ?? '').toLowerCase().includes(q)
      );
    });
  }, [data.cameras, query, statusFilter, onlyUnknown]);

  const selected = data.cameras.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="grid h-full grid-rows-[auto_1fr] gap-4 p-4">
      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat icon={<CameraIcon size={18} />} label={tr('registry.cameras')} value={data.summary.total} />
        <Stat icon={<MapPin size={18} />} label={tr('registry.districts')} value={data.summary.districtsCovered} />
        <Stat
          icon={<span className="inline-block h-3 w-3 rounded-full" style={{ background: 'var(--color-online)' }} />}
          label={tr('registry.online')}
          value={data.summary.online}
        />
        <Stat
          icon={<AlertTriangle size={18} />}
          label={`${tr('registry.degraded')} / ${tr('registry.offline')}`}
          value={`${data.summary.degraded} / ${data.summary.offline}`}
          tone="warn"
        />
        <Stat
          icon={<CircleHelp size={18} />}
          label={tr('gap.locationUnverified')}
          value={data.summary.locationUnverified}
          tone="warn"
        />
        <Stat
          icon={<Building2 size={18} />}
          label={tr('gap.deptUnassigned')}
          value={data.summary.departmentUnassigned}
          tone="warn"
        />
      </div>

      {/* Asymmetric split: map dominates, detail rail beside it */}
      <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(380px,1fr)]">
        <section className="panel relative min-h-[420px] overflow-hidden">
          <RegistryMap
            cameras={filtered}
            hasPmtiles={hasPmtiles}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />

          {/* Legend — states what a hollow marker means, because that is the whole honesty story */}
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-base)_88%,transparent)] px-3 py-2 text-[11px] leading-relaxed">
            <div className="mb-1 font-medium text-[var(--color-muted)]">{tr('map.legend')}</div>
            <div className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'var(--color-online)' }} />
              {tr('registry.online')}
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'var(--color-degraded)' }} />
              {tr('registry.degraded')}
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'var(--color-offline)' }} />
              {tr('registry.offline')}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full border-2"
                style={{ background: 'var(--color-base)', borderColor: 'var(--color-muted)' }}
              />
              {tr('map.noPosition')}
            </div>
          </div>
        </section>

        <section className="panel flex min-h-0 flex-col">
          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] p-3">
            <label className="relative flex-1">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted)]"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`${tr('common.search')}…`}
                aria-label={tr('common.search')}
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-base)] py-1.5 pl-8 pr-2 text-xs outline-none placeholder:text-[var(--color-muted)]"
              />
            </label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              aria-label="Filter by status"
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1.5 text-xs"
            >
              <option value="all">{tr('common.all')}</option>
              <option value="online">{tr('registry.online')}</option>
              <option value="degraded">{tr('registry.degraded')}</option>
              <option value="offline">{tr('registry.offline')}</option>
            </select>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--color-muted)]">
              <input
                type="checkbox"
                checked={onlyUnknown}
                onChange={(e) => setOnlyUnknown(e.target.checked)}
                className="accent-[var(--color-saffron)]"
              />
              Gaps only
            </label>
          </div>

          {/* Selected camera detail */}
          {selected && (
            <div className="border-b border-[var(--color-border)] bg-[var(--color-elevated)] p-3 text-xs">
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="font-medium">{selected.name}</div>
                <button
                  onClick={() => setSelectedId(null)}
                  className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  aria-label={tr('common.close')}
                >
                  ✕
                </button>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[var(--color-muted)]">
                <dt>Portal id</dt>
                <dd className="mono text-[var(--color-text)]">{selected.portalId}</dd>
                <dt>District</dt>
                <dd className="text-[var(--color-text)]">{selected.district ?? '—'}</dd>
                <dt>{tr('dept.title')}</dt>
                <dd className="text-[var(--color-text)]">
                  {selected.departmentLabel ?? (
                    <span className="text-[var(--color-degraded)]">{tr('dept.unassigned')}</span>
                  )}
                </dd>
                <dt>Position</dt>
                <dd className="text-[var(--color-text)]">
                  {LOCATION_LABEL[selected.locationStatus]}
                  <span className="text-[var(--color-muted)]">
                    {' '}
                    ±{selected.locationUncertaintyM >= 1000
                      ? `${(selected.locationUncertaintyM / 1000).toFixed(0)} km`
                      : `${selected.locationUncertaintyM} m`}
                  </span>
                  {selected.positionIsFallback && (
                    <div className="text-[var(--color-degraded)]">{tr('map.noPosition')}</div>
                  )}
                </dd>
                <dt>Availability</dt>
                <dd style={{ color: STATUS_COLOUR[selected.status] }}>
                  {selected.status}
                  <span className="text-[var(--color-muted)]">
                    {' '}
                    ({selected.statusSource === 'measured' ? tr('status.measured') : tr('status.portalClaim')})
                  </span>
                </dd>
                {selected.lastError && (
                  <>
                    <dt>Reason</dt>
                    <dd className="text-[var(--color-degraded)]">{selected.lastError}</dd>
                  </>
                )}
                {selected.width && (
                  <>
                    <dt>Media</dt>
                    <dd className="mono text-[var(--color-text)]">
                      {selected.width}×{selected.height}
                      {selected.fps ? ` @ ${selected.fps.toFixed(1)} fps` : ''}
                    </dd>
                  </>
                )}
              </dl>
            </div>
          )}

          {/* Camera list */}
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-[var(--color-surface)] text-[var(--color-muted)]">
                <tr className="border-b border-[var(--color-border)]">
                  <th className="px-3 py-2 text-left font-medium">#</th>
                  <th className="px-3 py-2 text-left font-medium">{tr('registry.cameras')}</th>
                  <th className="px-3 py-2 text-left font-medium">District</th>
                  <th className="px-2 py-2 text-left font-medium">Pos</th>
                  <th className="px-2 py-2 text-left font-medium">Dept</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}
                    className={`cursor-pointer border-b border-[var(--color-border)] transition-colors ${
                      c.id === selectedId ? 'bg-[var(--color-elevated)]' : 'hover:bg-[var(--color-elevated)]'
                    }`}
                  >
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{
                            background:
                              c.locationStatus === 'unverified' ? 'transparent' : STATUS_COLOUR[c.status],
                            border: `2px solid ${STATUS_COLOUR[c.status]}`,
                          }}
                          title={`${c.status} (${c.statusSource})`}
                        />
                        <span className="mono text-[var(--color-muted)]">{c.portalId}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2">{c.name}</td>
                    <td className="px-3 py-2 text-[var(--color-muted)]">{c.district ?? '—'}</td>
                    <td className="px-2 py-2">
                      {c.locationStatus === 'verified' ? (
                        <span className="text-[var(--color-online)]" title={tr('location.verified')}>✓</span>
                      ) : c.locationStatus === 'approximate' ? (
                        <span className="text-[var(--color-muted)]" title={tr('location.approximate')}>≈</span>
                      ) : (
                        <ShieldQuestion size={13} className="text-[var(--color-degraded)]" />
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {c.departmentLabel ?? (
                        <span className="text-[var(--color-degraded)]" title={tr('dept.unassigned')}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-[var(--color-muted)]">
                      No cameras match this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="border-t border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-muted)]">
            {tr('common.showing')} <span className="mono">{filtered.length}</span> {tr('common.of')}{' '}
            <span className="mono">{data.cameras.length}</span>
          </div>
        </section>
      </div>
    </div>
  );
}
