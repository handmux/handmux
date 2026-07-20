// Strict tmux key vocabulary shared by the /keys API and config validation. Never pass an arbitrary
// config string through to `tmux send-keys`: named keys and canonical modifier chords only.
const NAMED = 'Up|Down|Left|Right|Space|Enter|Escape|Tab|BTab|BSpace|Home|End|PageUp|PageDown';
const NAMED_KEY = new RegExp(`^(?:C-)?(?:M-)?(?:S-)?(?:${NAMED})$`);
const CHAR_KEY = /^(?:C-)?(?:M-)?[a-z0-9]$/;

export function isAllowedKey(key) {
  if (typeof key !== 'string') return false;
  return NAMED_KEY.test(key) || (CHAR_KEY.test(key) && key.includes('-'));
}
