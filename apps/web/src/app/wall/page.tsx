/**
 * The live video wall.
 *
 * The most conspicuous thing a CCTV platform can be missing, and until now this one was missing it.
 * What made it possible is that the gateway can finally reach the grid: RTSP :8554 is filtered from
 * our network, but the documented HLS endpoint serves, and the gateway walks that chain rather than
 * assuming either protocol.
 *
 * Tiles do not open by themselves. Twelve cameras opening because a page loaded is twelve copies of
 * someone else's stream, which is the cost the five-camera ceiling exists to bound.
 */
import Link from 'next/link';

import { getRegistry } from '@/lib/registry';
import { VideoWall } from '@/components/VideoWall';

export const dynamic = 'force-dynamic';

const MAX_OPEN = Number(process.env.LIVE_PULL_MAX ?? 5);

export default async function WallPage() {
  const registry = await getRegistry();

  return (
    <main className="mx-auto max-w-[1600px] px-6 py-6">
      <header className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Video wall</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Live tiles from the organisers&rsquo; grid, served through our own gateway.
          </p>
        </div>
        <nav className="flex gap-4 text-sm">
          <Link href="/registry" className="text-[var(--color-teal)] underline-offset-4 hover:underline">
            Registry
          </Link>
          <Link href="/operations" className="text-[var(--color-teal)] underline-offset-4 hover:underline">
            Operations
          </Link>
        </nav>
      </header>

      <VideoWall cameras={registry.cameras} maxOpen={MAX_OPEN} />

      <section className="mt-8 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm">
        <h2 className="font-semibold">How this wall consumes the grid</h2>
        <p className="mt-2 max-w-3xl text-[var(--color-muted)]">
          Every viewer here reads from our MediaMTX, not from the organisers. One upstream pull feeds
          any number of tiles, so fifty operators watching one junction is still one connection to
          their infrastructure. A pull starts only when a tile asks for it and closes 60 seconds
          after the last viewer leaves.
        </p>
        <p className="mt-3 max-w-3xl text-[var(--color-muted)]">
          The gateway walks the documented source chain — RTSP over TCP first, then HLS. On this
          network RTSP <code>:8554</code> and WHEP <code>:8889</code> hang rather than refuse, which
          is what a filtered port looks like, so HLS on 443 is the path in use. That is the endpoint
          the integration reference nominates for restricted networks.
        </p>
      </section>
    </main>
  );
}
