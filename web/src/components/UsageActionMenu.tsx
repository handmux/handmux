import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { OverlayPortal } from '../overlays/OverlayHost.js';

export interface UsageActionMenuAction {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  confirmLabel?: ReactNode;
  restoreFocusOnSelect?: boolean;
  onClick: () => void;
}

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;

// This combines the mature Dropdown dismissal behavior with WindowBar's portalled,
// viewport-clamped placement. Rich action rows stay a compact iOS-style Menu instead
// of turning a small overflow control into a full ActionSheet.
export default function UsageActionMenu({ anchor, label, actions, onClose }: {
  anchor: HTMLElement;
  label: string;
  actions: readonly UsageActionMenuAction[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const focusedRef = useRef(false);
  const restoreFocusRef = useRef(true);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(
    () => actions.find((action) => !action.disabled)?.key ?? null,
  );

  const place = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return;
    if (!anchor.isConnected) { onClose(); return; }
    const rect = anchor.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight
      || rect.right < 0 || rect.left > window.innerWidth) {
      onClose();
      return;
    }
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.right - width, maxLeft));
    let top = rect.bottom + ANCHOR_GAP;
    if (top + height > window.innerHeight - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, rect.top - ANCHOR_GAP - height);
    }
    setPosition({ left, top });
  }, [anchor, onClose]);

  useLayoutEffect(() => { place(); }, [place, armed, actions.length]);
  useEffect(() => {
    const reflow = () => place();
    window.addEventListener('scroll', reflow, true);
    window.addEventListener('resize', reflow);
    return () => {
      window.removeEventListener('scroll', reflow, true);
      window.removeEventListener('resize', reflow);
    };
  }, [place]);
  useEffect(() => {
    if (!position || focusedRef.current) return;
    focusedRef.current = true;
    menuRef.current?.querySelector<HTMLButtonElement>('.usage-popover-item[tabindex="0"]:not(:disabled)')?.focus();
  }, [position]);
  useEffect(() => () => {
    if (restoreFocusRef.current && anchor.isConnected) anchor.focus({ preventScroll: true });
  }, [anchor]);

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      onClose();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
      '.usage-popover-item:not(:disabled)',
    ) ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length
        : (current - 1 + items.length) % items.length;
    setFocusKey(items[next]?.dataset.menuKey ?? null);
    items[next]?.focus();
  };

  const choose = (action: UsageActionMenuAction) => {
    if (action.disabled) return;
    if (action.confirmLabel && armed !== action.key) {
      setArmed(action.key);
      return;
    }
    restoreFocusRef.current = action.restoreFocusOnSelect !== false;
    onClose();
    action.onClick();
  };

  return <OverlayPortal className="usage-menu-overlay">
    <div className="usage-menu-backdrop" onPointerDown={onClose} />
    <div ref={menuRef} className="usage-action-popover" role="menu" aria-label={label} onKeyDown={moveFocus}
      style={position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: 'hidden' }}>
      {actions.map((action, index) => <div role="none" key={action.key}>
        {action.danger && index > 0 && <div className="usage-popover-separator" aria-hidden="true" />}
        <button type="button" role="menuitem"
          data-menu-key={action.key} tabIndex={focusKey === action.key ? 0 : -1}
          className={`usage-popover-item sheet-action${action.danger ? ' danger' : ''}${armed === action.key ? ' armed' : ''}`}
          disabled={action.disabled} onFocus={() => setFocusKey(action.key)} onClick={() => choose(action)}>
          {action.icon && armed !== action.key
            && <span className="usage-popover-icon" aria-hidden="true">{action.icon}</span>}
          <span>{armed === action.key ? action.confirmLabel : action.label}</span>
        </button>
      </div>)}
    </div>
  </OverlayPortal>;
}
