// Bundled-font loader with retry. The two terminal fonts are self-hosted and cached immutable, but
// a cold launch still fetches them over nginx + the tunnel — and when that flaky hop fails, the
// CSS @font-face enters `error` status and the browser will NEVER retry it for the page's lifetime
// (that's why "symbols missing until the app is restarted"). document.fonts.load() doesn't even
// reject on failure, so the caller can't tell. This module supersedes a failed CSS face with a
// fresh JS FontFace and retries with backoff; the returned promise settles once both fonts are
// genuinely usable (or we've given up), so the terminal can rebuild its glyph atlas at the right
// moment — including a LATE success that the one-shot CSS pipeline would have missed.
interface BundledFont {
  family: string;
  url: string;
  probe?: string;
  unicodeRange?: string;
}

const FONTS: BundledFont[] = [
  {
    family: 'JetBrainsMono Nerd Font',
    url: '/fonts/JetBrainsMonoNerdFontMono-Regular.woff2',
  },
  {
    family: 'TW Unifont',
    url: '/fonts/TWUnifont.woff2',
    probe: '⏵', // unicode-range font: won't download without an in-range char
    // MUST mirror the @font-face unicode-range in styles.css — a replacement face without it would
    // steal CJK/text glyphs from the system fonts (Unifont's pixel CJK looks blurry).
    unicodeRange: 'U+2190-21FF, U+2300-23FF, U+2400-243F, U+2500-257F, U+2580-259F, U+25A0-25FF, U+2600-26FF, U+2700-27BF, U+2800-28FF',
  },
];
const RETRIES = 4;
const BACKOFF_MS = 1500; // 1.5s, 3s, 6s, 12s

const faceOf = (family: string): FontFace | null => {
  for (const f of document.fonts) {
    if (f.family.replace(/["']/g, '') === family) return f;
  }
  return null;
};

const ensureOne = async (
  { family, url, probe, unicodeRange }: BundledFont,
  px: number,
): Promise<boolean> => {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try { await document.fonts.load(`${px}px "${family}"`, probe); } catch { /* resolves/rejects — either way we verify below */ }
    if (faceOf(family)?.status === 'loaded') return true;
    // The CSS face failed (status `error`) and is dead for this page — supersede it with a JS face.
    try {
      const face = new FontFace(family, `url(${url}) format('woff2')`, unicodeRange ? { unicodeRange } : {});
      await face.load();
      document.fonts.add(face);
      return true;
    } catch { /* network still down — back off and try again */ }
    await new Promise<void>((resolve) => setTimeout(resolve, BACKOFF_MS * 2 ** attempt));
  }
  return false;
};

let settled: Promise<boolean[]> | null = null;
// Resolves when both bundled fonts are usable (or all retries failed). Memoized: every Terminal
// mount awaits the same attempt; once settled, later mounts resolve instantly.
export function ensureBundledFonts(px = 14): Promise<boolean[]> {
  if (!settled) {
    settled = typeof document !== 'undefined' && 'fonts' in document
      ? Promise.all(FONTS.map((f) => ensureOne(f, px)))
      : Promise.resolve([false, false]);
  }
  return settled;
}
