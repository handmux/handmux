import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { isStandalone } from '../push.js';

// One-time "Add to Home Screen" coach — a light, dismissible strip at the top of the screen (NOT a
// modal: it never blocks the app, just offers a nudge you can flick away). Shows on first entry in a
// browser tab (never once installed) and is remembered as dismissed so it doesn't nag. Android/Chrome
// gets a real one-tap install via the captured `beforeinstallprompt`; iOS has no programmatic install,
// so Safari users get the short share-sheet hint and non-Safari iOS users are pointed at Safari (the
// only iOS browser that can install a PWA).
const DISMISS_KEY = 'tw_a2hs_dismissed';

const ua = () => (typeof navigator !== 'undefined' ? navigator.userAgent || '' : '');
// iPadOS Safari masquerades as desktop Macintosh, so treat a touch-capable Mac as iOS too.
const isIOS = () => /iP(hone|ad|od)/.test(ua())
  || (/Macintosh/.test(ua()) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
const isAndroid = () => /Android/.test(ua());
// Real iOS Safari — exclude the in-app WebViews of other iOS browsers (Chrome/Firefox/Edge/Opera),
// which all report a distinctive token and cannot add to the Home Screen.
const isIOSSafari = () => isIOS() && /Safari/.test(ua()) && !/(CriOS|FxiOS|EdgiOS|OPiOS|mercury|GSA)/.test(ua());

export default function AddToHome() {
  const [show, setShow] = useState(false);
  const [deferred, setDeferred] = useState(null); // captured beforeinstallprompt (Android/Chrome)

  useEffect(() => {
    if (isStandalone()) return undefined;                 // already installed
    if (!isIOS() && !isAndroid()) return undefined;        // a phone-only pitch
    try { if (localStorage.getItem(DISMISS_KEY) === '1') return undefined; } catch { /* private mode */ }

    const onBip = (e) => { e.preventDefault(); setDeferred(e); };
    window.addEventListener('beforeinstallprompt', onBip);
    setShow(true);                                         // pop on entry
    return () => window.removeEventListener('beforeinstallprompt', onBip);
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode: hide for this load only */ }
    setShow(false);
  };
  const install = async () => {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch { /* ignore */ }
    dismiss();
  };

  // Pick the mode → the sub-line (why/how) and, on Android, a real one-tap install button.
  let mode, sub, cta = null;
  if (deferred) {
    mode = 'install'; sub = t('a2hs.lead');
    cta = <button className="a2hs-banner-cta" onClick={install}>{t('a2hs.install')}</button>;
  } else if (isIOS() && !isIOSSafari()) {
    mode = 'ios-other'; sub = t('a2hs.iosOpenSafari');
  } else if (isIOS()) {
    mode = 'ios'; sub = t('a2hs.iosHint');
  } else {
    mode = 'android'; sub = t('a2hs.androidManual');
  }

  return (
    <div className="a2hs-banner" role="status" aria-label={t('a2hs.title')} data-mode={mode}>
      <span className="a2hs-banner-icon" aria-hidden="true">⊕</span>
      <div className="a2hs-banner-txt">
        <span className="a2hs-banner-title">{t('a2hs.title')}</span>
        <span className="a2hs-banner-sub">{sub}</span>
      </div>
      {cta}
      <button className="a2hs-banner-x" onClick={dismiss} aria-label={t('common.close')}>✕</button>
    </div>
  );
}
