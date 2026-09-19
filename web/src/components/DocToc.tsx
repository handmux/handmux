// Document outline drawer — opened from the toolbar's leading 目录 button, slides in from the LEFT.
//
// Rendered inside DocView's own tree (NOT OverlayPortal): the file sheet is a stacking context
// (`--z-overlay-workspace: 50`), so a plain fixed child with a small z-index paints above the sheet's
// content, while a portal to #overlay-root would sit below it — the same trap that would make a
// nested-layer portal invisible here.
import { t } from '../i18n';

export interface DocTocItem {
  id: string;
  level: number;
  text: string;
}

export interface DocTocProps {
  open: boolean;
  items: readonly DocTocItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

export default function DocToc({ open, items, onSelect, onClose }: DocTocProps) {
  if (!open) return null;
  return (
    <>
      <div className="doc-toc-backdrop" onClick={onClose} />
      <nav className="doc-toc" aria-label={t('doc.toc')}>
        <div className="doc-toc-head">
          <span className="doc-toc-title">{t('doc.toc')}</span>
          <button className="doc-toc-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        <div className="doc-toc-list">
          {items.map((item) => (
            <button key={item.id} className="doc-toc-item"
              style={{ paddingLeft: `${12 + (item.level - 1) * 14}px` }}
              onClick={() => { onSelect(item.id); onClose(); }}>
              {item.text}
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}
