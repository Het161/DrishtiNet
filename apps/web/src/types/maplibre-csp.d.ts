/**
 * Type shim for MapLibre's CSP build.
 *
 * We use `maplibre-gl-csp` rather than the default bundle because the default one constructs its
 * web worker from an inlined Blob, and that worker never starts under Next.js's webpack output —
 * the symptom is a map that initialises, sizes its canvas and adds controls, but whose sources
 * never finish loading (`isStyleLoaded()` stays false forever, including for inline GeoJSON).
 *
 * The CSP build loads the worker from an explicit URL instead, which we serve from /public. That
 * is also the more honest arrangement for an offline deployment: the worker is a file we ship,
 * not a blob conjured at runtime.
 */
declare module 'maplibre-gl/dist/maplibre-gl-csp' {
  import type * as maplibregl from 'maplibre-gl';

  const mod: typeof maplibregl & {
    /**
     * Where the CSP build fetches its worker from. Must be called before the first Map.
     * Note this is a FUNCTION in v5 — assigning a `workerUrl` property silently does nothing,
     * MapLibre then requests its default URL, gets our 404 HTML back, and the worker dies with
     * "Unexpected token '<'". The map then initialises and renders its background layer but no
     * source ever finishes loading.
     */
    setWorkerUrl(url: string): void;
  };
  export default mod;
}
