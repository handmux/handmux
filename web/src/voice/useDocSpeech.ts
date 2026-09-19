import { useEffect, useRef, useState } from 'react';

// Read-aloud controller over the Web Speech API. We speak ONE sentence per utterance and chain via
// onend, instead of feeding the whole doc to one utterance — mobile Safari truncates long utterances
// and its onboundary events are unreliable, so per-sentence chaining gives both robust playback and a
// clean per-sentence highlight signal (`idx`). All mutable playback state lives in a ref so the
// utterance callbacks never read stale React state; `state`/`rate` exist only to drive the UI.

const RATE_KEY = 'tw_doc_rate';
export const RATES: readonly number[] = [1, 1.25, 1.5];
const getRate = (): number => {
  const value = Number(localStorage.getItem(RATE_KEY));
  return RATES.includes(value) ? value : 1;
};

export interface DocSpeechController {
  supported: boolean;
  playing: boolean;
  paused: boolean;
  idx: number;
  rate: number;
  /** The engine refused to start (iOS reports this when speech is not allowed) — the UI must say so
   *  rather than let the tap look like a no-op. Cleared by the next play/stop. */
  failed: boolean;
  /** Start reading. `from` (sentence index) lets the caller begin anywhere — tapping a sentence. */
  play: (sentences: readonly string[], from?: number) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  cycleRate: () => void;
}

interface SpeechState {
  playing: boolean;
  paused: boolean;
  idx: number;
  failed: boolean;
}

interface SpeechRuntime extends SpeechState {
  sentences: readonly string[];
  rate: number;
}

// Errors that mean "the utterance never started". iOS reports not-allowed when speak() did not run
// inside the user gesture; treating those like a finished sentence would race through the whole
// document in silence, so they stop playback and surface instead.
const REFUSED_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'synthesis-failed', 'audio-busy']);

export function useDocSpeech(): DocSpeechController {
  const synth = (typeof window !== 'undefined' && window.speechSynthesis) || null;
  const [state, setState] = useState<SpeechState>({ playing: false, paused: false, idx: -1, failed: false });
  const [rate, setRate] = useState(getRate);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const ref = useRef<SpeechRuntime>({
    sentences: [], idx: -1, playing: false, paused: false, rate: getRate(), failed: false,
  });
  ref.current.rate = rate;

  // Voices load asynchronously (and on iOS only after the first speak), so keep a cache refreshed by
  // `voiceschanged` instead of waiting for it — waiting would push speak() out of the user gesture.
  useEffect(() => {
    if (!synth) return undefined;
    const refresh = (): void => { voicesRef.current = synth.getVoices() || []; };
    refresh();
    synth.addEventListener('voiceschanged', refresh);
    return () => synth.removeEventListener('voiceschanged', refresh);
  }, [synth]);

  // Prefer a Chinese voice, but never let the list become a gate: iOS in a standalone PWA can leave
  // `voiceschanged` unfired, so re-read the list on demand when the cache is still empty.
  const pickZhVoice = (): SpeechSynthesisVoice | null => {
    if (!voicesRef.current.length) voicesRef.current = synth?.getVoices() || [];
    return voicesRef.current.find((voice) => /^zh/i.test(voice.lang)) || null;
  };

  const stop = (): void => {
    const current = ref.current;
    current.playing = false; current.paused = false; current.idx = -1;
    synth?.cancel();
    setState({ playing: false, paused: false, idx: -1, failed: false });
  };

  const fail = (): void => {
    const current = ref.current;
    current.playing = false; current.paused = false; current.idx = -1;
    synth?.cancel();
    setState({ playing: false, paused: false, idx: -1, failed: true });
  };

  // Speak sentence i; on natural end advance to i+1; past the last sentence → stop.
  const speakAt = (i: number): void => {
    const c = ref.current;
    if (!synth) return;
    if (i < 0 || i >= c.sentences.length) { stop(); return; }
    c.idx = i;
    setState({ playing: true, paused: false, idx: i, failed: false });
    const utterance = new SpeechSynthesisUtterance(c.sentences[i]);
    utterance.rate = c.rate;
    const voice = pickZhVoice();
    if (voice) { utterance.voice = voice; utterance.lang = voice.lang; } else utterance.lang = 'zh-CN';
    const next = () => { if (c.playing && c.idx === i) speakAt(i + 1); };
    utterance.onend = next;
    utterance.onerror = (event) => {
      const code = (event as SpeechSynthesisErrorEvent).error;
      // 'interrupted'/'canceled' are our own cancel() (rate change, jump, stop) — keep chaining.
      if (REFUSED_ERRORS.has(code)) { fail(); return; }
      next();
    };
    synth.speak(utterance);
  };

  // `from` starts the read at any sentence — tapping a sentence in the document jumps there.
  // speak() runs SYNCHRONOUSLY inside the caller's tap: iOS only starts speech from a user-gesture
  // task, so any deferral (waiting for voices, a timeout) is dropped silently — which is exactly what
  // a play button that "does nothing" was.
  const play = (sentences: readonly string[], from = 0): void => {
    if (!synth || !sentences || !sentences.length) return;
    synth.cancel(); // clear any queued utterances from a prior run
    const c = ref.current;
    c.sentences = sentences; c.playing = true; c.idx = -1;
    setState({ playing: true, paused: false, idx: -1, failed: false });
    speakAt(Math.max(0, Math.min(sentences.length - 1, from)));
  };

  const pause = (): void => {
    if (synth && ref.current.playing) { synth.pause(); setState((s) => ({ ...s, paused: true })); }
  };

  // Recover from a failure WITHOUT a fresh document walk (the sentences are still loaded) — this is
  // also the retry that can succeed on iOS, since it runs inside a new tap.
  const resume = (): void => {
    if (!synth) return;
    const c = ref.current;
    if (c.playing) { synth.resume(); setState((s) => ({ ...s, paused: false })); return; }
    if (c.failed && c.sentences.length) { c.playing = true; speakAt(Math.max(0, c.idx)); }
  };

  // Cycle 1x→1.25x→1.5x→1x, persist, and (if mid-read) re-speak the current sentence so the new
  // rate takes effect immediately (rate can't change on an in-flight utterance).
  const cycleRate = (): void => {
    const nextRate = RATES[(RATES.indexOf(rate) + 1) % RATES.length] || 1;
    localStorage.setItem(RATE_KEY, String(nextRate));
    ref.current.rate = nextRate;
    setRate(nextRate);
    const c = ref.current;
    if (synth && c.playing && c.idx >= 0) { synth.cancel(); speakAt(c.idx); }
  };

  // Stop on unmount so audio never outlives the doc view.
  useEffect(() => () => { ref.current.playing = false; if (synth) synth.cancel(); }, [synth]);

  return {
    supported: !!synth,
    playing: state.playing, paused: state.paused, idx: state.idx, rate, failed: state.failed,
    play, pause, resume, stop, cycleRate,
  };
}
