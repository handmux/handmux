import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '../i18n';

interface PushScriptContentProps {
  pushKey?: string | null;
  notifyOn: boolean;
}

// Self-contained "script push" doc module: three standalone command examples (all devices / a session /
// this device), the two optional flags as a footnote, and — deliberately prominent — the reliability
// boundary. The device example inlines THIS device's real key so it's copy-and-run.
export function PushScriptContent({ pushKey, notifyOn }: PushScriptContentProps) {
  const [copied, setCopied] = useState('');
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
  }, []);

  const base = 'handmux push "构建完成" "耗时 3m12s"';
  const hasKey = !!(notifyOn && pushKey);
  const cmdAll = base;
  const cmdSession = `${base} --session ${t('scriptPush.session_placeholder')}`;
  const cmdDevice = `${base} --device ${hasKey ? pushKey : t('scriptPush.device_placeholder')}`;

  const copy = async (text: string, which: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => setCopied(''), 1500);
    }
    catch { /* clipboard blocked — user can select manually */ }
  };
  const copyLabel = (which: string): string => (
    copied === which ? t('scriptPush.copied') : t('common.copy')
  );

  const example = (which: string, label: string, cmd: string, note?: string): ReactNode => (
    <div className="push-script-block">
      <div className="push-script-label">{label}</div>
      <pre className="push-script-cmd"><code>{cmd}</code></pre>
      {note && <div className="push-script-hint">{note}</div>}
      <button className="fontbtn" onClick={() => void copy(cmd, which)}>{copyLabel(which)}</button>
    </div>
  );

  return (
    <div className="push-script-content">
      <p className="push-script-intro">{t('scriptPush.intro')}</p>

      {example('all', t('scriptPush.scope_all'), cmdAll)}
      {example('session', t('scriptPush.scope_session'), cmdSession)}
      {example('device', t('scriptPush.scope_device'), cmdDevice,
        hasKey ? t('scriptPush.device_key_note') : t('scriptPush.device_need_enable'))}

      <div className="push-script-block">
        <div className="push-script-label">{t('scriptPush.opts_label')}</div>
        <ul className="push-script-fields">
          <li>{t('scriptPush.opt_tag')}</li>
          <li>{t('scriptPush.opt_url')}</li>
        </ul>
      </div>

      <div className="push-script-note">{t('scriptPush.reliability')}</div>
    </div>
  );
}

export default function PushScriptSheet({
  open, pushKey, notifyOn, onClose,
}: PushScriptContentProps & { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <>
      <div className="settings-backdrop push-script-backdrop" onClick={onClose} />
      <div className="settings-card push-script-sheet" role="dialog" aria-label={t('scriptPush.title')} aria-modal="true">
        <div className="settings-head">
          <span className="settings-title">{t('scriptPush.title')}</span>
          <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        <PushScriptContent pushKey={pushKey ?? null} notifyOn={notifyOn} />
      </div>
    </>
  );
}
