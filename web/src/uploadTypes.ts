// Client-side mirror of the server's upload extension allow-list (server/src/uploadTypes.js is the
// real enforcement — this is only UX: it feeds the <input accept> hint and pre-filters the picked
// files so a disallowed pick (e.g. an executable) gets an instant note instead of a mid-upload 415).
// Kept in sync with DEFAULT_UPLOAD_EXTS by hand; a HANDMUX_UPLOAD_EXTS override only affects the
// server, so the client stays lenient and lets the server have the final say.
export const UPLOAD_EXTS: readonly string[] = [
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
  // archives
  'zip',
];

// The `accept` attribute: dot-extensions ONLY, deliberately no `image/*` (or `video/*`) wildcard.
// A media wildcard makes the OS open its camera/gallery capture chooser first (Android: 拍照/录像/
// 图片/视频; iOS: the Photo Library sheet) and buries "choose file". Specific extensions — including
// image ones like .jpg/.png — go straight to the file/document browser instead, where a screenshot
// (a file in DCIM/Screenshots) is still selectable, so we keep image support without the media sheet.
export const UPLOAD_ACCEPT = UPLOAD_EXTS.map((e) => `.${e}`).join(',');

const EXT_SET: ReadonlySet<string> = new Set(UPLOAD_EXTS);

// True if `name`'s final extension is allowed. No extension → false (executables usually have none).
export function isAllowedUploadName(name: string): boolean {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m?.[1] ? EXT_SET.has(m[1].toLowerCase()) : false;
}

// Split a File list into { allowed, rejected } (rejected = array of names) by extension. Accepts an
// array, a FileList (array-like), or a single File — a lone File isn't iterable, so wrap it, don't
// Array.from it (that would yield []).
export interface UploadFileLike { name: string }

export function splitUploadable<T extends UploadFileLike>(
  files: T | readonly T[] | ArrayLike<T> | null | undefined,
): { allowed: T[]; rejected: string[] } {
  const arr = Array.isArray(files)
    ? files
    : files && 'length' in files && typeof files.length === 'number'
      ? Array.from(files)
      : files ? [files] : [];
  const allowed: T[] = [];
  const rejected: T[] = [];
  for (const file of arr as readonly T[]) {
    (isAllowedUploadName(file.name) ? allowed : rejected).push(file);
  }
  return { allowed, rejected: rejected.map((file) => file.name) };
}
