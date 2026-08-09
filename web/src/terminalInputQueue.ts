export type TerminalInputData = string | Uint8Array | ArrayBuffer | ArrayLike<number>;

export interface TerminalInputQueueOptions {
  send(pane: string, hex: string): Promise<unknown>;
  onDelivered?(pane: string): void;
  onError?(error: unknown, pane: string): void;
  encoder?: Pick<TextEncoder, 'encode'>;
}

export interface TerminalInputQueue {
  enqueue(pane: string | null | undefined, data: TerminalInputData | null | undefined): void;
  drop(pane: string): void;
  dispose(): void;
}

interface QueuedInput {
  pane: string;
  hex: string;
}

const toHex = (bytes: Uint8Array): string => (
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
);

const MAX_BATCH_HEX_LENGTH = 16384 * 2;

function inputBytes(data: TerminalInputData, encoder: Pick<TextEncoder, 'encode'>): Uint8Array {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Uint8Array.from(data);
}

function callSafely<Args extends unknown[]>(callback: (...args: Args) => void, ...args: Args): void {
  try {
    callback(...args);
  } catch {
    // Notification callbacks must not alter delivery or queue state.
  }
}

export function createTerminalInputQueue({
  send,
  onDelivered = () => {},
  onError = () => {},
  encoder = new TextEncoder(),
}: TerminalInputQueueOptions): TerminalInputQueue {
  let staged: QueuedInput[] = [];
  let batches: QueuedInput[] = [];
  let scheduled = false;
  let running = false;
  let disposed = false;

  const pump = async (): Promise<void> => {
    if (running || disposed || batches.length === 0) return;
    running = true;
    try {
      while (!disposed && batches.length) {
        const batch = batches.shift();
        if (!batch) continue;
        try {
          await send(batch.pane, batch.hex);
        } catch (error) {
          batches = batches.filter((item) => item.pane !== batch.pane);
          staged = staged.filter((item) => item.pane !== batch.pane);
          callSafely(onError, error, batch.pane);
          continue;
        }
        callSafely(onDelivered, batch.pane);
      }
    } finally {
      running = false;
    }
  };

  const flush = (): void => {
    scheduled = false;
    const items = staged;
    staged = [];
    for (const item of items) {
      let hex = item.hex;
      while (hex) {
        const last = batches.at(-1);
        if (last?.pane === item.pane && last.hex.length < MAX_BATCH_HEX_LENGTH) {
          const available = MAX_BATCH_HEX_LENGTH - last.hex.length;
          last.hex += hex.slice(0, available);
          hex = hex.slice(available);
        } else {
          batches.push({ pane: item.pane, hex: hex.slice(0, MAX_BATCH_HEX_LENGTH) });
          hex = hex.slice(MAX_BATCH_HEX_LENGTH);
        }
      }
    }
    void pump();
  };

  return {
    enqueue(pane, data) {
      if (disposed || !pane || !data) return;
      staged.push({ pane, hex: toHex(inputBytes(data, encoder)) });
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    },
    drop(pane) {
      staged = staged.filter((item) => item.pane !== pane);
      batches = batches.filter((item) => item.pane !== pane);
    },
    dispose() {
      disposed = true;
      staged = [];
      batches = [];
    },
  };
}
