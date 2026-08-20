/**
 * The offline dark SOC basemap style.
 *
 * ── Why three sources ────────────────────────────────────────────────────────────────────────
 *
 * Statewide context at low zoom, plus real street detail over the two demo areas, built by
 * `scripts/build_pmtiles.sh` from a Protomaps planet archive. Three separate PMTiles archives
 * rather than one merged file, because merging needs tooling we would otherwise not carry and
 * MapLibre handles multiple vector sources natively. Total ~12 MB, all committed, no network.
 *
 * ── The overzoom trap ────────────────────────────────────────────────────────────────────────
 *
 * A vector source does NOT stop drawing past its maxzoom — MapLibre overzooms the last available
 * tile indefinitely. So the statewide z0-10 archive would happily keep painting roads and place
 * labels at z14 *underneath* the detail archives inside the demo bboxes: doubled road casings and
 * duplicated labels, at exactly the zoom level the demo runs at.
 *
 * The fix is layer-level zoom ranges, not source-level ones:
 *   statewide layers  maxzoom = DETAIL_MIN_ZOOM   (stop where detail begins)
 *   detail layers     minzoom = DETAIL_MIN_ZOOM   (start where statewide stops)
 *
 * MapLibre treats a layer's `maxzoom` as exclusive and `minzoom` as inclusive, so the two meet
 * exactly at the boundary with neither a gap nor an overlap.
 *
 * ── Fallback ─────────────────────────────────────────────────────────────────────────────────
 *
 * If the PMTiles archives are missing, the style degrades to the committed district-boundary
 * GeoJSON — which is the state the app already shipped in, so a failure here cannot regress it.
 */
import type { StyleSpecification, LayerSpecification } from 'maplibre-gl';

/** Where statewide stops and per-area detail begins. */
export const DETAIL_MIN_ZOOM = 11;

export interface BasemapPalette {
  base: string;
  surface: string;
  elevated: string;
  border: string;
  text: string;
  muted: string;
}

export interface BasemapOptions {
  palette: BasemapPalette;
  /** Set false when the .pmtiles archives are unavailable; falls back to district outlines. */
  pmtiles: boolean;
  districtsUrl?: string;
}

const ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL) · ' +
  'tiles © <a href="https://protomaps.com">Protomaps</a> · offline basemap';

/** Road classes worth drawing on a control-room map, widest first. */
const MAJOR_ROADS = ['highway', 'major_road'];
const MINOR_ROADS = ['medium_road', 'minor_road'];

function districtLayers(p: BasemapPalette): LayerSpecification[] {
  return [
    {
      id: 'district-fill',
      type: 'fill',
      source: 'districts',
      paint: { 'fill-color': p.surface, 'fill-opacity': 0.55 },
    },
    {
      id: 'district-line',
      type: 'line',
      source: 'districts',
      paint: { 'line-color': p.border, 'line-width': 1 },
    },
  ];
}

/**
 * One set of basemap layers bound to a source, with an explicit zoom window.
 * Called once for the statewide archive and once per detail archive, so the layer ids stay
 * unique and the zoom windows never overlap.
 */
function basemapLayers(
  source: string,
  p: BasemapPalette,
  zoom: { minzoom?: number; maxzoom?: number },
): LayerSpecification[] {
  const z = <T extends object>(layer: T): T & typeof zoom => ({ ...layer, ...zoom });

  return [
    z({
      id: `${source}-earth`,
      type: 'fill',
      source,
      'source-layer': 'earth',
      paint: { 'fill-color': p.surface },
    }),
    z({
      id: `${source}-landuse`,
      type: 'fill',
      source,
      'source-layer': 'landuse',
      paint: { 'fill-color': p.elevated, 'fill-opacity': 0.35 },
    }),
    z({
      id: `${source}-water`,
      type: 'fill',
      source,
      'source-layer': 'water',
      // Water reads as "not road" at a glance; keep it clearly darker than land.
      paint: { 'fill-color': '#0d1a26' },
    }),
    z({
      id: `${source}-roads-minor`,
      type: 'line',
      source,
      'source-layer': 'roads',
      filter: ['match', ['get', 'kind'], MINOR_ROADS, true, false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': p.border,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 14, 1.4, 17, 4],
      },
    }),
    z({
      id: `${source}-roads-major`,
      type: 'line',
      source,
      'source-layer': 'roads',
      filter: ['match', ['get', 'kind'], MAJOR_ROADS, true, false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        // Muted, not bright: roads are context. Camera markers must stay the loudest thing here.
        'line-color': '#2b364a',
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 10, 1.6, 14, 3.4, 17, 8],
      },
    }),
    z({
      id: `${source}-boundaries`,
      type: 'line',
      source,
      'source-layer': 'boundaries',
      filter: ['<=', ['get', 'kind_detail'], 6],
      paint: {
        'line-color': p.border,
        'line-width': 1,
        'line-dasharray': [3, 2],
        'line-opacity': 0.8,
      },
    }),
  ];
}

/**
 * Place labels.
 *
 * Kept in one place rather than per-source: duplicated labels are the most visible symptom of the
 * overzoom trap, and MapLibre's collision detection does NOT deduplicate across sources — two
 * archives both offering "Junagadh" would render it twice, slightly offset.
 *
 * `glyphs` is deliberately absent from the style, so these are the only text layers and they use
 * the browser's own font stack. Nothing is fetched from a glyph server the venue cannot reach.
 */
function labelLayers(source: string, p: BasemapPalette, zoom: object): LayerSpecification[] {
  return [
    {
      ...zoom,
      id: `${source}-places`,
      type: 'symbol',
      source,
      'source-layer': 'places',
      filter: ['match', ['get', 'kind'], ['locality', 'region'], true, false],
      layout: {
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
        'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 12, 13],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.08,
        'text-max-width': 8,
      },
      paint: {
        'text-color': p.muted,
        'text-halo-color': p.base,
        'text-halo-width': 1.4,
      },
    } as LayerSpecification,
  ];
}

export function buildBasemapStyle(opts: BasemapOptions): StyleSpecification {
  const { palette: p, pmtiles } = opts;
  const districtsUrl = opts.districtsUrl ?? '/map/gujarat-districts.geojson';

  const style: StyleSpecification = {
    version: 8,
    // No glyphs and no sprite URL: nothing is fetched from a remote font or icon server.
    sources: {
      districts: { type: 'geojson', data: districtsUrl },
    },
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': p.base } }],
  };

  if (!pmtiles) {
    // Degraded mode — exactly what the app shipped with before PMTiles existed.
    style.layers.push(...districtLayers(p));
    return style;
  }

  style.sources.statewide = {
    type: 'vector',
    url: 'pmtiles:///map/gujarat-z10.pmtiles',
    attribution: ATTRIBUTION,
  };
  style.sources.junagadh = { type: 'vector', url: 'pmtiles:///map/junagadh-detail.pmtiles' };
  style.sources.corridor = { type: 'vector', url: 'pmtiles:///map/corridor-detail.pmtiles' };

  // Statewide STOPS at DETAIL_MIN_ZOOM; detail STARTS there. Without this split the statewide
  // archive overzooms underneath the detail archives and every road is drawn twice.
  style.layers.push(
    ...basemapLayers('statewide', p, { maxzoom: DETAIL_MIN_ZOOM }),
    ...basemapLayers('junagadh', p, { minzoom: DETAIL_MIN_ZOOM }),
    ...basemapLayers('corridor', p, { minzoom: DETAIL_MIN_ZOOM }),
    // District outlines stay on top throughout: they are the administrative frame an SCRB
    // evaluator reads the map by, and they come from a source we control rather than from OSM's
    // admin relations, whose Indian district coverage is uneven. No fill here — the PMTiles earth
    // and landuse layers already provide the ground.
    {
      id: 'district-outline',
      type: 'line',
      source: 'districts',
      paint: { 'line-color': p.border, 'line-width': 1, 'line-opacity': 0.9 },
    },
    // Labels last, from the statewide archive only, so nothing is drawn twice.
    ...labelLayers('statewide', p, {}),
  );

  return style;
}
