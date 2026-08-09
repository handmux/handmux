import { describe, it, expect } from 'vitest';
import {
  buildFirstFrame, buildAudioFrame, buildEndFrame,
  emptyTranscript, accumulate, textOf,
} from '../src/voice/iatProtocol.js';

describe('iatProtocol vad_eos', () => {
  it('首帧把 vad_eos 设到 IAT 上限 10000(停顿不自动断句)', () => {
    const frame = buildFirstFrame('app123', 'AAAA');
    expect(frame.business.vad_eos).toBe(10000);
  });
  it('首帧仍带原有业务参数与音频', () => {
    const frame = buildFirstFrame('app123', 'AAAA');
    expect(frame.common.app_id).toBe('app123');
    expect(frame.business.dwa).toBe('wpgs');
    expect(frame.data.status).toBe(0);
    expect(frame.data.audio).toBe('AAAA');
  });
});

describe('IAT outgoing frames', () => {
  it('first frame carries app_id + wpgs/ptt/nunum business + first audio chunk (status 0)', () => {
    const f = buildFirstFrame('APP1', 'QUJD'); // QUJD = base64("ABC")
    expect(f.common).toEqual({ app_id: 'APP1' });
    expect(f.business).toMatchObject({ language: 'zh_cn', domain: 'iat', accent: 'mandarin', dwa: 'wpgs', ptt: 1, nunum: 1 });
    expect(f.data).toMatchObject({ status: 0, format: 'audio/L16;rate=16000', encoding: 'raw', audio: 'QUJD' });
  });
  it('audio frame is status 1 with the chunk', () => {
    expect(buildAudioFrame('QUJD').data).toMatchObject({ status: 1, audio: 'QUJD', encoding: 'raw' });
  });
  it('end frame is status 2 with empty audio', () => {
    expect(buildEndFrame().data).toMatchObject({ status: 2, audio: '' });
  });
});

const res = (sn: number, words: string[], pgs: string, rg?: [number, number]) => ({
  data: { result: { sn, pgs, rg, ws: words.map((w) => ({ cw: [{ w }] })) } },
});

describe('IAT wpgs accumulation', () => {
  it('appends successive sentences', () => {
    let s = emptyTranscript();
    s = accumulate(s, res(1, ['你好'], 'apd'));
    s = accumulate(s, res(2, ['世界'], 'apd'));
    expect(textOf(s)).toBe('你好世界');
  });
  it('rpl replaces an sn range with the new sentence (dynamic correction)', () => {
    let s = emptyTranscript();
    s = accumulate(s, res(1, ['打开'], 'apd'));
    s = accumulate(s, res(2, ['文挡'], 'apd'));      // mis-heard
    s = accumulate(s, res(2, ['文档'], 'rpl', [2, 2])); // corrected
    expect(textOf(s)).toBe('打开文档');
  });
  it('rpl over a multi-sn range collapses them', () => {
    let s = emptyTranscript();
    s = accumulate(s, res(1, ['一'], 'apd'));
    s = accumulate(s, res(2, ['二'], 'apd'));
    s = accumulate(s, res(2, ['一二三'], 'rpl', [1, 2]));
    expect(textOf(s)).toBe('一二三');
  });
  it('ignores frames without a result (e.g. handshake/heartbeat)', () => {
    let s = emptyTranscript();
    s = accumulate(s, { data: {} });
    expect(textOf(s)).toBe('');
  });
  it('does not mutate the prior state (immutable accumulate)', () => {
    const s0 = accumulate(emptyTranscript(), res(1, ['你好'], 'apd'));
    accumulate(s0, res(2, ['世界'], 'apd')); // derive a newer state, discard it
    expect(textOf(s0)).toBe('你好'); // s0 is untouched
  });
  it('re-receiving the same sn overwrites (idempotent, no double-count)', () => {
    let s = emptyTranscript();
    s = accumulate(s, res(1, ['开始'], 'apd'));
    s = accumulate(s, res(1, ['开始'], 'apd')); // server echoes the same sn (e.g. on the final frame)
    expect(textOf(s)).toBe('开始');
  });
  it('orders by sn even when sentences arrive out of order', () => {
    let s = emptyTranscript();
    s = accumulate(s, res(2, ['世界'], 'apd'));
    s = accumulate(s, res(1, ['你好'], 'apd'));
    expect(textOf(s)).toBe('你好世界');
  });
});
