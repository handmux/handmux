import { describe, expect, it } from 'vitest';
import {
  accumulateTencent, base64ToBytes, emptyTencentTranscript, tencentTextOf,
} from '../src/voice/tencentProtocol.js';

describe('Tencent real-time ASR v2 protocol', () => {
  it('replaces unstable sentence hypotheses by sentence_id and orders them', () => {
    let state = emptyTencentTranscript();
    state = accumulateTencent(state, { sentences: { sentence_list: [
      { sentence_id: 1, sentence_type: 0, sentence: '世界' },
      { sentence_id: 0, sentence_type: 0, sentence: '你号' },
    ] } });
    expect(tencentTextOf(state)).toBe('你号世界');
    state = accumulateTencent(state, { sentences: { sentence_list: [
      { sentence_id: 0, sentence_type: 1, sentence: '你好' },
    ] } });
    expect(tencentTextOf(state)).toBe('你好世界');
  });

  it('decodes recorder base64 into raw binary PCM', () => {
    expect([...base64ToBytes('QUJD')]).toEqual([65, 66, 67]);
  });
});
