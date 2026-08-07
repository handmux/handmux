import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { notifyEnabled, enableNotifications, disableNotifications, pushSupported, getScriptPushKey } from '../push.js';
import { PushScriptContent } from './PushScriptSheet.jsx';
import { getDocHighlight, setDocHighlight } from '../storage.js';
import { t, getLangCode, setLang, AVAILABLE } from '../i18n';
import { SNAPSHOT_INTERVALS } from '../terminalTransport.js';
import { useBackButton } from '../hooks/useBackButton.js';
import { CheckIcon } from './icons.jsx';
import { canEnableClaudeChatLens } from '../chatLensAvailability.js';

const DETAIL_TITLE = {
  language: 'settings.language',
  font: 'settings.font_size',
  keyboard: 'settings.keyboard_mode',
  transport: 'settings.terminal_transport',
  tone: 'settings.chat_tone',
  feedback: 'settings.feedback',
  script: 'settings.script_push',
};

function SettingsHeader({ title, onBack }) {
  return (
    <header className="settings-page-head">
      <button type="button" className="settings-page-back" onClick={onBack} aria-label={t('common.back')}>‹</button>
      <h1>{title}</h1>
      <span className="settings-page-head-spacer" aria-hidden="true" />
    </header>
  );
}

function SettingsGroup({ title, children, footer }) {
  return (
    <section className="settings-page-group">
      <h2>{title}</h2>
      <div className="settings-page-list">{children}</div>
      {footer && <div className="settings-page-footer">{footer}</div>}
    </section>
  );
}

function SettingsNavRow({ label, value, onClick, dot = false, disabled = false }) {
  return (
    <button type="button" className="settings-page-row" onClick={onClick} disabled={disabled}>
      <span className="settings-page-row-label">{label}</span>
      <span className="settings-page-row-trailing">
        {value && <span className="settings-page-row-value">{value}</span>}
        {dot && <span className="settings-page-dot" aria-hidden="true" />}
        <span className="settings-page-chevron" aria-hidden="true">›</span>
      </span>
    </button>
  );
}

function SettingsValueRow({ label, value, dot = false }) {
  return (
    <div className="settings-page-row settings-page-value-row">
      <span className="settings-page-row-label">{label}</span>
      <span className="settings-page-row-trailing">
        <span className="settings-page-row-value">{value}</span>
        {dot && <span className="settings-page-dot" aria-hidden="true" />}
      </span>
    </div>
  );
}

function SettingsLinkRow({ label, href }) {
  return (
    <a className="settings-page-row" href={href} target="_blank" rel="noreferrer">
      <span className="settings-page-row-label">{label}</span>
      <span className="settings-page-row-trailing">
        <span className="settings-page-external" aria-hidden="true">↗</span>
      </span>
    </a>
  );
}

function SettingsSwitchRow({ label, checked, onChange, disabled = false, busy = false }) {
  return (
    <label className={`settings-page-row settings-page-switch${disabled ? ' disabled' : ''}`}>
      <span className="settings-page-row-label">{label}</span>
      <span className="settings-page-row-trailing">
        {busy && <span className="spinner" role="status" aria-label={t('settings.processing')} />}
        <span className="cmd-switch">
          <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
          <span className="cmd-switch-track" aria-hidden="true" />
          <span className="cmd-switch-knob" aria-hidden="true" />
        </span>
      </span>
    </label>
  );
}

function SettingsChoiceGroup({ label, options, value, onChange }) {
  return (
    <div className="settings-page-list settings-choice-list" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" className="settings-page-row settings-choice-row"
          aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          <span className="settings-page-row-label">{option.label}</span>
          <span className="settings-choice-check" aria-hidden="true">
            {value === option.value && <CheckIcon />}
          </span>
        </button>
      ))}
    </div>
  );
}

function UpdateNotice({ updateInfo }) {
  if (!updateInfo?.updateAvailable) return null;
  return (
    <div className="settings-update">
      <div className="settings-update-title">{t('settings.update_available', { v: updateInfo.latest })}</div>
      {updateInfo.whatsNew?.length > 0 && (
        <ul className="settings-update-new">
          {updateInfo.whatsNew.slice(0, 1).map((release) => (
            <li key={release.version}>
              <span className="settings-update-new-ver">v{release.version}</span>
              {(getLangCode().startsWith('zh') ? release.zh : release.en) || release.en}
            </li>
          ))}
        </ul>
      )}
      {updateInfo.whatsNew?.length > 1 && (
        <details className="settings-update-more">
          <summary>{t('settings.update_more', { n: updateInfo.whatsNew.length - 1 })}</summary>
          <ul className="settings-update-new">
            {updateInfo.whatsNew.slice(1).map((release) => (
              <li key={release.version}>
                <span className="settings-update-new-ver">v{release.version}</span>
                {(getLangCode().startsWith('zh') ? release.zh : release.en) || release.en}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="settings-update-how">{t('settings.update_how')} <code>handmux update</code></div>
    </div>
  );
}

// Full-screen, browser-local app preferences. Window/pane sizing stays with its concrete management
// target, while web-preview settings remain in that tool's own menu.
export default function Settings({ open, onClose, termRef, onOpenChangelog, changelogUnread,
  onReloadApp = () => window.location.reload(),
  chatTone = 'ink', onChatTone = () => {},
  claudeChatLensEnabled = false, onClaudeChatLensEnabled = () => {},
  codexChatLensEnabled = false, onCodexChatLensEnabled = () => {},
  keyboardMode = 'auto', onKeyboardMode = () => {},
  terminalTransport = 'live', onTerminalTransport = () => {},
  snapshotInterval = 1000, onSnapshotInterval = () => {},
  hooksStatus = null, onEnableHooks = null,
  notifUnread = false, onOpenInbox,
  updateInfo = null,
  workspaceProtection = null }) {
  const [page, setPage] = useState('root');
  const [font, setFont] = useState(null);
  const [docHl, setDocHl] = useState(getDocHighlight());
  const [notify, setNotify] = useState(notifyEnabled());
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [notifyMsg, setNotifyMsg] = useState('');
  const [notifyDisableConfirm, setNotifyDisableConfirm] = useState(false);
  const [lensHooksBusy, setLensHooksBusy] = useState(false);
  const [lensHooksErr, setLensHooksErr] = useState(false);
  const [scriptPushKey, setScriptPushKey] = useState(null);
  const bodyRef = useRef(null);
  const rootScrollRef = useRef(0);

  const claudeLensLocked = !canEnableClaudeChatLens(hooksStatus);
  const notificationsSupported = pushSupported();

  useEffect(() => {
    if (open) {
      setFont(termRef.current?.getFontSize?.() ?? null);
      setNotify(notifyEnabled());
    } else {
      setPage('root');
      setNotifyMsg('');
      setNotifyDisableConfirm(false);
      rootScrollRef.current = 0;
    }
  }, [open, termRef]);

  useBackButton(open && page !== 'root', () => setPage('root'));
  useBackButton(open && notifyDisableConfirm, () => setNotifyDisableConfirm(false));

  useLayoutEffect(() => {
    if (open && page === 'root' && bodyRef.current) bodyRef.current.scrollTop = rootScrollRef.current;
  }, [open, page]);

  if (!open) return null;

  const openPage = (nextPage) => {
    if (page === 'root') rootScrollRef.current = bodyRef.current?.scrollTop ?? 0;
    setPage(nextPage);
  };
  const backToRoot = () => setPage('root');

  const stepFont = (delta) => {
    const current = termRef.current?.getFontSize?.();
    const applied = termRef.current?.setFontSize?.((current?.size ?? 14) + delta);
    if (applied != null) setFont({ size: applied, auto: false });
  };
  const autoFont = () => {
    termRef.current?.autoFont?.();
    setFont({ size: null, auto: true });
  };
  const toggleDocHl = (on) => {
    setDocHl(on);
    setDocHighlight(on);
    termRef.current?.setDocHighlight?.(on);
  };

  const enableLensHooks = async () => {
    setLensHooksBusy(true);
    setLensHooksErr(false);
    try {
      const result = await onEnableHooks?.();
      if (!result || result.status !== 'installed') setLensHooksErr(true);
    } catch {
      setLensHooksErr(true);
    } finally {
      setLensHooksBusy(false);
    }
  };

  const setNotificationEnabled = async (enabled) => {
    setNotifyBusy(true);
    setNotifyMsg('');
    try {
      if (enabled) {
        await enableNotifications();
        setNotify(true);
        setNotifyMsg(t('settings.notify_enabled'));
      } else {
        await disableNotifications();
        setNotify(false);
        setNotifyMsg(t('settings.notify_disabled'));
      }
    } catch (error) {
      setNotifyMsg(error.message || t('settings.notify_failed'));
    } finally {
      setNotifyBusy(false);
    }
  };

  const changeNotify = (event) => {
    if (!event.target.checked) {
      setNotifyDisableConfirm(true);
      return;
    }
    setNotificationEnabled(true);
  };

  const confirmDisableNotify = () => {
    setNotifyDisableConfirm(false);
    setNotificationEnabled(false);
  };

  const openScriptPush = async () => {
    try {
      setScriptPushKey(notifyEnabled() ? await getScriptPushKey() : null);
    } catch {
      setScriptPushKey(null);
    }
    openPage('script');
  };

  const fontLabel = font?.auto ? t('settings.font_auto') : font?.size ? `${font.size}px` : '—';
  const languageLabel = AVAILABLE.find((language) => language.code === getLangCode())?.label || '—';
  const protectionReason = ['live-corrupt', 'live-unavailable'].includes(workspaceProtection?.errorCode)
    ? workspaceProtection.errorCode : 'unknown';

  const claudeLensFooter = claudeLensLocked ? (
    <>
      <div>{t(hooksStatus === 'no-claude' ? 'settings.chat_lens_no_claude' : 'settings.chat_lens_need_hooks')}</div>
      {hooksStatus === 'absent' && (
        <button type="button" className="settings-page-inline-action" disabled={lensHooksBusy}
          onClick={enableLensHooks}>
          {lensHooksBusy ? t('settings.chat_lens_installing') : t('settings.chat_lens_install_hooks')}
        </button>
      )}
      {lensHooksErr && <div className="settings-hint-err">{t('settings.chat_lens_hooks_err')}</div>}
    </>
  ) : <div>{t('settings.chat_lens_claude_hint')}</div>;
  const lensFooter = (
    <>
      {claudeLensFooter}
      <div>{t('settings.chat_lens_codex_hint')}</div>
    </>
  );

  const rootContent = (
    <>
      {workspaceProtection?.status === 'degraded' && (
        <div className="settings-page-alert" role="status">
          <strong>{t('workspace.protectionTitle')}</strong>
          <span>{t(`workspace.protection.${protectionReason}`)}</span>
        </div>
      )}

      <SettingsGroup title={t('settings.group_general')}>
        <SettingsNavRow label={t('settings.language')} value={languageLabel} onClick={() => openPage('language')} />
        <SettingsNavRow label={t('settings.font_size')} value={fontLabel} onClick={() => openPage('font')} />
        <SettingsNavRow label={t('settings.keyboard_mode')} value={t(`settings.keyboard_mode_${keyboardMode}`)}
          onClick={() => openPage('keyboard')} />
      </SettingsGroup>

      <SettingsGroup title={t('settings.group_terminal')} footer={t('settings.path_highlight_hint')}>
        <SettingsNavRow label={t('settings.terminal_transport')}
          value={t(`settings.terminal_transport_${terminalTransport}`)} onClick={() => openPage('transport')} />
        <SettingsSwitchRow label={t('settings.path_highlight')} checked={docHl}
          onChange={(event) => toggleDocHl(event.target.checked)} />
      </SettingsGroup>

      <SettingsGroup title={t('settings.group_chat')} footer={lensFooter}>
        <SettingsSwitchRow label={t('settings.chat_lens_claude')} checked={claudeChatLensEnabled}
          disabled={claudeLensLocked && !claudeChatLensEnabled}
          onChange={(event) => onClaudeChatLensEnabled(event.target.checked)} />
        <SettingsSwitchRow label={t('settings.chat_lens_codex')} checked={codexChatLensEnabled}
          onChange={(event) => onCodexChatLensEnabled(event.target.checked)} />
        {(claudeChatLensEnabled || codexChatLensEnabled) && (
          <SettingsNavRow label={t('settings.chat_tone')} value={t(`settings.chat_tone_${chatTone}`)}
            onClick={() => openPage('tone')} />
        )}
      </SettingsGroup>

      <SettingsGroup title={t('settings.group_notifications')} footer={notifyMsg || (
        notificationsSupported ? t('settings.push_hint') : t('settings.push_unsupported')
      )}>
        <SettingsSwitchRow label={t('settings.push_notifications')} checked={notify}
          disabled={!notificationsSupported || notifyBusy} busy={notifyBusy} onChange={changeNotify} />
        <SettingsNavRow label={t('settings.script_push')} value={t('settings.script_push_open')}
          disabled={!notificationsSupported} onClick={openScriptPush} />
        <SettingsNavRow label={t('pushInbox.title')} dot={notifUnread} onClick={() => onOpenInbox?.()} />
      </SettingsGroup>

      <SettingsGroup title={t('settings.group_about')}
        footer={updateInfo?.updateAvailable ? <UpdateNotice updateInfo={updateInfo} /> : null}>
        <SettingsValueRow label={t('settings.version')}
          value={updateInfo?.current ? `v${updateInfo.current}` : '—'} dot={!!updateInfo?.updateAvailable} />
        <SettingsNavRow label={t('settings.view_changelog')} dot={changelogUnread} onClick={onOpenChangelog} />
        <SettingsNavRow label={t('settings.feedback')} onClick={() => openPage('feedback')} />
        <button type="button" className="settings-page-row settings-page-text-action" onClick={onReloadApp}>
          <span className="settings-page-row-label">{t('settings.reload_app')}</span>
        </button>
      </SettingsGroup>
    </>
  );

  const detailContent = {
    language: (
      <SettingsChoiceGroup label={t('settings.language')} value={getLangCode()} onChange={setLang}
        options={AVAILABLE.map((language) => ({ value: language.code, label: language.label }))} />
    ),
    font: (
      <section className="settings-detail-card settings-font-card">
        <div className="settings-font-value">{fontLabel}</div>
        <div className="settings-font-controls" role="group" aria-label={t('settings.font_size')}>
          <button type="button" onClick={() => stepFont(-1)} aria-label={t('settings.font_decrease')}>A−</button>
          <button type="button" onClick={() => stepFont(1)} aria-label={t('settings.font_increase')}>A+</button>
          <button type="button" className={font?.auto ? 'selected' : ''} onClick={autoFont}
            aria-pressed={!!font?.auto}>{t('settings.font_auto')}</button>
        </div>
        <p>{t('settings.font_auto_title')}</p>
      </section>
    ),
    keyboard: (
      <>
        <SettingsChoiceGroup label={t('settings.keyboard_mode')} value={keyboardMode} onChange={onKeyboardMode}
          options={['auto', 'mobile', 'desktop'].map((mode) => ({
            value: mode, label: t(`settings.keyboard_mode_${mode}`),
          }))} />
        <p className="settings-detail-note">{t('settings.keyboard_mode_hint')}</p>
      </>
    ),
    transport: (
      <>
        <SettingsChoiceGroup label={t('settings.terminal_transport')} value={terminalTransport}
          onChange={onTerminalTransport} options={['live', 'snapshot'].map((mode) => ({
            value: mode, label: t(`settings.terminal_transport_${mode}`),
          }))} />
        <p className="settings-detail-note">{t('settings.terminal_transport_hint')}</p>
        {terminalTransport === 'snapshot' && (
          <section className="settings-page-group settings-detail-group">
            <h2>{t('settings.snapshot_interval')}</h2>
            <SettingsChoiceGroup label={t('settings.snapshot_interval')} value={snapshotInterval}
              onChange={onSnapshotInterval} options={SNAPSHOT_INTERVALS.map((intervalMs) => ({
                value: intervalMs,
                label: `${(intervalMs / 1000).toFixed(intervalMs % 1000 ? 1 : 0)}s`,
              }))} />
            <p className="settings-page-footer">{t('settings.snapshot_interval_hint')}</p>
          </section>
        )}
      </>
    ),
    tone: (
      <>
        <SettingsChoiceGroup label={t('settings.chat_tone')} value={chatTone} onChange={onChatTone}
          options={['dusk', 'ink', 'light'].map((tone) => ({
            value: tone, label: t(`settings.chat_tone_${tone}`),
          }))} />
        <p className="settings-detail-note">{t('settings.chat_tone_hint')}</p>
      </>
    ),
    feedback: (
      <>
        <div className="settings-page-list">
          <SettingsLinkRow label={t('settings.feedback_issues')} href="https://github.com/handmux/handmux/issues" />
          {getLangCode().startsWith('zh') && (
            <SettingsLinkRow label={t('settings.feedback_group')} href="https://handmux.com/#community" />
          )}
        </div>
        <p className="settings-detail-note">{t('settings.feedback_hint')}</p>
      </>
    ),
    script: <PushScriptContent pushKey={scriptPushKey} notifyOn={notify} />,
  };

  return (
    <div className="settings-page" role="dialog" aria-label={t('settings.title')} aria-modal="true">
      <SettingsHeader title={page === 'root' ? t('settings.title') : t(DETAIL_TITLE[page])}
        onBack={page === 'root' ? onClose : backToRoot} />
      <div ref={bodyRef} className="settings-page-body">
        <main className={`settings-page-content${page === 'root' ? '' : ' detail'}`}>
          {page === 'root' ? rootContent : detailContent[page]}
        </main>
      </div>
      {notifyDisableConfirm && (
        <div className="settings-confirm-backdrop" onClick={() => setNotifyDisableConfirm(false)}>
          <div className="settings-confirm" role="alertdialog" aria-modal="true"
            aria-labelledby="settings-notify-disable-title" aria-describedby="settings-notify-disable-hint"
            onClick={(event) => event.stopPropagation()}>
            <h2 id="settings-notify-disable-title">{t('settings.notify_disable_title')}</h2>
            <p id="settings-notify-disable-hint">{t('settings.notify_disable_hint')}</p>
            <div className="settings-confirm-actions">
              <button type="button" autoFocus onClick={() => setNotifyDisableConfirm(false)}>{t('common.cancel')}</button>
              <button type="button" className="danger" onClick={confirmDisableNotify}>
                {t('settings.notify_disable_confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
