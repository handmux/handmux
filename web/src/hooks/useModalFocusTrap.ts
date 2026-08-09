import { useEffect, type RefObject } from 'react';
import { useEscapeLayer } from './useEscapeLayer.js';

const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface ModalFocusTrapOptions {
  active: boolean;
  dialogRef: RefObject<HTMLElement>;
  initialFocusRef: RefObject<HTMLElement>;
  returnFocusRef: RefObject<HTMLElement>;
  onClose: () => void;
}

export function useModalFocusTrap({
  active,
  dialogRef,
  initialFocusRef,
  returnFocusRef,
  onClose,
}: ModalFocusTrapOptions): void {
  // Escape participates in the same explicit ordering as every other Overlay. The focus trap only owns
  // Tab containment and focus restoration; it no longer installs a competing close listener.
  useEscapeLayer(active, onClose);

  useEffect(() => {
    if (!active) return undefined;
    const returnTarget = returnFocusRef.current;
    const frame = requestAnimationFrame(() => initialFocusRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      const focusable = [...(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (!focusable.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (!dialog?.contains(current) || current === first)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (!dialog?.contains(current) || current === last)) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
      returnTarget?.focus();
    };
  }, [active, dialogRef, initialFocusRef, returnFocusRef]);
}
