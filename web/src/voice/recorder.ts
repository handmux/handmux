// web/src/voice/recorder.js
import { toPcm16k, createFramer, bytesToBase64 } from './resample.js';
import workletUrl from './pcm-worklet.ts?worker&url'; // Vite compiles this to a hashed JavaScript asset URL

type AudioContextConstructor = new () => AudioContext;

export interface VoiceRecorder {
  start(onChunk: (base64: string) => void): Promise<void>;
  stop(): Promise<string | null>;
}

export interface RecorderDependencies {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  AudioCtor?: AudioContextConstructor;
}

const browserAudioContext = (): AudioContextConstructor => {
  const browserWindow = window as Window & { webkitAudioContext?: AudioContextConstructor };
  const AudioCtor = window.AudioContext ?? browserWindow.webkitAudioContext;
  if (!AudioCtor) throw new Error('AudioContext is unavailable');
  return AudioCtor;
};

// Capture the mic and emit base64 1280-byte (40ms) PCM frames via onChunk(base64). Dependencies are
// injectable so this stays testable-by-substitution; defaults use the real browser APIs.
export function createRecorder({
  getUserMedia = (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  AudioCtor = browserAudioContext(),
}: RecorderDependencies = {}): VoiceRecorder {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  let src: MediaStreamAudioSourceNode | null = null;
  const framer = createFramer(1280);

  async function start(onChunk: (base64: string) => void): Promise<void> {
    stream = await getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    ctx = new AudioCtor();
    await ctx.resume(); // iOS: must resume inside the user-gesture that called start()
    await ctx.audioWorklet.addModule(workletUrl);
    src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'pcm-forwarder');
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      if (!(event.data instanceof Float32Array) || !ctx) return;
      const bytes = toPcm16k(event.data, ctx.sampleRate);
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
