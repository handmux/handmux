// Pure audio plumbing: downsample mono Float32 (AudioContext rate, usually 48k) to 16k/16-bit LE PCM,
// chop into fixed-size frames (1280 bytes = 40ms @ 16k), and base64-encode. No Web Audio / no WS here.

export function toPcm16k(float32: Float32Array, inRate: number): Uint8Array {
  const ratio = inRate / 16000;
  const outLen = Math.floor(float32.length / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let s = float32[Math.floor(i * ratio)];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(pcm.buffer);
}

// Stateful byte framer: push() returns whole frames now available; flush() returns the trailing
// partial frame (or null). frameBytes defaults to 1280 (= 640 Int16 samples = 40ms @ 16k).
export interface ByteFramer {
  push(bytes: Uint8Array): Uint8Array[];
  flush(): Uint8Array | null;
}

export function createFramer(frameBytes = 1280): ByteFramer {
  let buf = new Uint8Array(0);
  return {
    push(bytes: Uint8Array): Uint8Array[] {
      const merged = new Uint8Array(buf.length + bytes.length);
      merged.set(buf); merged.set(bytes, buf.length);
      const frames: Uint8Array[] = [];
      let off = 0;
      while (merged.length - off >= frameBytes) { frames.push(merged.slice(off, off + frameBytes)); off += frameBytes; }
      buf = merged.slice(off);
      return frames;
    },
    flush(): Uint8Array | null {
      if (buf.length === 0) return null;
      const out = buf;
      buf = new Uint8Array(0);
      return out;
    },
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
