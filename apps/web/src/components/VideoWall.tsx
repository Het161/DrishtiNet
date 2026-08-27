'use client';

/**
 * The live video wall.
 *
 * ── Why a tile is more than a <video> element ────────────────────────────────────────────────────
 *
 * Every camera opened here costs the organisers a separate copy of their stream, so the wall is
 * built to be a polite consumer rather than a grid that grabs everything it can see:
 *
 *   • A tile subscribes through the gateway before it plays, and releases on unmount. The gateway
 *     enforces the five-camera ceiling; the wall's job is to ask honestly and let go promptly.
 *   • Tiles start paused. Opening twelve cameras because a page loaded is exactly the behaviour the
 *     ceiling exists to prevent, and an operator watching one junction should not be pulling eleven
 *     others in the background.
 *   • A refused subscription is shown as refused, with the reason. A tile that silently stays black
 *     when the ceiling is reached teaches an operator that the system is unreliable.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { RegistryCamera } from '@/lib/registry';

const GATEWAY = process.env.NEXT_PUBLIC_STREAM_GATEWAY_URL ?? 'http://localhost:4001';

type TileState = 'idle' | 'subscribing' | 'connecting' | 'playing' | 'refused' | 'failed';

interface TileProps {
  camera: RegistryCamera;
  focused: boolean;
  onFocus: () => void;
}

/**
 * WHEP, by hand.
 *
 * WHEP is a small enough protocol that a library would be more surface than help: offer SDP over
 * POST, receive answer SDP, done. Doing it directly also keeps the offline bundle smaller, which
 * matters when the venue has no network to fetch anything from.
 */
async function playWhep(
  url: string,
  video: HTMLVideoElement,
  signal: AbortSignal,
): Promise<RTCPeerConnection> {
  const pc = new RTCPeerConnection({ iceServers: [] }); // all local; no STUN needed or wanted
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = (event) => {
    if (event.streams[0]) video.srcObject = event.streams[0];
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering: MediaMTX is local, so this resolves almost immediately, and sending a
  // complete offer avoids a trickle-ICE round trip we would otherwise have to implement.
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(resolve, 1500); // never hang a tile on ICE
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/sdp' },
    body: pc.localDescription?.sdp ?? offer.sdp,
    signal,
  });
  if (!response.ok) {
    pc.close();
    throw new Error(`WHEP refused: HTTP ${response.status}`);
  }

  await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  return pc;
}

function Tile({ camera, focused, onFocus }: TileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<TileState>('idle');
  const [detail, setDetail] = useState<string | null>(null);

  const stop = useCallback(async () => {
    abortRef.current?.abort();
    pcRef.current?.close();
    pcRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState('idle');
    setDetail(null);
    // Release promptly: the upstream closes 60 s after the last subscriber, and holding a camera
    // nobody is watching is exactly the cost the ceiling is meant to avoid.
    try {
      await fetch(`${GATEWAY}/release`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ camera: camera.portalId }),
        keepalive: true,
      });
    } catch {
      // The gateway's idle timer closes it anyway; a failed release is not worth surfacing.
    }
  }, [camera.portalId]);

  const start = useCallback(async () => {
    setState('subscribing');
    setDetail(null);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const subscribed = await fetch(`${GATEWAY}/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ camera: camera.portalId }),
        signal: controller.signal,
      });

      if (subscribed.status === 429) {
        // The politeness ceiling, reported as what it is rather than as a failure.
        const body = await subscribed.json().catch(() => ({}));
        setState('refused');
        setDetail(body.hint ?? 'five cameras are already open');
        return;
      }
      if (!subscribed.ok) throw new Error(`gateway returned ${subscribed.status}`);

      const { browserUrl } = (await subscribed.json()) as { browserUrl: string };
      setState('connecting');

      if (!videoRef.current) return;
      pcRef.current = await playWhep(browserUrl, videoRef.current, controller.signal);
      setState('playing');
    } catch (err) {
      if (controller.signal.aborted) return;
      setState('failed');
      setDetail(err instanceof Error ? err.message : 'could not connect');
    }
  }, [camera.portalId]);

  useEffect(() => () => void stop(), [stop]);

  const live = state === 'playing';

  return (
    <div
      className={`relative overflow-hidden rounded-xl border bg-black ${
        focused ? 'border-[var(--color-teal)]' : 'border-[var(--color-border)]'
      }`}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        className="aspect-video w-full bg-black object-cover"
      />

      {!live && (
        <div className="absolute inset-0 grid place-items-center bg-[var(--color-surface)] p-3 text-center">
          {state === 'idle' && (
            <button
              type="button"
              onClick={start}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] px-3 py-1.5 text-xs hover:border-[var(--color-teal)]"
            >
              Open live
            </button>
          )}
          {(state === 'subscribing' || state === 'connecting') && (
            <span className="text-xs text-[var(--color-muted)]">
              {state === 'subscribing' ? 'asking the gateway…' : 'connecting…'}
            </span>
          )}
          {state === 'refused' && (
            <div className="text-xs">
              <p className="font-medium text-[var(--color-high)]">Not opened</p>
              <p className="mt-1 text-[var(--color-muted)]">{detail}</p>
            </div>
          )}
          {state === 'failed' && (
            <div className="text-xs">
              <p className="font-medium text-[var(--color-critical)]">Could not connect</p>
              <p className="mt-1 text-[var(--color-muted)]">{detail}</p>
              <button type="button" onClick={start} className="mt-2 underline underline-offset-2">
                Retry
              </button>
            </div>
          )}
        </div>
      )}

      <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/80 to-transparent px-2.5 py-1.5">
        <span className="truncate text-xs font-medium text-white">{camera.name}</span>
        <span className="flex shrink-0 items-center gap-1">
          {live && (
            <span className="rounded bg-[var(--color-critical)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
              live
            </span>
          )}
          <button
            type="button"
            onClick={onFocus}
            className="rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white/80 hover:text-white"
          >
            {focused ? 'unfocus' : 'focus'}
          </button>
        </span>
      </div>

      {live && (
        <button
          type="button"
          onClick={stop}
          className="absolute bottom-2 right-2 rounded bg-black/60 px-2 py-1 text-[10px] text-white/80 hover:text-white"
        >
          Close
        </button>
      )}
    </div>
  );
}

export function VideoWall({ cameras, maxOpen }: { cameras: RegistryCamera[]; maxOpen: number }) {
  const [focused, setFocused] = useState<string | null>(null);
  const online = cameras.filter((c) => c.status !== 'offline');

  return (
    <>
      <p className="mb-4 text-sm text-[var(--color-muted)]">
        {online.length} cameras available. Tiles open on request, never automatically — each open
        camera is a separate copy of the organisers&rsquo; stream, and at most{' '}
        <strong className="text-[var(--color-text)]">{maxOpen}</strong> may be pulled at once.
      </p>

      <div
        className={
          focused
            ? 'grid gap-3'
            : 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
        }
      >
        {(focused ? online.filter((c) => c.id === focused) : online).map((camera) => (
          <Tile
            key={camera.id}
            camera={camera}
            focused={focused === camera.id}
            onFocus={() => setFocused(focused === camera.id ? null : camera.id)}
          />
        ))}
      </div>
    </>
  );
}
