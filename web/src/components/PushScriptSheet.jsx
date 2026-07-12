import { useState } from 'react';
import { t } from '../i18n';

// Self-contained "script push" doc module: the local `handmux push` command, this device's addressing
// key (for --device), the scope/option list, and — deliberately prominent — the reliability boundary.
export default function PushScriptSheet({ open, pushKey, notifyOn, onClose }) {
  const [copied, setCopied] = useState('');
  if (!open) return null;

  const cmd = 'handmux push "构建完成" "耗时 3m12s"';
  const copy = async (text, which) => {
    try { await navigator.clipboard.writeText(text); setCopied(which); setTimeout(() => setCopied(''), 1500); }
    catch { /* clipboard blocked — user can select manually */ }
  };

  return (
    <>
      <div className="settings-backdrop push-script-backdrop" onClick={onClose} />
      <div className="settings-card push-script-sheet" role="dialog" aria-label={t('scriptPush.title')} aria-modal="true">
        <div className="settings-head">
          <span className="settings-title">{t('scriptPush.title')}</span>
          <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>

        <p className="push-script-intro">{t('scriptPush.intro')}</p>

        <div className="push-script-block">
          <div className="push-script-label">{t('scriptPush.cmd_label')}</div>
          <pre className="push-script-cmd"><code>{cmd}</code></pre>
          <button className="fontbtn" onClick={() => copy(cmd, 'cmd')}>{copied === 'cmd' ? t('scriptPush.copied') : t('common.copy')}</button>
        </div>

        {notifyOn && pushKey ? (
          <div className="push-script-block">
            <div className="push-script-label">{t('scriptPush.key_label')}</div>
            <code className="push-script-key">{pushKey}</code>
            <button className="fontbtn" onClick={() => copy(pushKey, 'key')}>{copied === 'key' ? t('scriptPush.copied') : t('common.copy')}</button>
            <div className="push-script-hint">{t('scriptPush.key_hint')}</div>
          </div>
        ) : (
          <div className="push-script-hint">{t('scriptPush.enable_first')}</div>
        )}

        <ul className="push-script-fields">
          <li>{t('scriptPush.field_args')}</li>
          <li>{t('scriptPush.field_session')}</li>
          <li>{t('scriptPush.field_device')}</li>
          <li>{t('scriptPush.field_tag')}</li>
          <li>{t('scriptPush.field_url')}</li>
        </ul>

        <div className="push-script-note">{t('scriptPush.reliability')}</div>
      </div>
    </>
  );
}
