import 'server-only';

/**
 * Is the organisers' grid reachable right now?
 *
 * Checked server-side, before the wall renders, because of what the alternative looks like. Without
 * it every tile attempts a connection, fails, and shows the browser's own "Failed to fetch" — so a
 * screen full of red errors reads as *our* platform being broken, when the truth is that the
 * upstream moved behind authentication on 6 September and no client could reach it.
 *
 * A page that misattributes a failure is worse than one that reports it. The distinction between
 * "we are broken" and "the source is unavailable" is the whole of it.
 */

const CATALOGUE = `${process.env.SENTINEL_BASE ?? 'https://live.corp8.cloud'}/api/ingest`;

export type GridState =
  | { reachable: true; cameras: number }
  | { reachable: false; reason: string; detail: string };

/** Cached briefly: the wall must not probe the organisers on every render. */
let cached: { at: number; value: GridState } | null = null;
const CACHE_MS = 60_000;

export async function gridStatus(): Promise<GridState> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  let value: GridState;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const response = await fetch(CATALOGUE, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    clearTimeout(timer);

    const body = await response.text();
    const looksLikeJson = body.trimStart().startsWith('[') || body.trimStart().startsWith('{');

    if (response.ok && looksLikeJson) {
      let cameras = 0;
      try {
        const parsed = JSON.parse(body);
        cameras = Array.isArray(parsed) ? parsed.length : (parsed.cameras?.length ?? 0);
      } catch {
        /* count is a nicety, not the point */
      }
      value = { reachable: true, cameras };
    } else if (/\/auth\/login|<!doctype html/i.test(body) || response.url.includes('/auth/')) {
      // The specific failure as of 6 September: the catalogue redirects to a login page, so a
      // 200 arrives carrying HTML rather than the camera list.
      value = {
        reachable: false,
        reason: 'The organisers’ grid now requires authentication.',
        detail:
          `The catalogue redirects to a sign-in page, so no client can reach the cameras without ` +
          `credentials we have not been issued. Nothing here is broken — the source moved.`,
      };
    } else {
      value = {
        reachable: false,
        reason: `The organisers’ grid returned HTTP ${response.status}.`,
        detail: 'The camera catalogue did not answer with a camera list.',
      };
    }
  } catch (err) {
    value = {
      reachable: false,
      reason: 'The organisers’ grid is not responding.',
      detail: err instanceof Error ? err.message : 'the request timed out',
    };
  }

  cached = { at: Date.now(), value };
  return value;
}
