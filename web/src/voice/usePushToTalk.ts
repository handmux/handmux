import { useRef, useState, useCallback, useEffect } from 'react';
import { signAsr as realSignAsr } from '../api.js';
import { createRecorder } from './recorder.js';
import { buildFirstFrame, buildAudioFrame, buildEndFrame, emptyTranscript, accumulate, textOf } from './iatProtocol.js';
import type { TranscriptState } from './iatProtocol.js';
import type { VoiceRecorder } from './recorder.js';

export type VoicePhase = 'idle' | 'requesting' | 'recording' | 'finalizing' | 'error';

interface AsrSignature {
  url: string;
  appId: string;
}

export interface VoiceSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

export type VoiceSocketConstructor = new (url: string) => VoiceSocket;

export interface PushToTalkDependencies {
  signAsr?: () => Promise<AsrSignature>;
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

const isFinalMessage = (value: unknown): boolean => {
  if (value === null || typeof value !== 'object' || !('data' in value)) return false;
  const data = value.data;
  return data !== null && typeof data === 'object' && 'status' in data && data.status === 2;
};

const MAX_MS = 55000; // IAT caps a session at 60s; self-finalize at 55s and prompt to press again.
const FINALIZE_MS = 4000; // after the end frame, wait this long for the server's final; else salvage + reset.

// Push-to-talk orchestration: signAsr → open ws → stream mic frames → accumulate wpgs → on stop send
// the end frame and, when the server returns its final (data.status===2), hand the text to onText().
// Guards read a stateRef (live phase) rather than the captured `state`, so the 55s cap timer and any
// long-lived closure act on the real current phase instead of the phase baked in at press time.
// Deps are injectable for tests; production uses the real signAsr/WebSocket/recorder.
export function usePushToTalk({
  onText,
  deps = {},
}: UsePushToTalkOptions): PushToTalkController {
  const signAsr = deps.signAsr ?? realSignAsr;
  const WebSocketCtor = deps.WebSocketCtor ?? window.WebSocket as unknown as VoiceSocketConstructor;
  const makeRecorder = deps.makeRecorder ?? (() => createRecorder());

  const [state, setState] = useState<VoicePhase>('idle');
  const [partial, setPartial] = useState('');
  const stateRef = useRef<VoicePhase>('idle');
  const setPhase = useCallback((next: VoicePhase): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  const wsRef = useRef<VoiceSocket | null>(null);
  const recRef = useRef<VoiceRecorder | null>(null);
  const transRef = useRef<TranscriptState>(emptyTranscript());
  const appIdRef = useRef('');
  const firstSentRef = useRef(false);
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
    firstSentRef.current = false;
  }, []);

  // Commit whatever we've accumulated and return to idle. The single exit used by the server's final
  // frame, the finalize watchdog, and an unexpected ws close — so none of those can strand the hook in
  // recording/finalizing (which leaves the input box readOnly + unresponsive). Idempotent: a no-op once
  // already idle, so the ws.close() inside cleanup re-firing onclose can't double-commit.
  const finish = useCallback((): void => {
    if (stateRef.current === 'idle') return;
    onTextRef.current?.(textOf(transRef.current));
    setPartial(''); setPhase('idle'); cleanup();
  }, [cleanup, setPhase]);

  const sendAudio = useCallback((base64: string): void => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify(firstSentRef.current
      ? buildAudioFrame(base64)
      : buildFirstFrame(appIdRef.current, base64)));
    firstSentRef.current = true;
  }, []);

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
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(buildEndFrame()));
        // Don't wait forever for the server's final frame — a stalled IAT/ws would pin us in
        // finalizing and lock the input. Salvage the current text and reset if it doesn't arrive.
        finalizeTimer.current = setTimeout(() => finish(), FINALIZE_MS);
      } else finish();
    } catch {
      setPhase('error'); cleanup();
    }
  }, [sendAudio, cleanup, setPhase, finish]);
  stopRef.current = stop;

  const start = useCallback(async (): Promise<void> => {
    // Start only from a settled state. 'error' is settled (and recoverable) — gating on 'idle' alone
    // would strand the mic forever after any failure (denied permission, sign error, ws drop).
    if (stateRef.current !== 'idle' && stateRef.current !== 'error') return;
    setPhase('requesting'); setPartial(''); transRef.current = emptyTranscript(); firstSentRef.current = false;
    try {
      const { url, appId } = await signAsr();
      appIdRef.current = appId;
      const ws = new WebSocketCtor(url);
      wsRef.current = ws;
      ws.onmessage = (event) => {
        const message = parseSocketData(event.data);
        transRef.current = accumulate(transRef.current, message);
        setPartial(textOf(transRef.current));
        if (isFinalMessage(message)) finish();
      };
      ws.onerror = () => { setPhase('error'); cleanup(); };
      // An unexpected close mid-session must not strand us in recording/finalizing — salvage + reset.
      // (Our own cleanup() also closes the ws, but finish() is idempotent once idle, so that's a no-op.)
      ws.onclose = () => {
        if (stateRef.current === 'recording' || stateRef.current === 'finalizing') finish();
      };
      const rec = makeRecorder();
      recRef.current = rec;
      await rec.start(sendAudio);
      setPhase('recording');
      capTimer.current = setTimeout(() => { stopRef.current?.(); }, MAX_MS);
    } catch {
      setPhase('error'); cleanup();
    }
  }, [signAsr, WebSocketCtor, makeRecorder, sendAudio, cleanup, setPhase, finish]);

  useEffect(() => cleanup, [cleanup]); // close ws + mic on unmount

  return { state, partial, start, stop };
}
