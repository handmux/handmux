import { useRef, useState, useCallback, useEffect } from 'react';
import {
  createAsrSession as realCreateAsrSession,
  recognizeSentence as realRecognizeSentence,
} from '../api.js';
import { createRecorder } from './recorder.js';
import { createAsrDriver } from './asrDriver.js';
import { base64ToBytes } from './tencentProtocol.js';
import type { AsrDriver, VoiceSocketData } from './asrDriver.js';
import type { AsrSessionResponse, AsrSignResponse } from '../apiRequest.js';
import type { VoiceRecorder } from './recorder.js';
import { voiceErrorText } from './error.js';
import { t } from '../i18n';

export type VoicePhase = 'idle' | 'requesting' | 'recording' | 'finalizing' | 'error';
export type AsrMode = 'streaming' | 'sentence';

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
  recognizeSentence?: (audio: Uint8Array) => Promise<string>;
}

export interface UsePushToTalkOptions {
  onText: (text: string) => void;
  mode?: AsrMode;
  deps?: PushToTalkDependencies;
}

export interface PushToTalkController {
  state: VoicePhase;
  partial: string;
  level: number;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

const parseSocketData = (data: unknown): unknown => {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data) as unknown; } catch { return null; }
};

const mergeAudio = (chunks: readonly string[]): Uint8Array => {
  const parts = chunks.map(base64ToBytes);
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
};

const MAX_MS = 55000; // Providers cap short sessions at 60s; self-finalize at 55s with payload headroom.
const FINALIZE_MS = 4000; // after the end frame, wait this long for the server's final; else salvage + reset.
const ERROR_MS = 7000; // enough to read an actionable error, without permanently growing the composer.

// Provider-neutral push-to-talk orchestration: start mic + request session in parallel, buffer until the
// socket opens, stream via the selected driver, then commit its latest partial when the final frame arrives.
// Guards read a stateRef (live phase) rather than the captured `state`, so the 55s cap timer and any
// long-lived closure act on the real current phase instead of the phase baked in at press time.
// Deps are injectable for tests; production uses the real session handoff/WebSocket/recorder.
export function usePushToTalk({
  onText,
  mode = 'streaming',
  deps = {},
}: UsePushToTalkOptions): PushToTalkController {
  const createSession = deps.createSession ?? (deps.signAsr
    ? async (): Promise<AsrSessionResponse> => ({
      provider: 'xfyun', protocol: 'xfyun-iat-v2', ...await deps.signAsr!(),
    })
    : realCreateAsrSession);
  const WebSocketCtor = deps.WebSocketCtor ?? window.WebSocket as unknown as VoiceSocketConstructor;
  const makeRecorder = deps.makeRecorder ?? (() => createRecorder());
  const recognizeSentence = deps.recognizeSentence ?? realRecognizeSentence;

  const [state, setState] = useState<VoicePhase>('idle');
  const [partial, setPartial] = useState('');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
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
  const sentenceAudioRef = useRef<string[]>([]);
  const activeModeRef = useRef<AsrMode>(mode);
  const pendingEndRef = useRef(false);
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopRef = useRef<(() => Promise<void>) | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText; // always call the latest onText

  const clearError = useCallback((): void => {
    if (errorTimer.current !== null) clearTimeout(errorTimer.current);
    errorTimer.current = null;
    setError(null);
  }, []);
  const showError = useCallback((message: string): void => {
    if (errorTimer.current !== null) clearTimeout(errorTimer.current);
    setError(message);
    errorTimer.current = setTimeout(() => {
      errorTimer.current = null;
      setError(null);
    }, ERROR_MS);
  }, []);

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
    sentenceAudioRef.current = [];
    pendingEndRef.current = false;
    setLevel(0);
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
      if (activeModeRef.current === 'sentence') {
        if (tail) sentenceAudioRef.current.push(tail);
        const audio = mergeAudio(sentenceAudioRef.current);
        if (audio.byteLength === 0) throw new Error('audio is empty');
        const text = await recognizeSentence(audio);
        onTextRef.current?.(text);
        setPartial('');
        setPhase('idle');
        cleanup();
        return;
      }
      if (tail) sendAudio(tail);
      const ws = wsRef.current;
      if (ws) {
        pendingEndRef.current = true;
        flush();
        // A socket stuck in CONNECTING cannot receive the end frame; still guarantee the composer unlocks.
        startFinalizeTimer();
      }
      else finish();
    } catch (cause) {
      showError(voiceErrorText(cause));
      setPhase('error'); cleanup();
    }
  }, [sendAudio, cleanup, setPhase, finish, flush, startFinalizeTimer, recognizeSentence, showError]);
  stopRef.current = stop;

  const start = useCallback(async (): Promise<void> => {
    // Start only from a settled state. 'error' is settled (and recoverable) — gating on 'idle' alone
    // would strand the mic forever after any failure (denied permission, sign error, ws drop).
    if (stateRef.current !== 'idle' && stateRef.current !== 'error') return;
    setPhase('requesting'); setPartial(''); partialRef.current = ''; clearError();
    setLevel(0); activeModeRef.current = mode;
    pendingAudioRef.current = []; pendingEndRef.current = false; driverRef.current = null;
    sentenceAudioRef.current = [];
    try {
      // Begin mic acquisition in the tap call stack (required by iOS), while the server signs the selected
      // provider URL in parallel. Audio produced before WebSocket open is buffered and flushed in order.
      const rec = makeRecorder();
      recRef.current = rec;
      const recorderStarted = rec.start(
        mode === 'sentence'
          ? (base64) => { sentenceAudioRef.current.push(base64); }
          : sendAudio,
        setLevel,
      );
      if (mode === 'sentence') {
        await recorderStarted;
        setPhase('recording');
        capTimer.current = setTimeout(() => { stopRef.current?.(); }, MAX_MS);
        return;
      }
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
        if (result.error) {
          showError(t('mic.error.provider', { reason: result.error }));
          setPhase('error'); cleanup();
        }
        else if (result.final) finish();
      };
      ws.onerror = () => { showError(t('mic.error.network')); setPhase('error'); cleanup(); };
      // An unexpected close mid-session must not strand us in recording/finalizing — salvage + reset.
      // (Our own cleanup() also closes the ws, but finish() is idempotent once idle, so that's a no-op.)
      ws.onclose = () => {
        if (stateRef.current === 'recording' || stateRef.current === 'finalizing') finish();
      };
      setPhase('recording');
      flush();
      capTimer.current = setTimeout(() => { stopRef.current?.(); }, MAX_MS);
    } catch (cause) {
      showError(voiceErrorText(cause));
      setPhase('error'); cleanup();
    }
  }, [mode, createSession, WebSocketCtor, makeRecorder, sendAudio, cleanup, setPhase, finish, flush,
    clearError, showError]);

  useEffect(() => () => {
    cleanup();
    if (errorTimer.current !== null) clearTimeout(errorTimer.current);
  }, [cleanup]); // close ws + mic and pending notice timer on unmount

  return { state, partial, level, error, start, stop };
}
