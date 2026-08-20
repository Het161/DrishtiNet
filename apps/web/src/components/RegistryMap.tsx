'use client';

/**
 * The persistent GIS map.
 *
 * Three deliberate choices:
 *
 *  1. **No WebGL background, no tile server.** The basemap is a 310 KB GeoJSON of Gujarat's
 *     district boundaries, generated offline by scripts/build_basemap.py and committed. MapLibre
 *     itself uses WebGL to draw, which is unavoidable and cheap; what we refuse is a decorative
 *     WebGL layer on an operational page and any network dependency at demo time.
 *
 *  2. **Uncertainty is drawn, not footnoted.** A camera whose position we have not verified gets a
 *     hollow marker inside a circle whose radius is its real `location_uncertainty_m`. Eleven of
 *     the thirty-one cameras are in that state, and a map that rendered them as confident dots
 *     would be lying at a glance.
 *
 *  3. **Health colours are distinct from alert colours.** Teal/amber/grey for camera state; the
 *     red/amber/blue/slate priority ramp is reserved for alerts. An operator must never have to
 *     ask whether a red dot means "broken camera" or "urgent alert".
 */
import { useEffect, useRef, useState } from 'react';
import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import maplibregl from 'maplibre-gl/dist/maplibre-gl-csp';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';

import type { RegistryCamera } from '@/lib/registry';
import { buildBasemapStyle } from '@/lib/map-style';

/**
 * The default MapLibre bundle builds its web worker from an inlined Blob, and that worker never
 * starts under Next.js's webpack output: the map initialises, sizes its canvas and adds controls,
 * but no source ever finishes loading — `isStyleLoaded()` stays false forever, even for an inline
 * empty FeatureCollection. The CSP build loads the worker from a real URL instead, which we serve
 * from our own origin (copied into public/ by scripts/copy-maplibre-worker.mjs).
 */
maplibregl.setWorkerUrl('/maplibre/maplibre-gl-csp-worker.js');

/**
 * Register the pmtiles:// protocol once per page, not per map instance — MapLibre keeps protocol
 * handlers in a module-level registry and re-adding one on every mount leaks handlers.
 */
let pmtilesRegistered = false;
function registerPmtiles(): void {
  if (pmtilesRegistered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  pmtilesRegistered = true;
}

/** Read from the CSS tokens so the map can never drift from the design system. */
function token(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export interface RegistryMapProps {
  cameras: RegistryCamera[];
  /** Whether the PMTiles road archives exist. Checked server-side; false degrades gracefully. */
  hasPmtiles?: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Initial viewport. Defaults to the Junagadh demo cluster, per CLAUDE.md. */
  initialCenter?: [number, number];
  initialZoom?: number;
}

const JUNAGADH: [number, number] = [70.4595, 21.5225];

export function RegistryMap({
  cameras,
  hasPmtiles = false,
  selectedId,
  onSelect,
  initialCenter = JUNAGADH,
  initialZoom = 10.5,
}: RegistryMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!container.current || map.current) return;

    const base = token('--color-base', '#0b0e14');
    const surface = token('--color-surface', '#121722');
    const border = token('--color-border', '#232c3d');
    const muted = token('--color-muted', '#8a93a6');

    registerPmtiles();

    const style = buildBasemapStyle({
      palette: {
        base,
        surface,
        elevated: token('--color-elevated', '#1b2230'),
        border,
        text: token('--color-text', '#e6eaf2'),
        muted,
      },
      // Set by the server component from whether the archives are actually on disk, so a missing
      // basemap degrades to district outlines rather than rendering an empty rectangle.
      pmtiles: hasPmtiles,
    });

    let instance: MapLibreMap;
    try {
      instance = new maplibregl.Map({
        container: container.current,
        style,
        center: initialCenter,
        zoom: initialZoom,
        attributionControl: false,
        // Cap DPR at 2 — beyond that we pay fill rate for pixels nobody can see, and this page
        // shares a GPU with decoding video tiles.
        pixelRatio: Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio : 1),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'map failed to initialise');
      return;
    }

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        // Roads/labels carry their own attribution from the PMTiles metadata; this covers the
        // district boundaries, which come from a separately-licensed source. Both must appear:
        // CC BY 4.0 and ODbL each require attribution, and this is a government submission.
        customAttribution:
          'Districts © <a href="https://github.com/datameet/maps">DataMeet</a> (CC BY 4.0)',
      }),
      'bottom-right',
    );
    instance.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    instance.on('load', () => setReady(true));

    // A map stuck on "loading" during a demo is worse than an explicit failure, and the worker
    // failure mode above produces exactly that with no error event. Fail loudly instead.
    const stall = setTimeout(() => {
      if (!instance.isStyleLoaded()) {
        setError('basemap did not finish loading — check /maplibre/maplibre-gl-csp-worker.js');
      }
    }, 10_000);
    instance.once('load', () => clearTimeout(stall));
    instance.on('error', (e) => {
      // A missing basemap must be loud: silently showing an empty rectangle during a demo is worse
      // than an explicit message.
      if (e?.error?.message) setError(e.error.message);
    });

    map.current = instance;

    // Test hook. Playwright must be able to ask MapLibre whether it has genuinely finished
    // loading; asserting on pixels cannot distinguish "map rendered" from "map still blank".
    (window as unknown as { __drishtiMap?: MapLibreMap }).__drishtiMap = instance;

    return () => {
      delete (window as unknown as { __drishtiMap?: MapLibreMap }).__drishtiMap;
      instance.remove();
      map.current = null;
    };
    // Viewport props are initial-only by design; changing them later should not re-create the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── camera layers ─────────────────────────────────────────────────────────
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;

    const colours = {
      online: token('--color-online', '#2dd4bf'),
      degraded: token('--color-degraded', '#f59e0b'),
      offline: token('--color-offline', '#64748b'),
      text: token('--color-text', '#e6eaf2'),
      base: token('--color-base', '#0b0e14'),
      muted: token('--color-muted', '#8a93a6'),
    };

    const features = cameras.map((c) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [c.lng, c.lat] },
      properties: {
        id: c.id,
        portalId: c.portalId,
        name: c.name,
        status: c.status,
        locationStatus: c.locationStatus,
        uncertaintyM: c.locationUncertaintyM,
        unverified: c.locationStatus === 'unverified' ? 1 : 0,
        selected: c.id === selectedId ? 1 : 0,
      },
    }));

    const data = { type: 'FeatureCollection' as const, features };
    const existing = m.getSource('cameras') as GeoJSONSource | undefined;

    if (existing) {
      existing.setData(data);
      return;
    }

    m.addSource('cameras', { type: 'geojson', data });

    // Uncertainty circle. Radius is in metres, converted to pixels per zoom level so it stays a
    // true ground distance rather than a decorative halo.
    m.addLayer({
      id: 'camera-uncertainty',
      type: 'circle',
      source: 'cameras',
      filter: ['>', ['get', 'uncertaintyM'], 100],
      paint: {
        'circle-color': colours.muted,
        'circle-opacity': 0.07,
        'circle-stroke-color': colours.muted,
        'circle-stroke-width': 1,
        'circle-stroke-opacity': 0.35,
        'circle-radius': [
          'interpolate',
          ['exponential', 2],
          ['zoom'],
          // metres → pixels: at zoom z, one metre is roughly 2^z / 40075016 * 512 px at the equator.
          6, ['/', ['get', 'uncertaintyM'], 600],
          10, ['/', ['get', 'uncertaintyM'], 40],
          14, ['/', ['get', 'uncertaintyM'], 2.5],
        ],
      },
    });

    m.addLayer({
      id: 'camera-halo',
      type: 'circle',
      source: 'cameras',
      filter: ['==', ['get', 'selected'], 1],
      paint: {
        'circle-radius': 16,
        'circle-color': token('--color-saffron', '#ff8a3d'),
        'circle-opacity': 0.22,
      },
    });

    m.addLayer({
      id: 'camera-point',
      type: 'circle',
      source: 'cameras',
      paint: {
        'circle-radius': ['case', ['==', ['get', 'selected'], 1], 9, 6.5],
        // Hollow (background-filled) when the position is unverified.
        'circle-color': [
          'case',
          ['==', ['get', 'unverified'], 1],
          colours.base,
          [
            'match',
            ['get', 'status'],
            'online', colours.online,
            'degraded', colours.degraded,
            'offline', colours.offline,
            colours.offline,
          ],
        ],
        'circle-stroke-width': 2,
        'circle-stroke-color': [
          'match',
          ['get', 'status'],
          'online', colours.online,
          'degraded', colours.degraded,
          'offline', colours.offline,
          colours.offline,
        ],
      },
    });

    m.on('click', 'camera-point', (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (typeof id === 'string') onSelect(id);
    });
    m.on('click', (e) => {
      const hits = m.queryRenderedFeatures(e.point, { layers: ['camera-point'] });
      if (hits.length === 0) onSelect(null);
    });
    m.on('mouseenter', 'camera-point', () => {
      m.getCanvas().style.cursor = 'pointer';
    });
    m.on('mouseleave', 'camera-point', () => {
      m.getCanvas().style.cursor = '';
    });
  }, [cameras, ready, selectedId, onSelect]);

  // Keep the selected camera's styling in sync without rebuilding layers.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const source = m.getSource('cameras') as GeoJSONSource | undefined;
    if (!source) return;
    source.setData({
      type: 'FeatureCollection',
      features: cameras.map((c) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
        properties: {
          id: c.id,
          portalId: c.portalId,
          name: c.name,
          status: c.status,
          locationStatus: c.locationStatus,
          uncertaintyM: c.locationUncertaintyM,
          unverified: c.locationStatus === 'unverified' ? 1 : 0,
          selected: c.id === selectedId ? 1 : 0,
        },
      })),
    });
  }, [selectedId, cameras, ready]);

  // Fly to a camera chosen from the table.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !selectedId) return;
    const cam = cameras.find((c) => c.id === selectedId);
    if (!cam) return;
    m.flyTo({
      center: [cam.lng, cam.lat],
      zoom: Math.max(m.getZoom(), 12),
      duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 700,
    });
  }, [selectedId, cameras, ready]);

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" aria-label="Camera location map" role="img" />
      {error && (
        <div className="absolute inset-x-4 top-4 rounded-lg border border-[var(--color-critical)] bg-[var(--color-surface)] p-3 text-xs">
          <strong className="text-[var(--color-critical)]">Map failed to load.</strong>{' '}
          <span className="text-[var(--color-muted)]">{error}</span>
        </div>
      )}
      {!ready && !error && (
        <div className="absolute inset-0 grid place-items-center text-xs text-[var(--color-muted)]">
          Loading offline basemap…
        </div>
      )}
    </div>
  );
}
