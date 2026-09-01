export const CONVERSATION_OVERLAY_SELECTOR = '[data-conversation-overlay]';

/**
 * Card tap-to-focus owns only real DOM descendants outside an overlay. The composer root deliberately
 * keeps handling every non-input pointerdown so opening/closing a control preserves its prior focus owner.
 */
export function isConversationComposerCardPointerTarget(
  currentTarget: HTMLElement,
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Node) || !currentTarget.contains(target)) return false;
  const element = target instanceof Element ? target : target.parentElement;
  return !element?.closest(CONVERSATION_OVERLAY_SELECTOR);
}
