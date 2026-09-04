export interface TencentTranscriptState {
  sentences: Map<number, string>;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

export function emptyTencentTranscript(): TencentTranscriptState {
  return { sentences: new Map() };
}

// ASR v2 repeatedly emits a sentence_id while sentence_type=0, then replaces it with the stable type=1
// text. Replacing by id keeps the live partial honest without duplicating each intermediate hypothesis.
export function accumulateTencent(
  state: TencentTranscriptState,
  message: unknown,
): TencentTranscriptState {
  const sentences = asRecord(asRecord(message)?.sentences);
  const list = sentences?.sentence_list;
  if (!Array.isArray(list)) return state;
  const next = new Map(state.sentences);
  for (const candidate of list) {
    const sentence = asRecord(candidate);
    if (!sentence || typeof sentence.sentence_id !== 'number' || typeof sentence.sentence !== 'string') continue;
    next.set(sentence.sentence_id, sentence.sentence);
  }
  return { sentences: next };
}

export function tencentTextOf(state: TencentTranscriptState): string {
  return [...state.sentences.keys()].sort((a, b) => a - b).map((id) => state.sentences.get(id)).join('');
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
