// Pure selection helpers for the terminal copy UX. No DOM — unit-tested; see terminalSeed.js for the
// same "extract the pure bits" pattern.

// Trim each line's leading + trailing whitespace (row padding AND indentation — the user wants copied
// text directly usable), then drop leading/trailing blank lines. Interior blank lines are kept.
export function trimCopy(text) {
  const lines = text.split('\n').map((l) => l.trim());
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a] === '') a++;
  while (b > a && lines[b - 1] === '') b--;
  return lines.slice(a, b).join('\n');
}
