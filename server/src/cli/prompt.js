// The ONLY module that touches @clack/prompts — shared by the interactive setup and shortcut editors. Everything else
// imports from here, so the prompt library stays swappable behind one seam and the wizard's pure logic
// (configFromAnswers / validators / …) never depends on it.
import { select, text, password, confirm, note, intro, outro, cancel, isCancel } from '@clack/prompts';

export { select, text, password, confirm, note, intro, outro, cancel };

// Thrown by ask() when the user cancels a prompt (Esc / Ctrl-C), so the wizard catches ONCE at the top
// instead of checking isCancel after every call.
export const CANCELLED = Symbol('setup-cancelled');

// Await a clack prompt, converting a cancel into a throw. Usage: `const v = await ask(select({…}))`.
export async function ask(promptResult) {
  const v = await promptResult;
  if (isCancel(v)) throw CANCELLED;
  return v;
}
