import { useRef, useState, useCallback, useEffect } from 'react';
import { createAsrSession as realCreateAsrSession } from '../api.js';
import { createRecorder } from './recorder.js';
import { createAsrDriver } from './asrDriver.js';
import type { AsrDriver, VoiceSocketData } from './asrDriver.js';
import type { AsrSessionResponse, AsrSignResponse } from '../apiRequest.js';
import type { VoiceRecorder } from './recorder.js';

export type VoicePhase = 'idle' | 'requesting' | 'recording' | 'finalizing' | 'error';

export interface VoiceSocket {
  readyState: number;
  send(data: VoiceSocketData): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

export type VoiceSocketConstructor = new (url: string) => VoiceSocket;

export interface PushToTalkDependencies {
  createSession?: () => Promise<AsrSessionResponse>;
  /** @deprecated test/integration compatibility for the former XFYUN-only handoff. */
  signAsr?: () => Promise<AsrSignResponse>;
  WebSocketCtor?: VoiceSocketConstructor;
  makeRecorder?: () => VoiceRecorder;
}

export interface UsePushToTalkOptions {
  onText: (text: string) => void;
  deps?: PushToTalkDependencies;
}

export interface PushToTalkController {
  state: VoicePhase;
  partial: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

const parseSocketData = (data: unknown): unknown => {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data) as unknown; } catch { return null; }
};

const MAX_MS = 55000; // IAT caps a session at 60s; self-finalize at 55s and prompt to press again.
const FINALIZE_MS = 4000; // after the end frame, wait this long for the server's final; else salvage + reset.

// Provider-neutral push-to-talk orchestration: start mic + request session in parallel, buffer until the
// socket opens, stream via the selected driver, then commit its latest partial when the final frame arrives.
// Guards read a stateRef (live phase) rather than the captured `state`, so the 55s cap timer and any
// long-lived closure act on the real current phase instead of the phase baked in at press time.
// Deps are injectable for tests; production uses the real session handoff/WebSocket/recorder.
export function usePushToTalk({
  onText,
  deps = {},
}: UsePushToTalkOptions): PushToTalkController {
  const createSession = deps.createSession ?? (deps.signAsr
    ? async (): Promise<AsrSessionResponse> => ({
      provider: 'xfyun', protocol: 'xfyun-iat-v2', ...await deps.signAsr!(),
    })
    : realCreateAsrSession);
  const WebSocketCtor = deps.WebSocketCtor ?? window.WebSocket as unknown as VoiceSocketConstructor;
  const makeRecorder = deps.makeRecorder ?? (() => createRecorder());

  const [state, setState] = useState<VoicePhase>('idle');
  const [partial, setPartial] = useState('');
  const partialRef = useRef('');
  const stateRef = useRef<VoicePhase>('idle');
  const setPhase = useCallback((next: VoicePhase): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  const wsRef = useRef<VoiceSocket | null>(null);
  const recRef = useRef<VoiceRecorder | null>(null);
  const driverRef = useRef<AsrDriver | null>(null);
  const pendingAudioRef = useRef<string[]>([]);
  const pendingEndRef = useRef(false);
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopRef = useRef<(() => Promise<void>) | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText; // always call the latest onText

  const cleanup = useCallback((): void => {
    if (capTimer.current !== null) clearTimeout(capTimer.current);
    if (finalizeTimer.current !== null) clearTimeout(finalizeTimer.current);
    capTimer.current = null;
    finalizeTimer.current = null;
    try { wsRef.current && wsRef.current.close(); } catch {}
    wsRef.current = null;
    const recorder = recRef.current;
    recRef.current = null;
    if (recorder) void recorder.stop().catch(() => {});
    driverRef.current = null;
    pendingAudioRef.current = [];
    pendingEndRef.current = false;
  }, []);

  // Commit whatever we've accumulated and return to idle. The single exit used by the server's final
  // frame, the finalize watchdog, and an unexpected ws close — so none of those can strand the hook in
  // recording/finalizing (which leaves the input box readOnly + unresponsive). Idempotent: a no-op once
  // already idle, so the ws.close() inside cleanup re-firing onclose can't double-commit.
  const finish = useCallback((): void => {
    if (stateRef.current === 'idle') return;
    onTextRef.current?.(partialRef.current);
    setPartial(''); setPhase('idle'); cleanup();
  }, [cleanup, setPhase]);

  const startFinalizeTimer = useCallback((): void => {
    if (finalizeTimer.current !== null) return;
    finalizeTimer.current = setTimeout(finish, FINALIZE_MS);
  }, [finish]);

  const flush = useCallback((): void => {
    const ws = wsRef.current;
    const driver = driverRef.current;
    if (!ws || ws.readyState !== 1 || !driver) return;
    for (const base64 of pendingAudioRef.current.splice(0)) ws.send(driver.audio(base64));
    if (pendingEndRef.current) {
      pendingEndRef.current = false;
      ws.send(driver.end());
      startFinalizeTimer();
    }
  }, [startFinalizeTimer]);

  const sendAudio = useCallback((base64: string): void => {
    pendingAudioRef.current.push(base64);
    flush();
  }, [flush]);

  const stop = useCallback(async (): Promise<void> => {
    if (stateRef.current !== 'recording') return;
    setPhase('finalizing');
    if (capTimer.current !== null) clearTimeout(capTimer.current);
    capTimer.current = null;
    try {
      const recorder = recRef.current;
      recRef.current = null;
      const tail = recorder ? await recorder.stop() : null;
      if (tail) sendAudio(tail);
      const ws = wsRef.current;
      if (ws) {
        pendingEndRef.current = true;
        flush();
        // A socket stuck in CONNECTING cannot receive the end frame; still guarantee the composer unlocks.
        startFinalizeTimer();
      }
      else finish();
    } catch {
      setPhase('error'); cleanup();
    }
  }, [sendAudio, cleanup, setPhase, finish, flush, startFinalizeTimer]);
  stopRef.current = stop;

  const start = useCallback(async (): Promise<void> => {
    // Start only from a settled state. 'error' is settled (and recoverable) — gating on 'idle' alone
    // would strand the mic forever after any failure (denied permission, sign error, ws drop).
    if (stateRef.current !== 'idle' && stateRef.current !== 'error') return;
    setPhase('requesting'); setPartial(''); partialRef.current = '';
    pendingAudioRef.current = []; pendingEndRef.current = false; driverRef.current = null;
    try {
      // Begin mic acquisition in the tap call stack (required by iOS), while the server signs the selected
      // provider URL in parallel. Audio produced before WebSocket open is buffered and flushed in order.
      const rec = makeRecorder();
      recRef.current = rec;
      const recorderStarted = rec.start(sendAudio);
      const [session] = await Promise.all([createSession(), recorderStarted]);
      const driver = createAsrDriver(session);
      driverRef.current = driver;
      const ws = new WebSocketCtor(session.url);
      wsRef.current = ws;
      ws.onopen = flush;
      ws.onmessage = (event) => {
        const message = parseSocketData(event.data);
        const result = driver.consume(message);
        partialRef.current = result.text;
        setPartial(result.text);
        if (result.error) { setPhase('error'); cleanup(); }
        else if (result.final) finish();
      };
      ws.onerror = () => { setPhase('error'); cleanup(); };
      // An unexpected close mid-session must not strand us in recording/finalizing — salvage + reset.
      // (Our own cleanup() also closes the ws, but finish() is idempotent once idle, so that's a no-op.)
      ws.onclose = () => {
        if (stateRef.current === 'recording' || stateRef.current === 'finalizing') finish();
      };
      setPhase('recording');
      flush();
      capTimer.current = setTimeout(() => { stopRef.current?.(); }, MAX_MS);
    } catch {
      setPhase('error'); cleanup();
    }
  }, [createSession, WebSocketCtor, makeRecorder, sendAudio, cleanup, setPhase, finish, flush]);

  useEffect(() => cleanup, [cleanup]); // close ws + mic on unmount

  return { state, partial, start, stop };
}
