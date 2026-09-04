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
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
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
export function voiceLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0.001) return 0;
  const decibels = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (decibels + 55) / 40));
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
  requestFrame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame,
}: RecorderDependencies = {}): VoiceRecorder {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  let src: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let levelFrame: number | null = null;
  const framer = createFramer(1280);

  async function start(onChunk: (base64: string) => void, onLevel?: (level: number) => void): Promise<void> {
    stream = await getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    ctx = new AudioCtor();
    await ctx.resume(); // iOS: must resume inside the user-gesture that called start()
    await ctx.audioWorklet.addModule(workletUrl);
    src = ctx.createMediaStreamSource(stream);
    node = new WorkletNodeCtor(ctx, 'pcm-forwarder');
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      const samples = pcmSamples(event.data);
      if (!samples || !ctx) return;
      const bytes = toPcm16k(samples, ctx.sampleRate);
      for (const frame of framer.push(bytes)) onChunk(bytesToBase64(frame));
    };
    if (onLevel) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const meterSamples = new Float32Array(analyser.fftSize);
      const updateLevel = (): void => {
        if (!analyser) return;
        analyser.getFloatTimeDomainData(meterSamples);
        onLevel(voiceLevel(meterSamples));
        levelFrame = requestFrame(updateLevel);
      };
      src.connect(analyser);
      analyser.connect(node);
      levelFrame = requestFrame(updateLevel);
    } else src.connect(node);
    node.connect(ctx.destination); // required for the graph to pull audio; worklet emits no output
  }

  async function stop(): Promise<string | null> {
    if (levelFrame !== null) cancelFrame(levelFrame);
    levelFrame = null;
    try { node && (node.port.onmessage = null); } catch {}
    try { src && src.disconnect(); analyser && analyser.disconnect(); node && node.disconnect(); } catch {}
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { ctx && (await ctx.close()); } catch {}
    const tail = framer.flush();
    ctx = stream = node = src = analyser = null;
    return tail ? bytesToBase64(tail) : null; // caller appends to the final frame before status=2
  }

  return { start, stop };
}
