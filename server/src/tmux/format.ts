const Q_ESCAPED = new Set([
  '|', '&', ';', '<', '>', '(', ')', '{', '}', '$', '`', '\\', '"', "'", '*', '?', '[', '#', ' ', '=', '%', '\n', '\t',
]);

type FixedTuple<T, N extends number, Acc extends T[] = []> = number extends N
  ? T[]
  : Acc['length'] extends N
    ? Acc
    : FixedTuple<T, N, [...Acc, T]>;

export function tmuxFormat(fields: unknown): string {
  if (!Array.isArray(fields) || fields.length === 0) throw new Error('tmux format fields are required');
  return fields.map((field) => {
    if (typeof field !== 'string' || !/^@?[A-Za-z0-9_]+$/.test(field)) {
      throw new Error(`invalid tmux format field: ${String(field)}`);
    }
    return `#{q:${field}}`;
  }).join('|');
}

export function parseTmuxFields<const N extends number>(
  line: unknown,
  columns: N,
  label = 'tmux',
): FixedTuple<string, N> {
  const value = String(line);
  const fields: string[] = [];
  let field = '';
  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i);
    if (char === '|') {
      fields.push(field);
      field = '';
      continue;
    }
    if (char !== '\\') {
      field += char;
      continue;
    }
    if (i + 1 >= value.length) throw new Error(`invalid ${label} format: dangling escape`);
    const escaped = value.charAt(++i);
    if (!Q_ESCAPED.has(escaped)) throw new Error(`invalid ${label} format: unsupported escape`);
    field += escaped;
  }
  fields.push(field);
  if (fields.length !== columns) throw new Error(`invalid ${label} format: expected ${columns} fields`);
  return fields as FixedTuple<string, N>;
}

export function parseTmuxRows<const N extends number>(
  output: unknown,
  columns: N,
  label = 'tmux',
): Array<FixedTuple<string, N>> {
  const value = String(output ?? '');
  if (value === '' || value === '\n' || value === '\r\n') return [];
  const rows: Array<FixedTuple<string, N>> = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    // tmux 3.8 q-escapes literal LF. Skip complete escape pairs so that
    // an escaped backslash before LF still leaves a record boundary.
    if (value.charAt(i) === '\\') { i++; continue; }
    if (value.charAt(i) !== '\n') continue;
    const end = value.charAt(i - 1) === '\r' ? i - 1 : i;
    rows.push(parseTmuxFields(value.slice(start, end), columns, label));
    start = i + 1;
  }
  if (start < value.length) rows.push(parseTmuxFields(value.slice(start), columns, label));
  return rows;
}
