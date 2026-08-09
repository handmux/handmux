import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { mimeFromName } from '../mime.js';
import ActionSheet from './ActionSheet.jsx';
import { t } from '../i18n';
import { useBackButton } from '../hooks/useBackButton.js';

const MAX = 6;            // max zoom multiplier over fit-to-width
const LONG_PRESS_MS = 500; // hold this long (single finger, no drag) → save
const MOVE_TOL = 10;       // px of movement that cancels a long-press / counts as a drag
const DBL_TAP_MS = 300;    // two taps within this → double-tap (toggle 2× / 复位)

interface Point { x: number; y: number }
interface ImageView extends Point { s: number }
interface PinchState { dist: number; s: number }
interface GestureFlags { moved: boolean; lpFired: boolean; pinched: boolean }

export interface ImageViewerProps {
  url?: string | null;
  name: string;
}

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

// Inline image viewer with touch gestures. The app's viewport disables native pinch (it's tuned for
// the terminal), so we implement our own: two-finger pinch zooms, one-finger drag pans when zoomed,
// double-tap toggles 2×/复位, and the +/− pill is a no-touch fallback. Long-press (single still finger)
// hands the image to the OS share/save sheet (navigator.share) — the web can't write the photo album
// directly, so "保存到相册" goes through that sheet; unsupported browsers fall back to a download.
//
// `url` is the already-fetched object-URL (revoked by the tab on close, never here). Transform is
// applied to the <img> (layout-size untouched), so offsetWidth/Height give the fitted size for pan
// clamping. GIF animates on its own; SVG via <img> can't run scripts.
export default function ImageViewer({ url, name }: ImageViewerProps) {
  const [view, setView] = useState<ImageView>({ s: 1, x: 0, y: 0 }); // scale + pan (px)
  const [note, setNote] = useState('');     // brief save feedback (a download is otherwise silent)
  const [menuOpen, setMenuOpen] = useState(false); // long-press → 保存图片 / 分享图片 sheet
  const viewRef = useRef(view); viewRef.current = view;
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const pointers = useRef<Map<number, Point>>(new Map()); // pointerId → {x,y}
  const pinch = useRef<PinchState | null>(null); // distance + scale at gesture start
  const pan = useRef<Point | null>(null); // last single-pointer point
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flags = useRef<GestureFlags>({ moved: false, lpFired: false, pinched: false });
  const lastTap = useRef(0);
  useBackButton(menuOpen, () => setMenuOpen(false));
  useEffect(() => () => {
    if (noteTimer.current !== null) clearTimeout(noteTimer.current);
    if (lpTimer.current !== null) clearTimeout(lpTimer.current);
  }, []);

  if (!url) return <div className="doc-image-msg">{t('imageviewer.loadFailed')}</div>;

  // Clamp pan so the (scaled) image can't be dragged off the viewport. offsetW/H are the FITTED size
  // (transform doesn't affect layout), so overflow = fitted*scale − container, split each side.
  const clampPan = (scale: number, x: number, y: number): Point => {
    const wrap = wrapRef.current; const img = imgRef.current;
    if (!wrap || !img) return { x, y };
    const ox = Math.max(0, (img.offsetWidth * scale - wrap.clientWidth) / 2);
    const oy = Math.max(0, (img.offsetHeight * scale - wrap.clientHeight) / 2);
    return { x: Math.min(ox, Math.max(-ox, x)), y: Math.min(oy, Math.max(-oy, y)) };
  };
  const apply = (requestedScale: number, x: number, y: number): void => {
    const scale = Math.min(MAX, Math.max(1, requestedScale));
    if (scale <= 1) { setView({ s: 1, x: 0, y: 0 }); return; } // back to fit → recenter
    const point = clampPan(scale, x, y);
    setView({ s: scale, x: point.x, y: point.y });
  };
  const zoomBy = (factor: number): void => apply(viewRef.current.s * factor, viewRef.current.x, viewRef.current.y);

  const cancelLongPress = (): void => {
    if (lpTimer.current !== null) { clearTimeout(lpTimer.current); lpTimer.current = null; }
  };

  const flash = (msg: string): void => {
    setNote(msg);
    if (noteTimer.current !== null) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 2500);
  };

  // Long-press opens a 保存图片 / 分享图片 menu (the user picks). 保存 = download → lands in the
  // gallery on Android / the Files/Downloads on others (the web can't write the photo album directly).
  // 分享 = the OS share sheet (on iOS that's where "存储图像" lives).
  const download = (): void => {
    setMenuOpen(false);
    const a = document.createElement('a');
    a.href = url; a.download = name || 'image';
    document.body.appendChild(a); a.click(); a.remove();
    flash(t('imageviewer.saved'));
  };
  const share = async (): Promise<void> => {
    setMenuOpen(false);
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], name || 'image', { type: mimeFromName(name) || blob.type || 'application/octet-stream' });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
    } catch { return; } // user canceled, or fetch/share failed → say nothing
    flash(t('imageviewer.shareUnsupported'));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const n = pointers.current.size;
    if (n === 2) {
      // second finger → start pinch, abort any pending long-press / tap
      cancelLongPress();
      flags.current.pinched = true;
      const [a, b] = [...pointers.current.values()];
      if (a && b) pinch.current = { dist: dist(a, b) || 1, s: viewRef.current.s };
    } else if (n === 1) {
      flags.current.moved = false; flags.current.lpFired = false; flags.current.pinched = false;
      pan.current = { x: event.clientX, y: event.clientY };
      cancelLongPress();
      lpTimer.current = setTimeout(() => {
        lpTimer.current = null;
        if (pointers.current.size === 1 && !flags.current.moved) { flags.current.lpFired = true; setMenuOpen(true); }
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) apply(pinch.current.s * (dist(a, b) / pinch.current.dist), viewRef.current.x, viewRef.current.y);
      return;
    }
    if (pan.current) {
      const dx = event.clientX - pan.current.x; const dy = event.clientY - pan.current.y;
      if (Math.abs(dx) > MOVE_TOL || Math.abs(dy) > MOVE_TOL) { flags.current.moved = true; cancelLongPress(); }
      if (viewRef.current.s > 1) {
        pan.current = { x: event.clientX, y: event.clientY };
        apply(viewRef.current.s, viewRef.current.x + dx, viewRef.current.y + dy);
      }
    }
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    cancelLongPress();
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 1) {
      // pinch ended with one finger still down → resume panning from its position, no jump
      pinch.current = null;
      const [p] = [...pointers.current.values()];
      pan.current = p ? { x: p.x, y: p.y } : null;
    } else if (pointers.current.size === 0) {
      const clean = !flags.current.moved && !flags.current.lpFired && !flags.current.pinched;
      if (clean) {
        const timestamp = event.timeStamp || 0;
        if (timestamp - lastTap.current < DBL_TAP_MS) {
          lastTap.current = 0;
          viewRef.current.s > 1 ? apply(1, 0, 0) : apply(2, 0, 0); // double-tap: 复位 ↔ 2×
        } else {
          lastTap.current = timestamp;
        }
      }
      pinch.current = null; pan.current = null;
      flags.current = { moved: false, lpFired: false, pinched: false };
    }
  };

  return (
    <div
      ref={wrapRef}
      className="doc-image-wrap"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onContextMenu={(e) => e.preventDefault()} // our long-press owns the gesture, not the OS callout
    >
      <img
        ref={imgRef}
        className="doc-image"
        src={url}
        alt={name}
        draggable={false}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
      />
      <div className="doc-image-zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button onClick={() => zoomBy(1 / 1.5)} disabled={view.s <= 1} aria-label={t('imageviewer.zoomOut')}>−</button>
        <span className="doc-image-zoom-val" aria-hidden="true">{Math.round(view.s * 100)}%</span>
        <button onClick={() => zoomBy(1.5)} disabled={view.s >= MAX} aria-label={t('imageviewer.zoomIn')}>＋</button>
      </div>
      {note && <div className="doc-image-note" role="status">{note}</div>}
      <ActionSheet
        open={menuOpen}
        title={name || t('imageviewer.imageTitle')}
        actions={[
          { key: 'save', label: t('imageviewer.saveImage'), onClick: download },
          { key: 'share', label: t('imageviewer.shareImage'), onClick: share },
        ]}
        onClose={() => setMenuOpen(false)}
      />
    </div>
  );
}
