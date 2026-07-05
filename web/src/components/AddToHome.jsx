import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { isStandalone } from '../push.js';

// One-time "Add to Home Screen" coach. Pops on first entry in a browser tab (never once installed),
// and is remembered as dismissed so it doesn't nag. Android/Chrome gets a real one-tap install via
// the captured `beforeinstallprompt`; iOS has no programmatic install, so Safari users get the manual
// steps and non-Safari iOS users are pointed at Safari (the only iOS browser that can install a PWA).
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

  let body;
  if (deferred) {
    body = <button className="a2hs-install" onClick={install}>{t('a2hs.install')}</button>;
  } else if (isIOS() && !isIOSSafari()) {
    body = <p className="a2hs-note">{t('a2hs.iosOpenSafari')}</p>;
  } else if (isIOS()) {
    body = (
      <ol className="a2hs-steps">
        <li>{t('a2hs.ios1')}</li>
        <li>{t('a2hs.ios2')}</li>
        <li>{t('a2hs.ios3')}</li>
      </ol>
    );
  } else {
    body = <p className="a2hs-note">{t('a2hs.androidManual')}</p>;
  }

  return (
    <>
      <div className="settings-backdrop" onClick={dismiss} />
      <div className="settings-card" role="dialog" aria-modal="true" aria-label={t('a2hs.title')}>
        <div className="settings-head">
          <span className="settings-title">{t('a2hs.title')}</span>
          <button className="settings-close" onClick={dismiss} aria-label={t('common.close')}>✕</button>
        </div>
        <div className="settings-section">
          <p className="a2hs-lead">{t('a2hs.lead')}</p>
          {body}
          <button className="fontbtn sheet-cancel a2hs-later" onClick={dismiss}>{t('a2hs.later')}</button>
        </div>
      </div>
    </>
  );
}
