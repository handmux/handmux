const CSI = /\x1b\[([0-9;]*)m/g;
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

function backgroundAfter(line: string, initial: boolean): boolean {
  let background = initial;
  const sgr = new RegExp(CSI.source, 'g');
  let match = sgr.exec(line);
  while (match) {
    const params = match[1] === '' ? [0] : match[1].split(';').map(Number);
    for (let i = 0; i < params.length; i += 1) {
      const value = params[i] ?? 0;
      if (value === 0 || value === 49) background = false;
      else if ((value >= 40 && value <= 47) || (value >= 100 && value <= 107)) background = true;
      else if (value === 38 || value === 48) {
        const isBackground = value === 48;
        if (params[i + 1] === 5) {
          i += 2;
          if (isBackground) background = true;
        } else if (params[i + 1] === 2) {
          i += 4;
          if (isBackground) background = true;
        }
      }
    }
    match = sgr.exec(line);
  }
  return background;
}

function paintsBackground(line: string): boolean {
  let background = false;
  let offset = 0;
  const sgr = new RegExp(CSI.source, 'g');
  let match = sgr.exec(line);
  while (match) {
    if (background && match.index > offset) return true;
    background = backgroundAfter(match[0], background);
    offset = sgr.lastIndex;
    match = sgr.exec(line);
  }
  return background && offset < line.length;
}

const isBlank = (line: string): boolean => line.replace(ANSI, '').trim() === '';

// `capture-pane -e -N` compresses SGR state across newlines. A default blank row after a shaded
// row (Claude) and a genuinely shaded padding row (Codex) therefore look identical in the combined
// capture. Capturing just that row makes tmux emit the row's real starting attributes. Only those
// ambiguous rows need the extra read; ordinary rows keep the single fast combined capture.
export function ambiguousBackgroundRows(lines: readonly string[]): number[] {
  const indexes: number[] = [];
  let background = false;
  let inBlankRun = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const ambiguous = background && isBlank(line);
    // One row resolves the whole trailing run: default closes it before the first LF; shaded is the
    // one real padding row the client preserves and seals before clearing any additional blanks.
    if (ambiguous && !inBlankRun) indexes.push(index);
    inBlankRun = ambiguous;
    background = backgroundAfter(line, background);
  }
  return indexes;
}

export async function restoreBlankRowBackgrounds(
  lines: readonly string[],
  historyLines: number,
  readRow: (row: number) => Promise<string>,
): Promise<string[]> {
  const restored = [...lines];
  const indexes = ambiguousBackgroundRows(lines);
  await Promise.all(indexes.map(async (index) => {
    const row = index - historyLines;
    const exact = await readRow(row);
    // A separately-captured default row has no background SGR. Explicitly close the combined
    // stream's inherited background before replaying it. A real padding row starts with its own
    // background SGR and is preserved verbatim.
    restored[index] = paintsBackground(exact) ? exact : `\x1b[49m${exact}`;
  }));
  return restored;
}

export interface RestoredCapture {
  ansi: string;
  historyLines: number;
}

export async function restoreCaptureBackgrounds(
  capture: string,
  paneHeight: number,
  readRow: (row: number) => Promise<string>,
): Promise<RestoredCapture> {
  const trailingNewline = capture.endsWith('\n');
  const body = trailingNewline ? capture.slice(0, -1) : capture;
  const lines = body.split('\n');
  const historyLines = Math.max(0, lines.length - paneHeight);
  const restored = await restoreBlankRowBackgrounds(lines, historyLines, async (row) => {
    const exact = await readRow(row);
    return exact.endsWith('\n') ? exact.slice(0, -1) : exact;
  });
  return {
    ansi: restored.join('\n') + (trailingNewline ? '\n' : ''),
    historyLines,
  };
}
