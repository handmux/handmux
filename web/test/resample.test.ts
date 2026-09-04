import { describe, it, expect, vi } from 'vitest';
import { toPcm16k, createFramer, bytesToBase64 } from '../src/voice/resample.js';
import {
  createRecorder, createVoiceLevelMeter, pcmSamples, voiceLevel, voiceLevelEnvelope,
} from '../src/voice/recorder.js';

describe('toPcm16k', () => {
  it('decimates 48k → 16k (1/3 length) and yields Int16 LE bytes', () => {
    const inRate: number = 48000;
    const f = new Float32Array(48000).fill(1); // 1s of full-scale
    const out = toPcm16k(f, inRate);
    expect(out.length).toBe(16000 * 2); // 16000 samples × 2 bytes
    // full-scale +1 clamps to 0x7fff → bytes ff 7f (little-endian)
    expect(out[0]).toBe(0xff); expect(out[1]).toBe(0x7f);
  });
  it('clamps out-of-range and maps negative full-scale to 0x8000', () => {
    const out = toPcm16k(new Float32Array([-2]), 16000); // -2 clamps to -1 → -32768
    expect(out[0]).toBe(0x00); expect(out[1]).toBe(0x80);
  });
});

describe('createFramer', () => {
  it('emits fixed-size frames and holds the remainder until flush', () => {
    const fr = createFramer(4);
    expect(fr.push(new Uint8Array([1, 2, 3]))).toEqual([]);          // 3 < 4, buffered
    expect(fr.push(new Uint8Array([4, 5]))).toEqual([new Uint8Array([1, 2, 3, 4])]); // one full frame, 1 left
    expect(fr.flush()).toEqual(new Uint8Array([5]));                 // remainder
    expect(fr.flush()).toBeNull();                                   // nothing left
  });
});

describe('bytesToBase64', () => {
  it('encodes bytes to base64', () => {
    expect(bytesToBase64(new Uint8Array([65, 66, 67]))).toBe('QUJD'); // "ABC"
  });
});

describe('voiceLevel', () => {
  it('keeps a low noise floor still and makes ordinary browser mic levels visible', () => {
    expect(voiceLevel(new Float32Array(16).fill(0.001))).toBe(0);
    expect(voiceLevel(new Float32Array(16).fill(0.01))).toBeCloseTo(0.375, 5);
    expect(voiceLevel(new Float32Array(16).fill(0.1))).toBeCloseTo(0.875, 5);
    expect(voiceLevel(new Float32Array(16).fill(0.5))).toBe(1);
  });

  it('uses one shared fast-attack, slow-release envelope for every composer', () => {
    expect(voiceLevelEnvelope(0.8, 0.2)).toBe(0.8);
    expect(voiceLevelEnvelope(0.1, 0.8)).toBeCloseTo(0.656, 5);
    expect(voiceLevelEnvelope(0, 2)).toBe(0.82);
  });

  it('emits one level for each fixed 40ms PCM window', () => {
    const levels: number[] = [];
    const meter = createVoiceLevelMeter(48_000, (level) => levels.push(level));
    meter(new Float32Array(960).fill(0.02));
    expect(levels).toHaveLength(0);
    meter(new Float32Array(960).fill(0.02));
    expect(levels).toHaveLength(1);
    expect(levels[0]).toBeCloseTo(voiceLevel(new Float32Array(16).fill(0.02)), 5);
  });
});

describe('pcmSamples', () => {
  it('accepts transferable buffers and Float32Array views but rejects other payloads', () => {
    const samples = new Float32Array([0.1, -0.2]);
    expect([...pcmSamples(samples.buffer)!]).toEqual([...samples]);
    expect([...pcmSamples(samples)!]).toEqual([...samples]);
    expect(pcmSamples(new Uint8Array(8))).toBeNull();
    expect(pcmSamples('bad')).toBeNull();
  });
});

describe('createRecorder level meter', () => {
  it('reads the same worklet PCM used for recognition on a fixed audio window', async () => {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const node = {
      port: { onmessage: null as ((event: MessageEvent<unknown>) => void) | null },
      connect: vi.fn(), disconnect: vi.fn(),
    };
    const context = {
      sampleRate: 48_000,
      destination: {},
      audioWorklet: { addModule: vi.fn(async () => {}) },
      resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
      createMediaStreamSource: vi.fn(() => source),
    };
    const stream = { getTracks: () => [{ stop: vi.fn() }] };
    const levels: number[] = [];
    const chunks: string[] = [];
    const recorder = createRecorder({
      getUserMedia: vi.fn(async () => stream as unknown as MediaStream),
      AudioCtor: (function FakeAudioContext() { return context; }) as unknown as new () => AudioContext,
      WorkletNodeCtor: (function FakeWorkletNode() { return node; }) as unknown as
        new (context: BaseAudioContext, name: string) => AudioWorkletNode,
    });

    await recorder.start((chunk) => chunks.push(chunk), (level) => levels.push(level));
    node.port.onmessage?.({ data: new Float32Array(1920).fill(0.1).buffer } as MessageEvent<unknown>);
    expect(levels[0]).toBeGreaterThan(0);
    expect(source.connect).toHaveBeenCalledWith(node);
    expect(chunks).toHaveLength(1);
    await recorder.stop();
  });
});
