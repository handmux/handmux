// web/src/voice/recorder.js
import { toPcm16k, createFramer, bytesToBase64 } from './resample.js';
import workletUrl from './pcm-worklet.ts?worker&url'; // Vite compiles this to a hashed JavaScript asset URL

type AudioContextConstructor = new () => AudioContext;
type AudioWorkletNodeConstructor = new (context: BaseAudioContext, name: string) => AudioWorkletNode;

export interface VoiceRecorder {
  start(onChunk: (base64: string) => void, onLevel?: (level: number) => void): Promise<void>;
  stop(): Promise<string | null>;
}

export interface RecorderDependencies {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  AudioCtor?: AudioContextConstructor;
  WorkletNodeCtor?: AudioWorkletNodeConstructor;
}

const browserAudioContext = (): AudioContextConstructor => {
  const browserWindow = window as Window & { webkitAudioContext?: AudioContextConstructor };
  const AudioCtor = window.AudioContext ?? browserWindow.webkitAudioContext;
  if (!AudioCtor) throw new Error('AudioContext is unavailable');
  return AudioCtor;
};

// Map microphone RMS into a useful 0..1 visual range. A logarithmic dB scale matches perceived loudness
// and keeps normal browser mic levels visible; the old linear 0.008 floor made common 0.01–0.03 speech
// move the tallest bar by less than two pixels.
function voiceLevelFromRms(rms: number): number {
  if (rms <= 0.001) return 0;
  const decibels = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (decibels + 55) / 40));
}

export function voiceLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return voiceLevelFromRms(Math.sqrt(sum / samples.length));
}

// Speech energy rises immediately but falls through a short envelope, keeping the display stable between
// the fixed audio windows without changing the measured peak.
export function voiceLevelEnvelope(sampled: number, previous: number): number {
  const next = Math.max(0, Math.min(1, sampled));
  const current = Math.max(0, Math.min(1, previous));
  return next >= current ? next : Math.max(next, current * 0.82);
}

// Accumulate the exact PCM stream used for recognition into fixed 40 ms energy windows. Unlike an
// animation-frame analyser, this produces the same values and cadence no matter how expensive the
// consuming composer is to paint.
export function createVoiceLevelMeter(sampleRate: number, onLevel: (level: number) => void) {
  const windowSamples = Math.max(1, Math.round(sampleRate * 0.04));
  let sumSquares = 0;
  let sampleCount = 0;
  let envelope = 0;
  return (samples: Float32Array): void => {
    for (const sample of samples) {
      sumSquares += sample * sample;
      sampleCount += 1;
      if (sampleCount < windowSamples) continue;
      const rms = Math.sqrt(sumSquares / sampleCount);
      envelope = voiceLevelEnvelope(voiceLevelFromRms(rms), envelope);
      onLevel(envelope);
      sumSquares = 0;
      sampleCount = 0;
    }
  };
}

// AudioWorklet messages cross a separate JS realm. `ArrayBuffer.isView` is realm-safe; `instanceof` is
// not. Accept the new transferable ArrayBuffer and already-loaded clients that still send Float32Array.
export function pcmSamples(value: unknown): Float32Array | null {
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    const buffer = value as ArrayBuffer;
    return buffer.byteLength % Float32Array.BYTES_PER_ELEMENT === 0 ? new Float32Array(buffer) : null;
  }
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Float32Array]'
    || value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return null;
  return new Float32Array(value.buffer, value.byteOffset,
    value.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

// Capture the mic and emit base64 1280-byte (40ms) PCM frames via onChunk(base64). Dependencies are
// injectable so this stays testable-by-substitution; defaults use the real browser APIs.
export function createRecorder({
  getUserMedia = (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  AudioCtor = browserAudioContext(),
  WorkletNodeCtor = AudioWorkletNode,
}: RecorderDependencies = {}): VoiceRecorder {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  let src: MediaStreamAudioSourceNode | null = null;
  const framer = createFramer(1280);

  async function start(onChunk: (base64: string) => void, onLevel?: (level: number) => void): Promise<void> {
    stream = await getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    ctx = new AudioCtor();
    await ctx.resume(); // iOS: must resume inside the user-gesture that called start()
    await ctx.audioWorklet.addModule(workletUrl);
    src = ctx.createMediaStreamSource(stream);
    node = new WorkletNodeCtor(ctx, 'pcm-forwarder');
    const meter = onLevel ? createVoiceLevelMeter(ctx.sampleRate, onLevel) : null;
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      const samples = pcmSamples(event.data);
      if (!samples || !ctx) return;
      meter?.(samples);
      const bytes = toPcm16k(samples, ctx.sampleRate);
      for (const frame of framer.push(bytes)) onChunk(bytesToBase64(frame));
    };
    src.connect(node);
    node.connect(ctx.destination); // required for the graph to pull audio; worklet emits no output
  }

  async function stop(): Promise<string | null> {
    try { node && (node.port.onmessage = null); } catch {}
    try { src && src.disconnect(); node && node.disconnect(); } catch {}
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { ctx && (await ctx.close()); } catch {}
    const tail = framer.flush();
    ctx = stream = node = src = null;
    return tail ? bytesToBase64(tail) : null; // caller appends to the final frame before status=2
  }

  return { start, stop };
}
