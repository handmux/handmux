import { describe, it, expect } from 'vitest';
import { toPcm16k, createFramer, bytesToBase64 } from '../src/voice/resample.js';

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
