// Map a filename to a MIME type by extension. Used to RE-TAG a downloaded blob: some files come back
// from the server as application/octet-stream (or untyped) — e.g. HEIC photos, extensionless files,
// uncommon types mime.lookup misses. Android records THAT type for the download, so tapping "Open"
// finds no handler and shows raw bytes. Re-tagging from the extension makes a downloaded image open
// in the gallery. Returns '' for an unknown/absent extension (caller keeps the server's own type).
const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
  pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', md: 'text/markdown',
  markdown: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml',
  html: 'text/html', htm: 'text/html', zip: 'application/zip',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv',
  '3gp': 'video/3gpp', ogv: 'video/ogg', mpeg: 'video/mpeg', mpg: 'video/mpeg',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function mimeFromName(name: string | null | undefined): string {
  const safeName = name || '';
  const i = safeName.lastIndexOf('.');
  if (i < 0) return '';
  return MIME[safeName.slice(i + 1).toLowerCase()] || '';
}

// True if the filename's extension is an image we show inline (its MIME starts with image/). Drives
// routing a tapped path to the image viewer instead of the markdown/html doc reader.
export function isImageName(name: string | null | undefined): boolean {
  return mimeFromName(name).startsWith('image/');
}
