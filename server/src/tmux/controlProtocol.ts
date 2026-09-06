export function decodeControlData(data: Buffer): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < data.length;) {
    const current = data[i];
    if (current === 0x5c && data[i + 1] === 0x5c) {
      bytes.push(0x5c);
      i += 2;
      continue;
    }
    if (current === 0x5c && i + 3 < data.length) {
      const a = data[i + 1];
      const b = data[i + 2];
      const c = data[i + 3];
      if (a !== undefined && b !== undefined && c !== undefined
        && a >= 0x30 && a <= 0x37 && b >= 0x30 && b <= 0x37 && c >= 0x30 && c <= 0x37) {
        bytes.push(((a - 0x30) << 6) | ((b - 0x30) << 3) | (c - 0x30));
        i += 4;
        continue;
      }
    }
    if (current !== undefined) bytes.push(current);
    i += 1;
  }
  return Buffer.from(bytes);
}
