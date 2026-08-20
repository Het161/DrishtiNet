/**
 * IST everywhere.
 *
 * A control room has exactly one clock. Mixed timezones in a route reconstruction produce a
 * plausible-looking but wrong sequence of camera hits, which is the single most damaging failure a
 * system like this can have in an evidentiary context. So: never render a bare `toLocaleString()`,
 * always go through here.
 */

export const IST_TIMEZONE = 'Asia/Kolkata';
export const IST_OFFSET_MINUTES = 330;

const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST_TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

const timeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST_TIMEZONE,
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

export function formatIST(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  return `${dateTimeFmt.format(d)} IST`;
}

export function formatISTTime(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  return timeFmt.format(d);
}

/** Millisecond-precision stamp for evidence records and latency logs. */
export function formatISTPrecise(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${dateTimeFmt.format(d)}.${ms} IST`;
}

/** "2 m 14 s ago" — relative age, for the alert queue. */
export function formatAge(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ${h % 24}h ago`;
}

/**
 * Detect venue clock skew. If the browser's clock and the alerts service disagree by more than a
 * few seconds, every latency number and every route timeline is suspect — so we surface it loudly
 * rather than quietly showing wrong data during the demo.
 */
export const CLOCK_SKEW_WARN_MS = 3000;

export function clockSkewMs(serverTs: number, clientTs = Date.now()): number {
  return clientTs - serverTs;
}
