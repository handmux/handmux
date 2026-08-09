const EDITABLE_TARGET = [
  'input',
  'textarea',
  'select',
  '[role="textbox"]',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

export interface TerminalPageKeyboardEvent {
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
}

export function isBrowserFunctionKey(event: TerminalPageKeyboardEvent): boolean {
  return event.key === 'F5' || event.key === 'F12';
}

export function isDraftShortcut(event: TerminalPageKeyboardEvent): boolean {
  return event.key === 'Enter' && event.shiftKey === true
    && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing;
}

export function shouldRouteTerminalPageKey(event: TerminalPageKeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || isBrowserFunctionKey(event)) return false;
  const target = event.target;
  if (!(target instanceof Element)) return true;
  if (target.closest('.xterm-helper-textarea')) return false;
  return !target.closest(EDITABLE_TARGET);
}
