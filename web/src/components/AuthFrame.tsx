import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import { useModalFocusTrap } from '../hooks/useModalFocusTrap.js';
import { useBackButton } from '../hooks/useBackButton.js';

function SwitchAuthHelp({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const trigger = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const commands = useRef<Array<HTMLElement | null>>([]);
  const [copyHint, setCopyHint] = useState('');
  useBackButton(true, onClose);
  useModalFocusTrap({ active: true, dialogRef: dialog, initialFocusRef: close, returnFocusRef: trigger, onClose });
  const copy = async (command: string, index: number) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(command); setCopyHint(t('auth.copied'));
    } catch {
      const element = commands.current[index];
      if (element) {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      }
      setCopyHint(t('auth.manualCopy'));
    }
  };
  return createPortal(<div className="auth-help-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="auth-help-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="auth-help-title" aria-describedby="auth-help-warning" tabIndex={-1}>
      <h2 id="auth-help-title">{t('auth.switchTitle')}</h2>
      <p id="auth-help-warning" className="auth-warning">{t('auth.switchWarning')}</p>
      <ol className="auth-help-steps">
        <li><p>{t('auth.switchSetup')}</p><div className="auth-help-command"><code ref={node => { commands.current[0] = node; }}>handmux auth trusted-origin status</code>
          <button type="button" onClick={() => { void copy('handmux auth trusted-origin status', 0); }} aria-label={t('auth.copySetup')}>{t('common.copy')}</button></div></li>
        <li><p>{t('auth.switchRestart')}</p><div className="auth-help-command"><code ref={node => { commands.current[1] = node; }}>handmux auth add</code>
          <button type="button" onClick={() => { void copy('handmux auth add', 1); }} aria-label={t('auth.copyRestart')}>{t('common.copy')}</button></div></li>
      </ol>
      <p className="auth-secondary">{t('auth.switchAfter')}</p>
      {copyHint && <p role="status">{copyHint}</p>}
      <button className="auth-help-close" ref={close} type="button" onClick={onClose}>{t('common.done')}</button>
    </section>
  </div>, document.body);
}

/** One presentation for both authentication modes; the active mode remains server-controlled. */
export default function AuthFrame({ title, mode, children }: {
  title: string; mode?: 'token' | 'trusted-device'; children: ReactNode;
}) {
  const [help, setHelp] = useState(false);
  return <main className="auth-page">
    <div className="auth-layout">
      <header className="auth-brand"><img src="/icons/icon-192.png" alt="" width="52" height="52" />
        <span>handmux</span><p>{t('auth.welcome')}</p>
      </header>
      <section className="auth-card" aria-labelledby="auth-heading">
        {mode && <span className={`auth-mode auth-mode-${mode}`}>{t(mode === 'token' ? 'devices.token' : 'devices.trusted')}</span>}
        <h1 id="auth-heading">{title}</h1>
        {children}
      </section>
      <footer className="auth-footer"><button type="button" onClick={() => setHelp(true)}>{t('auth.switchLink')}</button></footer>
    </div>
    {help && <SwitchAuthHelp onClose={() => setHelp(false)} />}
  </main>;
}
