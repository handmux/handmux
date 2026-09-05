export interface TencentTranscriptState {
  slices: Map<number, string>;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
);

export function emptyTencentTranscript(): TencentTranscriptState {
  return { slices: new Map() };
}

// ASR v2 repeatedly emits result.voice_text_str for the same result.index while slice_type is 0/1,
// then stabilizes it at slice_type=2. Replacing by index keeps partials without duplicating hypotheses.
export function accumulateTencent(
  state: TencentTranscriptState,
  message: unknown,
): TencentTranscriptState {
  const next = new Map(state.slices);
  const result = asRecord(asRecord(message)?.result);
  if (typeof result?.index === 'number' && typeof result.voice_text_str === 'string') {
    next.set(result.index, result.voice_text_str);
  }
  return { slices: next };
}

export function tencentTextOf(state: TencentTranscriptState): string {
  return [...state.slices.keys()].sort((a, b) => a - b).map((id) => state.slices.get(id)).join('');
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
