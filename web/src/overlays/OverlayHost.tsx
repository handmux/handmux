import {
  createContext,
  useContext,
  useMemo,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

interface OverlayEnvironment {
  host: HTMLElement | null;
  keyboardInset: number;
  chatTone: string;
}

interface OverlayProviderProps {
  children: ReactNode;
  keyboardInset?: number;
  chatTone?: string;
  host?: HTMLElement | null;
}

interface OverlayPortalProps {
  children: ReactNode;
  keyboardInset?: number;
  chatTone?: string;
  className?: string;
}

const defaultEnvironment: OverlayEnvironment = {
  host: null,
  keyboardInset: 0,
  chatTone: 'dusk',
};

const OverlayContext = createContext<OverlayEnvironment>(defaultEnvironment);

function normalizedInset(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function OverlayProvider({
  children,
  keyboardInset = 0,
  chatTone = 'dusk',
  host,
}: OverlayProviderProps) {
  const resolvedHost = host === undefined && typeof document !== 'undefined'
    ? document.getElementById('overlay-root')
    : (host ?? null);
  const environment = useMemo<OverlayEnvironment>(() => ({
    host: resolvedHost,
    keyboardInset: normalizedInset(keyboardInset),
    chatTone,
  }), [resolvedHost, keyboardInset, chatTone]);
  return <OverlayContext.Provider value={environment}>{children}</OverlayContext.Provider>;
}

export function OverlayPortal({
  children,
  keyboardInset,
  chatTone,
  className = '',
}: OverlayPortalProps) {
  const environment = useContext(OverlayContext);
  const target = environment.host
    ?? (typeof document !== 'undefined' ? document.body : null);
  if (!target) return null;
  const inset = normalizedInset(keyboardInset ?? environment.keyboardInset);
  const style = { '--overlay-keyboard-inset': `${inset}px` } as CSSProperties;
  const classes = `overlay-layer chat-tone-surface${className ? ` ${className}` : ''}`;
  return createPortal(
    <div className={classes} data-chat-tone={chatTone ?? environment.chatTone} style={style}>
      {children}
    </div>,
    target,
  );
}
