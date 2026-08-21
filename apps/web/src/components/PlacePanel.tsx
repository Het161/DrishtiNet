'use client';

import { useState, useTransition } from 'react';
import { Crosshair, Check, X, RotateCcw } from 'lucide-react';

import { placeCamera, clearCameraPosition } from '@/app/actions/camera-position';
import { VERIFIED_RADII } from '@/lib/placement';
import type { RegistryCamera } from '@/lib/registry';

/**
 * Drag-to-place: the only way a camera's position becomes `verified`.
 *
 * Everything else in the registry is inference — a label naming a junction, a district centroid, a
 * guess from a town name. This is where a person says "it is *there*", so the panel is deliberate
 * about what it asks for: a position, an uncertainty radius, and optionally why. All three land in
 * the audit trail alongside the operator's name and the previous value.
 */
export function PlacePanel({
  camera,
  point,
  onCancel,
  onDone,
}: {
  camera: RegistryCamera;
  point: { lat: number; lng: number } | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [radius, setRadius] = useState<number>(25);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const commit = () => {
    if (!point) return;
    setError(null);
    startTransition(async () => {
      const res = await placeCamera({
        cameraId: camera.id,
        lat: point.lat,
        lng: point.lng,
        uncertaintyM: radius,
        note,
      });
      if (res.ok) onDone();
      else setError(res.error ?? 'Could not save the position.');
    });
  };

  const clear = () => {
    setError(null);
    startTransition(async () => {
      const res = await clearCameraPosition(camera.id);
      if (res.ok) onDone();
      else setError(res.error ?? 'Could not clear the position.');
    });
  };

  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-elevated)] p-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <Crosshair size={14} className="text-[var(--color-saffron)]" />
        <span className="font-medium">Placing {camera.name}</span>
      </div>

      <p className="mb-2 leading-relaxed text-[var(--color-muted)]">
        Click the map, or drag the orange marker, to set the true position. This marks the camera{' '}
        <span className="text-[var(--color-text)]">verified</span> and records your name in the
        audit trail.
      </p>

      <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[var(--color-muted)]">
        <dt>Position</dt>
        <dd className="mono text-[var(--color-text)]">
          {point ? `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` : 'click the map…'}
        </dd>
      </dl>

      <label className="mb-2 flex items-center gap-2">
        <span className="text-[var(--color-muted)]">Accuracy</span>
        <select
          value={radius}
          onChange={(e) => setRadius(Number(e.target.value))}
          aria-label="Position uncertainty in metres"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1"
        >
          {VERIFIED_RADII.map((r) => (
            <option key={r} value={r}>
              {r === 0 ? 'exact (0 m)' : `±${r} m`}
            </option>
          ))}
        </select>
      </label>

      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="How do you know? (optional, stored in the audit trail)"
        aria-label="Placement note"
        className="mb-2 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-base)] px-2 py-1.5 placeholder:text-[var(--color-muted)]"
      />

      {error && (
        <p role="alert" className="mb-2 text-[var(--color-critical)]">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn3d" data-variant="primary" onClick={commit} disabled={!point || pending}>
          <Check size={14} /> {pending ? 'Saving…' : 'Confirm position'}
        </button>
        <button className="btn3d" onClick={onCancel} disabled={pending}>
          <X size={14} /> Cancel
        </button>
        {camera.locationStatus === 'verified' && (
          <button
            className="btn3d ml-auto"
            onClick={clear}
            disabled={pending}
            title="Return this camera to unverified at district scale"
          >
            <RotateCcw size={14} /> Clear
          </button>
        )}
      </div>
    </div>
  );
}
