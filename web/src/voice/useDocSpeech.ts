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
  play: (sentences: readonly string[]) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  cycleRate: () => void;
}

interface SpeechState {
  playing: boolean;
  paused: boolean;
  idx: number;
}

interface SpeechRuntime extends SpeechState {
  sentences: readonly string[];
  rate: number;
}

export function useDocSpeech(): DocSpeechController {
  const synth = (typeof window !== 'undefined' && window.speechSynthesis) || null;
  const [state, setState] = useState<SpeechState>({ playing: false, paused: false, idx: -1 });
  const [rate, setRate] = useState(getRate);
  const ref = useRef<SpeechRuntime>({
    sentences: [], idx: -1, playing: false, paused: false, rate: getRate(),
  });
  ref.current.rate = rate;

  const pickZhVoice = (): SpeechSynthesisVoice | null => (
    (synth?.getVoices() || []).find((voice) => /^zh/i.test(voice.lang)) || null
  );

  const stop = (): void => {
    const current = ref.current;
    current.playing = false; current.paused = false; current.idx = -1;
    synth?.cancel();
    setState({ playing: false, paused: false, idx: -1 });
  };

  // Speak sentence i; on natural end (or error) advance to i+1; past the last sentence → stop.
  const speakAt = (i: number): void => {
    const c = ref.current;
    if (!synth) return;
    if (i < 0 || i >= c.sentences.length) { stop(); return; }
    c.idx = i;
    setState({ playing: true, paused: false, idx: i });
    const utterance = new SpeechSynthesisUtterance(c.sentences[i]);
    utterance.rate = c.rate;
    const voice = pickZhVoice();
    if (voice) { utterance.voice = voice; utterance.lang = voice.lang; } else utterance.lang = 'zh-CN';
    const next = () => { if (c.playing && c.idx === i) speakAt(i + 1); };
    utterance.onend = next;
    utterance.onerror = next;
    synth.speak(utterance);
  };

  const play = (sentences: readonly string[]): void => {
    if (!synth || !sentences || !sentences.length) return;
    synth.cancel(); // clear any queued utterances from a prior run
    const c = ref.current;
    c.sentences = sentences; c.playing = true; c.idx = -1;
    setState({ playing: true, paused: false, idx: -1 });
    // Voices can load lazily on first use; wait for them so the zh voice gets picked.
    if (synth.getVoices().length) { speakAt(0); return; }
    const start = (): void => {
      synth.removeEventListener('voiceschanged', start);
      if (c.playing && c.idx === -1) speakAt(0);
    };
    synth.addEventListener('voiceschanged', start);
    setTimeout(start, 300); // fallback if voiceschanged never fires
  };

  const pause = (): void => {
    if (synth && ref.current.playing) { synth.pause(); setState((s) => ({ ...s, paused: true })); }
  };
  const resume = (): void => {
    if (synth && ref.current.playing) { synth.resume(); setState((s) => ({ ...s, paused: false })); }
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
    playing: state.playing, paused: state.paused, idx: state.idx, rate,
    play, pause, resume, stop, cycleRate,
  };
}
