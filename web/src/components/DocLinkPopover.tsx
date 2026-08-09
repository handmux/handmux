import { useLayoutEffect, useRef, useState } from 'react';
import { FolderIcon } from './icons.jsx';
import { t } from '../i18n';
import type { ReactNode } from 'react';

const MARGIN = 8;   // keep this far from every viewport edge
const GAP = 12;     // vertical gap between the tap point and the card

// Anti-误触 confirm popover for a tapped terminal doc-path: instead of opening on a stray tap, we
// pop a small card near the tap previewing the file, so the user explicitly confirms「打开」. We get
// the raw tap {x,y} and clamp the card's OWN measured box fully inside the viewport — centering on x
// alone overflowed off the right edge (the buttons became unreachable). Below the tap by default;
// flips above when it would run off the bottom. Hidden until measured so it never flashes mispositioned.
//
// Also serves the terminal URL confirm via optional display overrides. Most async actions disable while
// pending; Browser opts into `allowRepeat` so a newer confirmation can cancel and replace the old request.
type LinkOpenMode = 'direct' | 'proxy';

interface DocLinkPopoverProps {
  path: string;
  x: number;
  y: number;
  onOpen: (path: string, mode?: LinkOpenMode) => void;
  onClose: () => void;
  icon?: ReactNode;
  name?: string;
  openLabel?: string;
  note?: string;
  disabled?: boolean;
  busy?: boolean;
  busyMode?: LinkOpenMode | null;
  allowRepeat?: boolean;
  modeChoices?: boolean;
  proxyAvailable?: boolean;
}

export default function DocLinkPopover({ path, x, y, onOpen, onClose, icon, name: nameProp, openLabel, note,
  disabled = false, busy = false, busyMode = null, allowRepeat = false, modeChoices = false,
  proxyAvailable = false }: DocLinkPopoverProps) {
  const name = nameProp ?? (path.split('/').filter(Boolean).pop() || path);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(Math.max(x - w / 2, MARGIN), vw - w - MARGIN);
    let top = y + GAP;
    if (top + h > vh - MARGIN) top = Math.max(MARGIN, y - GAP - h); // not enough room below → flip above
    setPos({ left, top });
  }, [x, y, path]);

  return (
    <>
      <div className="doclink-backdrop" onClick={onClose} />
      <div
        ref={ref}
        className="doclink-pop"
        style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
        role="dialog" aria-label={t('doclink.title')}
      >
        <div className="doclink-name">{icon ?? <FolderIcon />}{name}</div>
        <div className="doclink-path">{path}</div>
        {note && <div className="doclink-note">{note}</div>}
        {modeChoices && !proxyAvailable && <div className="doclink-note">{t('browser.proxyUnavailable')}</div>}
        <div className="doclink-actions">
          <button className="doclink-cancel" onClick={onClose}>{t('common.cancel')}</button>
          {!disabled && (modeChoices ? (
            <>
              <button className="doclink-open" disabled={busy && !allowRepeat}
                aria-busy={busy && busyMode === 'direct' ? 'true' : undefined}
                onClick={() => onOpen(path, 'direct')}>
                {t('browser.directMode')}{busy && busyMode === 'direct' ? ` · ${t('common.loading')}` : ''}
              </button>
              <button className="doclink-open proxy" disabled={!proxyAvailable || (busy && !allowRepeat)}
                aria-busy={busy && busyMode === 'proxy' ? 'true' : undefined}
                onClick={() => onOpen(path, 'proxy')}>
                {t('browser.proxyMode')}{busy && busyMode === 'proxy' ? ` · ${t('common.loading')}` : ''}
              </button>
            </>
          ) : (
            <button className="doclink-open" disabled={busy && !allowRepeat} onClick={() => onOpen(path)}>{busy ? t('common.loading') : (openLabel ?? t('common.open'))}</button>
          ))}
        </div>
      </div>
    </>
  );
}
