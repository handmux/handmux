// How a log line's optional second value is rendered. It is typed as `error`, but connectors also pass a
// bag of STRUCTURED DETAILS there ("which event id, which pane"), and rendering those with String() printed
// `[object Object]` — an operator could not tell which event had been dropped, which is the whole reason the
// line exists. Reported from the field as exactly that: a wall of
// `Discarding stale Claude Hook event after pane process replacement: [object Object]`.
//
// An Error keeps its message; anything else object-shaped is rendered as bounded JSON so the detail stays
// readable and a pathological value cannot flood the log. Primitives keep their plain form.
const MAX_DETAIL = 500;

export function logDetail(value: unknown): string {
  if (value === undefined) return '';
  if (value instanceof Error) return `: ${value.message}`;
  if (typeof value === 'object' && value !== null) {
    try {
      const json = JSON.stringify(value);
      if (typeof json !== 'string') return '';
      return `: ${json.length > MAX_DETAIL ? `${json.slice(0, MAX_DETAIL)}…` : json}`;
    } catch {
      return ''; // circular or otherwise unserializable: log the message alone rather than nothing useful
    }
  }
  return `: ${String(value)}`;
}
