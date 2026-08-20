import Link from 'next/link';
import { ArrowRight, MapPin, ShieldCheck } from 'lucide-react';

export default function LandingPage() {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="w-full max-w-2xl">
        <p className="mb-2 text-xs uppercase tracking-[0.2em] text-[var(--color-saffron)]">
          Gujarat Police Innovation Challenge 2026
        </p>
        <h1 className="mb-3 text-[length:var(--text-2xl)] font-semibold tracking-tight">
          DrishtiNet
        </h1>
        <p className="mb-8 max-w-xl text-[var(--color-muted)]">
          Centralised CCTV registry and GIS foundation, with cross-camera vehicle analytics.
          Runs entirely offline.
        </p>

        <div className="mb-8 grid gap-3 sm:grid-cols-2">
          <div className="panel p-4">
            <MapPin size={18} className="mb-2 text-[var(--color-teal)]" />
            <div className="mb-1 text-sm font-medium">Registry &amp; GIS</div>
            <p className="text-xs text-[var(--color-muted)]">
              31 cameras from the live portal, with position confidence and availability
              provenance shown rather than assumed.
            </p>
          </div>
          <div className="panel p-4">
            <ShieldCheck size={18} className="mb-2 text-[var(--color-teal)]" />
            <div className="mb-1 text-sm font-medium">Evidence integrity</div>
            <p className="text-xs text-[var(--color-muted)]">
              Append-only audit trail enforced in the database; SHA-256 chain of custody on every
              exported clip.
            </p>
          </div>
        </div>

        <Link href="/registry" className="btn3d" data-variant="primary">
          Open registry <ArrowRight size={16} />
        </Link>
      </div>
    </main>
  );
}
