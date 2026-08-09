// Rich-rendered doc types by extension. Every other filename can still open as plain text after the
// docs layer validates its bytes; this map only selects Markdown/HTML/plain presentation.
export const EXT = {
  '.md': 'markdown', '.markdown': 'markdown', '.html': 'html', '.htm': 'html',
  // Plain-text files: rendered verbatim in a <pre> (no markdown parsing).
  '.txt': 'text', '.log': 'text', '.sh': 'text',
};

// Map a filename to our renderable doc type by extension, or null. Case-insensitive.
export function docTypeFor(name) {
  const m = /\.[A-Za-z0-9]+$/.exec(name || '');
  return m ? (EXT[m[0].toLowerCase()] ?? null) : null;
}

// Image extensions the in-app viewer can show inline via <img> (GIF animates natively). SVG is safe
// here because <img>-loaded SVG never runs its scripts. Returns 'image' or null. Case-insensitive.
export const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'apng']);
export function imageTypeFor(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m && IMG_EXT.has(m[1].toLowerCase()) ? 'image' : null;
}

// True if `child` equals `parent` or sits inside it. Both are expected to be realpaths.
// Guards the sibling-prefix trap: /home/ab is NOT under /home/a.
export function isUnder(child, parent) {
  if (child === parent) return true;
  const p = parent.endsWith('/') ? parent : parent + '/';
  return child.startsWith(p);
}

// Sanitize a client-supplied upload filename to a single safe path segment, or null if unsafe.
// Takes the basename (drops any dir part, handling both / and \), then rejects empty / '.' / '..'
// and dotfiles (no hidden files). The result never contains a path separator.
export function safeUploadName(raw) {
  if (typeof raw !== 'string') return null;
  const base = raw.split('/').pop().split('\\').pop();
  if (!base || base === '.' || base === '..' || base[0] === '.') return null;
  return base;
}

// True if `real` (a realpath at/under `home`) has any path segment BELOW home that starts with '.'
// — i.e. it lives inside a hidden directory like ~/.ssh or ~/.config. `home` is the realpath of
// $HOME. The home root itself is not hidden.
export function hasHiddenSegment(real, home) {
  if (real === home) return false;
  const rel = real.startsWith(home.endsWith('/') ? home : home + '/') ? real.slice(home.length) : real;
  return rel.split('/').filter(Boolean).some((seg) => seg.startsWith('.'));
}
