// Extension allow-list for uploads. By extension only (not magic bytes) — this is a "be tidy"
// guard, not a trust boundary (a token holder can write anything from the terminal anyway; see spec
// threat model). Override the whole set with HANDMUX_UPLOAD_EXTS (comma-separated).
export const DEFAULT_UPLOAD_EXTS = new Set([
  // images
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif', 'avif', 'ico', 'tiff',
  // video
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', '3gp', 'ogv', 'mpeg', 'mpg',
  // text / code
  'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'ini',
  'conf', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go',
  'rs', 'java', 'c', 'h', 'cpp', 'sh',
  // documents / office
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
]);

// Read HANDMUX_UPLOAD_EXTS (comma-separated) → a Set, normalising leading dots/case/whitespace.
// Blank/absent → the default set (returned by reference so callers can `=== DEFAULT_UPLOAD_EXTS`).
export function loadUploadExts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.HANDMUX_UPLOAD_EXTS;
  if (!raw || !raw.trim()) return DEFAULT_UPLOAD_EXTS;
  const exts = raw.split(',').map((s) => s.trim().replace(/^\.+/, '').toLowerCase()).filter(Boolean);
  return new Set(exts);
}

// True if `name`'s final extension is in `exts`. No extension → false.
export function isAllowedUploadExt(
  name: string | null | undefined,
  exts: ReadonlySet<string>,
): boolean {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m?.[1] ? exts.has(m[1].toLowerCase()) : false;
}
