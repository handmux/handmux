// Document outline drawer — opened from the toolbar's leading 目录 button, slides in from the LEFT.
//
// Rendered inside DocView's own tree (NOT OverlayPortal): the file sheet is a stacking context
// (`--z-overlay-workspace: 50`), so a plain fixed child with a small z-index paints above the sheet's
// content, while a portal to #overlay-root would sit below it — the same trap that would make a
// nested-layer portal invisible here.
import { useEffect, useState } from 'react';
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
  // Sections with sub-headings can be folded away, so a long outline stays navigable. A fresh document
  // starts fully expanded.
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);
  useEffect(() => { setCollapsed([]); }, [items]);

  if (!open) return null;

  const hasChildren = (index: number): boolean => {
    const level = items[index]?.level ?? 0;
    return (items[index + 1]?.level ?? 0) > level;
  };
  // Hidden when ANY heading in its ancestor chain is collapsed — walking the whole chain, not just the
  // nearest parent: folding an h1 must take the h3 under its h2 with it.
  const visible = (index: number): boolean => {
    let level = items[index]?.level ?? 0;
    for (let j = index - 1; j >= 0; j -= 1) {
      const parent = items[j];
      if (!parent || parent.level >= level) continue; // not an ancestor, keep looking
      if (collapsed.includes(parent.id)) return false;
      level = parent.level; // climb one level up the chain and keep checking
    }
    return true;
  };

  return (
    <>
      <div className="doc-toc-backdrop" onClick={onClose} />
      <nav className="doc-toc" aria-label={t('doc.toc')}>
        <div className="doc-toc-head">
          <span className="doc-toc-title">{t('doc.toc')}</span>
          <button className="doc-toc-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        <div className="doc-toc-list">
          {items.map((item, index) => {
            if (!visible(index)) return null;
            const foldable = hasChildren(index);
            const folded = collapsed.includes(item.id);
            return (
              <div key={item.id} className="doc-toc-row"
                style={{ paddingLeft: `${6 + (item.level - 1) * 14}px` }}>
                {foldable ? (
                  <button className="doc-toc-fold" aria-expanded={!folded}
                    aria-label={folded ? t('doc.tocExpand') : t('doc.tocCollapse')}
                    onClick={() => setCollapsed((current) => (
                      current.includes(item.id)
                        ? current.filter((id) => id !== item.id)
                        : [...current, item.id]
                    ))}>
                    {folded ? '▸' : '▾'}
                  </button>
                ) : <span className="doc-toc-fold is-empty" aria-hidden="true" />}
                <button className="doc-toc-item"
                  onClick={() => { onSelect(item.id); onClose(); }}>
                  {item.text}
                </button>
              </div>
            );
          })}
        </div>
      </nav>
    </>
  );
}
