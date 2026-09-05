import { describe, expect, it } from 'vitest';
import {
  accumulateTencent, base64ToBytes, emptyTencentTranscript, tencentTextOf,
} from '../src/voice/tencentProtocol.js';

describe('Tencent real-time ASR v2 protocol', () => {
  it('replaces live hypotheses by result index and orders completed slices', () => {
    let state = emptyTencentTranscript();
    state = accumulateTencent(state, {
      code: 0, result: { slice_type: 1, index: 1, voice_text_str: '世界' },
    });
    state = accumulateTencent(state, {
      code: 0, result: { slice_type: 1, index: 0, voice_text_str: '你号' },
    });
    expect(tencentTextOf(state)).toBe('你号世界');
    state = accumulateTencent(state, {
      code: 0, result: { slice_type: 2, index: 0, voice_text_str: '你好' },
    });
    expect(tencentTextOf(state)).toBe('你好世界');
  });

  it('decodes recorder base64 into raw binary PCM', () => {
    expect([...base64ToBytes('QUJD')]).toEqual([65, 66, 67]);
  });
});
