// Tell React the test runner drives renders inside act(), so it doesn't warn about
// "environment not configured to support act(...)" when components are tested with
// react-dom/client + act (the repo has no React Testing Library).
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Pin the UI locale to Chinese for the suite. These component tests were written asserting the Chinese
// strings and verify behavior, not the default-language choice (English default + detection is covered
// separately by test/i18n.test.js). i18n reads this at module load, and setupFiles run before the test
// modules import it, so the locale is fixed before any component resolves t().
try { localStorage.setItem('tw_lang', 'zh'); } catch { /* no localStorage in this env */ }

// Pin ASR as available for suites that exercise the cached startup state. Its absence on keyless installs
// and updates from the shared startup config are covered separately by test/useAsrAvailable.test.jsx.
try { localStorage.setItem('tw_asr', '1'); } catch { /* no localStorage in this env */ }

// jsdom has no layout engine, so scrollIntoView is not implemented at all — but the doc reader scrolls
// the spoken sentence into view. Stub it as a no-op so those paths can run (the real behavior is
// device-only and is verified on a real device, never here). Guarded: plain-logic suites run without a
// DOM, where Element does not exist.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() { /* no-op in tests */ };
}
