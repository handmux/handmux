export interface ParsedSseFrames {
  frames: string[];
  rest: string;
}

export function parseSseFrames(buffer: unknown): ParsedSseFrames {
  const frames: string[] = [];
  let rest = String(buffer || '');
  while (true) {
    const boundary = /\r?\n\r?\n/.exec(rest);
    if (!boundary) break;
    const frame = rest.slice(0, boundary.index);
    rest = rest.slice(boundary.index + boundary[0].length);
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data) frames.push(data);
  }
  return { frames, rest };
}
