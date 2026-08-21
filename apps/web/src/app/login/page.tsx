'use client';

import { useActionState } from 'react';
import { LogIn } from 'lucide-react';

import { loginAction } from '@/app/actions/auth';

/**
 * Sign in.
 *
 * This is one of the three pages allowed a WebGL background per CLAUDE.md — but it does not have
 * one yet, and it will not get one until the operational pages are finished. Nothing decorative
 * ships before the thing it decorates works.
 */
export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, {});

  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="w-full max-w-sm">
        <p className="mb-1 text-xs uppercase tracking-[0.2em] text-[var(--color-saffron)]">
          DrishtiNet
        </p>
        <h1 className="mb-6 text-[length:var(--text-xl)] font-semibold tracking-tight">Sign in</h1>

        <form action={formAction} className="panel flex flex-col gap-3 p-4">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[var(--color-muted)]">Username</span>
            <input
              name="username"
              autoComplete="username"
              autoFocus
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-base)] px-3 py-2 text-sm outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[var(--color-muted)]">Password</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-base)] px-3 py-2 text-sm outline-none"
            />
          </label>

          {state?.error && (
            <p role="alert" className="text-xs text-[var(--color-critical)]">
              {state.error}
            </p>
          )}

          <button type="submit" className="btn3d mt-1 justify-center" data-variant="primary" disabled={pending}>
            <LogIn size={15} />
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-muted)]">
          Local development credentials are seeded by <code className="mono">make seed</code> and
          documented in the README. They are not secrets and must be rotated before any non-local
          use.
        </p>
      </div>
    </main>
  );
}
