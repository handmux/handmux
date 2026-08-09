// iFlytek IAT v2 protocol: outgoing frame builders + incoming wpgs result accumulator. Pure — no WS,
// no audio. The transcript is a Map<sn, sentenceText>; rpl deletes an sn range before setting, apd
// just sets. textOf() joins sentences in sn order. See https://www.xfyun.cn/doc/asr/voicedictation/API.html

const BUSINESS = { language: 'zh_cn', domain: 'iat', accent: 'mandarin', vad_eos: 10000, dwa: 'wpgs', ptt: 1, nunum: 1 };
const FORMAT = 'audio/L16;rate=16000';

export interface TranscriptState {
  sentences: Map<number, string>;
}

interface AudioFrameData {
  status: 0 | 1 | 2;
  format: string;
  encoding: 'raw';
  audio: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
);

export function buildFirstFrame(appId: string, audioB64: string) {
  return { common: { app_id: appId }, business: { ...BUSINESS }, data: { status: 0, format: FORMAT, encoding: 'raw', audio: audioB64 } };
}
export function buildAudioFrame(audioB64: string): { data: AudioFrameData } {
  return { data: { status: 1, format: FORMAT, encoding: 'raw', audio: audioB64 } };
}
export function buildEndFrame(): { data: AudioFrameData } {
  return { data: { status: 2, format: FORMAT, encoding: 'raw', audio: '' } };
}

export function emptyTranscript(): TranscriptState {
  return { sentences: new Map() };
}
export function accumulate(state: TranscriptState, message: unknown): TranscriptState {
  const data = asRecord(asRecord(message)?.data);
  const result = asRecord(data?.result);
  if (!result || typeof result.sn !== 'number' || !Array.isArray(result.ws)) return state;
  const text = result.ws.map((word) => {
    const candidates = asRecord(word)?.cw;
    if (!Array.isArray(candidates)) return '';
    return candidates.map((candidate) => {
      const value = asRecord(candidate)?.w;
      return typeof value === 'string' ? value : '';
    }).join('');
  }).join('');
  const next = new Map(state.sentences);
  if (result.pgs === 'rpl' && Array.isArray(result.rg)
    && typeof result.rg[0] === 'number' && typeof result.rg[1] === 'number') {
    for (let index = result.rg[0]; index <= result.rg[1]; index++) next.delete(index);
  }
  next.set(result.sn, text);
  return { sentences: next };
}
export function textOf(state: TranscriptState): string {
  return [...state.sentences.keys()].sort((a, b) => a - b).map((k) => state.sentences.get(k)).join('');
}
