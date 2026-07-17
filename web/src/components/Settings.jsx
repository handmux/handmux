import { useEffect, useState } from 'react';
import { notifyEnabled, enableNotifications, disableNotifications, pushSupported, getScriptPushKey } from '../push.js';
import DirPicker from './DirPicker.jsx';
import PushScriptSheet from './PushScriptSheet.jsx';
import { fetchPaneCwd } from '../api.js';
import { fmtRemainMin, useRemaining } from '../previewCountdown.js';
import { getDocHighlight, setDocHighlight } from '../storage.js';
import { t, getLangCode, setLang, AVAILABLE } from '../i18n';

// Settings modal: the screen-column controls (⊟/⊞/↺, previously in the topbar) plus an explicit
// font-size control. Font reads/writes the live terminal through termRef — the same persisted
// size the two-finger pinch drives — so the modal and the gesture stay in sync.
export default function Settings({ open, onClose, termRef, onColAdjust, onColRestore, onOpenChangelog, changelogUnread,
  chatTone = 'ink', onChatTone = () => {},
  notifUnread = false, onOpenInbox,
  updateInfo = null,
  activePreview = null, pane = null, lastPreviewDir = null, dynamicEnabled = false,
  getColCount = null,
  onStartPreview, onStartDynamicPreview, onOpenPreview, onRenew, onStop }) {
  const [font, setFont] = useState(null); // { size, auto } snapshot for display
  const [docHl, setDocHl] = useState(getDocHighlight()); // doc-path highlight toggle (default off)
  const [cols, setCols] = useState(null); // current col count for display (null = unknown/restored)
  const [langOpen, setLangOpen] = useState(false);
  const [notify, setNotify] = useState(notifyEnabled()); // device-notification toggle state
  const [notifyBusy, setNotifyBusy] = useState(false); // true while (un)subscribing — shows a spinner, disables the button
  const [notifyMsg, setNotifyMsg] = useState(''); // inline status/error shown to the right of the toggle
  const [scriptPushOpen, setScriptPushOpen] = useState(false);
  const [scriptPushKey, setScriptPushKey] = useState(null);
  const [dirOpen, setDirOpen] = useState(false);
  const [seedCwd, setSeedCwd] = useState(null); // dir the picker lands on (the pane's live cwd)
  const [previewKind, setPreviewKind] = useState('off');    // start mode: off (default) / static / dynamic
  const [port, setPort] = useState('');                     // dynamic port input (string)
  const [confirmStop, setConfirmStop] = useState(false);    // two-tap guard on 停止 (no nested modal)
  const [startErr, setStartErr] = useState('');             // dynamic-start failure shown inline (e.g. 端口未监听)
  const [starting, setStarting] = useState(false);          // disable 启动 while the request is in flight
  const remainMs = useRemaining(activePreview?.expiresAt, !!activePreview && open); // live TTL countdown
  useEffect(() => { setConfirmStop(false); setStartErr(''); }, [activePreview?.name, open]); // reset guards per preview/open
  // Friendly text for the server's dynamic-start errors.
  const startMsg = (m) => ({
    'port not listening': t('settings.err_port_not_listening'),
    'bad port': t('settings.err_bad_port'),
    'dynamic disabled': t('settings.err_dynamic_disabled'),
  }[m] || m || t('settings.err_start_failed'));
  const startDynamic = async () => {
    const p = Number(port);
    if (!p) return;
    setStartErr(''); setStarting(true);
    // On success, onStartDynamicPreview (in App) closes Settings ITSELF and opens the preview sheet,
    // sequenced on Settings' back-popstate so the sheet doesn't catch Settings' own Back — so we must NOT
    // call onClose() here (App owns the close). On failure it throws and we keep Settings open to show the
    // inline error below.
    try { await onStartDynamicPreview?.(p); }
    catch (e) { setStartErr(startMsg(e?.message)); }
    finally { setStarting(false); }
  };
  // Open the dir picker seeded at the LAST preview dir for this window (so re-previewing the same
  // build is one tap), else the pane's current cwd (re-fetched, honoring a mid-session `cd`), else
  // $HOME. The picker also has a "jump to cwd" shortcut for switching dirs on the spot.
  const openScriptPush = async () => {
    setScriptPushKey(notifyEnabled() ? await getScriptPushKey() : null);
    setScriptPushOpen(true);
  };

  const openDirPicker = async () => {
    let seed = lastPreviewDir;
    if (!seed && pane) { try { seed = (await fetchPaneCwd(pane)).cwd || null; } catch { /* → $HOME */ } }
    setSeedCwd(seed);
    setDirOpen(true);
  };

  useEffect(() => {
    if (open) {
      setFont(termRef.current?.getFontSize?.() ?? null);
      setCols(getColCount?.() ?? null);
    }
  }, [open, termRef, getColCount]);

  const toggleNotify = async () => {
    setNotifyBusy(true); setNotifyMsg('');
    try {
      if (notify) { await disableNotifications(); setNotify(false); setNotifyMsg(t('settings.notify_disabled')); }
      else { await enableNotifications(); setNotify(true); setNotifyMsg(t('settings.notify_enabled')); }
    } catch (e) { setNotifyMsg(e.message || t('settings.notify_failed')); }
    finally { setNotifyBusy(false); }
  };

  if (!open) return null;

  // Step from the live size (not the stale snapshot) so a tap after "自适应" steps from the size
  // auto-fit actually settled on.
  const stepFont = (d) => {
    const cur = termRef.current?.getFontSize?.();
    const applied = termRef.current?.setFontSize?.((cur?.size ?? 14) + d);
    if (applied != null) setFont({ size: applied, auto: false });
  };
  const auto = () => {
    termRef.current?.autoFont?.();
    setFont({ size: null, auto: true });
  };
  const toggleDocHl = (on) => { setDocHl(on); setDocHighlight(on); termRef.current?.setDocHighlight?.(on); };

  const fontLabel = font?.auto ? t('settings.font_auto') : font?.size ? `${font.size}px` : '—';
  const colsLabel = cols != null ? `${cols} 列` : '—';
  const adjustCol = (d) => { onColAdjust?.(d); setCols(getColCount?.() ?? null); };
  const restoreCol = () => { onColRestore?.(); setCols(null); };

  return (
    <>
      <div className="settings-backdrop" onClick={onClose} />
      <div className="settings-card" role="dialog" aria-label={t('settings.title')} aria-modal="true">
        <div className="settings-head">
          <span className="settings-title">{t('settings.title')}</span>
          <button className="settings-close" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>

        <div className="settings-body">
        <div className="settings-group">{t('settings.group_global')}</div>

        <div className="settings-section">
          <div className="settings-label">{t('settings.language')}</div>
          <div className="lang-drop">
            {langOpen && <div className="lang-drop-backdrop" onClick={() => setLangOpen(false)} />}
            <button className="lang-trigger" onClick={() => setLangOpen(o => !o)}>
              <span>{AVAILABLE.find(l => l.code === getLangCode())?.label}</span>
              <span className="lang-chevron">{langOpen ? '▴' : '▾'}</span>
            </button>
            {langOpen && (
              <div className="lang-menu">
                {AVAILABLE.map(l => (
                  <button key={l.code} className={`lang-option${l.code === getLangCode() ? ' active' : ''}`}
                    onClick={() => setLang(l.code)}>{l.label}</button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-label">{t('settings.font_size')}</div>
          <div className="settings-btns">
            <button className="fontbtn" onClick={() => stepFont(-1)} aria-label={t('settings.font_decrease')}>A−</button>
            <span className="settings-value">{fontLabel}</span>
            <button className="fontbtn" onClick={() => stepFont(1)} aria-label={t('settings.font_increase')}>A+</button>
            <button className="fontbtn" onClick={auto} title={t('settings.font_auto_title')}>{t('settings.font_auto')}</button>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-label">{t('settings.chat_tone')}</div>
          <div className="settings-btns">
            {['ink', 'light', 'dusk'].map((tn) => (
              <button
                key={tn}
                className="fontbtn"
                aria-pressed={chatTone === tn}
                onClick={() => onChatTone(tn)}
              >
                {t(`settings.chat_tone_${tn}`)}
              </button>
            ))}
          </div>
          <div className="settings-hint">{t('settings.chat_tone_hint')}</div>
        </div>

        <div className="settings-section">
          <label className="settings-toggle">
            <span className="settings-label">{t('settings.path_highlight')}</span>
            <span className="cmd-switch">
              <input type="checkbox" checked={docHl} onChange={(e) => toggleDocHl(e.target.checked)} />
              <span className="cmd-switch-track" aria-hidden="true" />
              <span className="cmd-switch-knob" aria-hidden="true" />
            </span>
          </label>
          <div className="settings-hint">{t('settings.path_highlight_hint')}</div>
        </div>

        <div className="settings-section">
          <div className="settings-label">{t('settings.version')}</div>
          <div className="settings-btns">
            <span className="settings-value">{updateInfo?.current ? `v${updateInfo.current}` : '—'}</span>
            <button className="fontbtn" onClick={onOpenChangelog}>
              {t('settings.view_changelog')}{changelogUnread && <span className="settings-dot" aria-label={t('settings.has_update')} />}
            </button>
          </div>
          {/* The upgrade is a computer-side `handmux update`; the phone can only show the notice, so no button.
              `whatsNew` (concise per-version highlights the newer package carries) tells the user what the trip
              to the computer buys them — pulled in by the update check, so it may lag a bit. zh dicts (incl.
              zh-TW) map to the highlight's `zh`; everything else falls back to `en`. */}
          {updateInfo?.updateAvailable && (
            <div className="settings-update">
              <div className="settings-update-title">{t('settings.update_available', { v: updateInfo.latest })}</div>
              {updateInfo.whatsNew?.length > 0 && (
                <ul className="settings-update-new">
                  {updateInfo.whatsNew.map((w) => (
                    <li key={w.version}>
                      <span className="settings-update-new-ver">v{w.version}</span>
                      {(getLangCode().startsWith('zh') ? w.zh : w.en) || w.en}
                    </li>
                  ))}
                </ul>
              )}
              <div className="settings-update-how">{t('settings.update_how')} <code>handmux update</code></div>
            </div>
          )}
        </div>


        {/* Feedback entries: GitHub Issues is the tracked channel (always shown); the WeChat user
            group is Chinese-speaking, so its link only renders on zh locales. Both open externally —
            the QR lives on the site (one place to update, no app redeploy when it rotates). */}
        <div className="settings-section">
          <div className="settings-label">{t('settings.feedback')}</div>
          <div className="settings-btns">
            <a className="fontbtn settings-linkbtn" href="https://github.com/handmux/handmux/issues" target="_blank" rel="noreferrer">{t('settings.feedback_issues')}</a>
            {getLangCode().startsWith('zh') && (
              <a className="fontbtn settings-linkbtn" href="https://handmux.com/#community" target="_blank" rel="noreferrer">{t('settings.feedback_group')}</a>
            )}
          </div>
          <div className="settings-hint">{t('settings.feedback_hint')}</div>
        </div>

        <div className="settings-section">
          <div className="settings-label">{t('settings.push_notifications')}</div>
          {pushSupported() ? (
            <>
              <div className="settings-btns">
                <button className="fontbtn" onClick={toggleNotify} disabled={notifyBusy} aria-pressed={notify}>
                  {notify ? t('settings.notify_on') : t('settings.notify_enable')}
                </button>
                {notifyBusy && <span className="spinner" role="status" aria-label={t('settings.processing')} />}
                {!notifyBusy && notifyMsg && <span className="settings-note">{notifyMsg}</span>}
              </div>
              <div className="settings-hint">{t('settings.push_hint')}</div>
            </>
          ) : (
            <div className="settings-value" style={{ display: 'block' }}>{t('settings.push_unsupported')}</div>
          )}
        </div>

        <div className="settings-section">
          <div className="settings-label">{t('settings.script_push')}</div>
          <div className="settings-btns">
            <button className="fontbtn" onClick={openScriptPush} disabled={!pushSupported()}>{t('settings.script_push_open')}</button>
            <button className="fontbtn push-inbox-entry" onClick={onOpenInbox}>
              {t('pushInbox.title')}
              {notifUnread && <span className="push-inbox-entry-dot" aria-hidden="true" />}
            </button>
          </div>
          <div className="settings-hint">{t('settings.script_push_hint')}</div>
        </div>

        <div className="settings-group">{t('settings.group_session')}</div>

        <div className="settings-section">
          <div className="settings-label">{t('settings.screen_cols')}</div>
          <div className="settings-btns cols-btns">
            <button className="fontbtn col-step" onClick={() => adjustCol(-10)}>−10</button>
            <button className="fontbtn col-step col-fine" onClick={() => adjustCol(-1)}>−1</button>
            <span className="settings-value">{colsLabel}</span>
            <button className="fontbtn col-step col-fine" onClick={() => adjustCol(1)}>+1</button>
            <button className="fontbtn col-step" onClick={() => adjustCol(10)}>+10</button>
            <button className="fontbtn" onClick={restoreCol}>↺ {t('settings.cols_restore')}</button>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-label">{dynamicEnabled ? t('settings.preview_site') : t('settings.preview_static_site')}</div>
          {activePreview ? (
            <div className="preview-active">
              <div className="preview-active-head">
                <span className="preview-running"><span className="live-dot" />{activePreview.kind === 'dynamic' ? t('settings.preview_running_dynamic') : t('settings.preview_running_static')}</span>
                <span className="preview-remain-s" title={t('settings.preview_remain_title')}>{t('settings.preview_remain', { time: fmtRemainMin(remainMs) })}</span>
              </div>
              <div className="settings-btns">
                <button className="fontbtn" onClick={() => { onOpenPreview?.(); onClose?.(); }}>{t('common.open')}</button>
                <button className="fontbtn" onClick={() => onRenew?.()}>{t('settings.preview_renew')}</button>
                {confirmStop ? (
                  <>
                    <button className="fontbtn preview-confirm-danger" onClick={() => { setConfirmStop(false); onStop?.(); }}>{t('settings.preview_confirm_stop')}</button>
                    <button className="fontbtn" onClick={() => setConfirmStop(false)}>{t('common.cancel')}</button>
                  </>
                ) : (
                  <button className="fontbtn" onClick={() => setConfirmStop(true)}>{t('settings.preview_stop')}</button>
                )}
              </div>
              <div className="settings-hint">
                {t('settings.preview_name', { name: activePreview.name })}{activePreview.kind === 'dynamic'
                  ? t('settings.preview_port', { port: activePreview.port })
                  : (activePreview.dir ? `(${activePreview.dir})` : '')}
              </div>
            </div>
          ) : (
            <div className="preview-start">
              <div className="preview-seg" role="tablist" aria-label={t('settings.preview_type')}>
                <button role="tab" className={previewKind === 'off' ? 'on' : ''} aria-selected={previewKind === 'off'} onClick={() => setPreviewKind('off')}>{t('settings.preview_off')}</button>
                <button role="tab" className={previewKind === 'static' ? 'on' : ''} aria-selected={previewKind === 'static'} onClick={() => setPreviewKind('static')}>{t('settings.preview_static')}</button>
                {dynamicEnabled && (
                  <button role="tab" className={previewKind === 'dynamic' ? 'on' : ''} aria-selected={previewKind === 'dynamic'} onClick={() => { setStartErr(''); setPreviewKind('dynamic'); }}>{t('settings.preview_dynamic')}</button>
                )}
              </div>
              {previewKind === 'off' && (
                <>
                  <div className="settings-hint">{dynamicEnabled ? t('settings.preview_off_hint_both') : t('settings.preview_off_hint')}</div>
                  {!dynamicEnabled && (
                    <div className="settings-hint preview-dynamic-disabled">{t('settings.preview_dynamic_disabled')}</div>
                  )}
                </>
              )}
              {previewKind === 'static' && (
                <>
                  <div className="settings-btns">
                    <button className="fontbtn" onClick={openDirPicker}>{t('settings.preview_pick_dir')}</button>
                  </div>
                  <div className="settings-hint">{t('settings.preview_static_hint')}</div>
                </>
              )}
              {previewKind === 'dynamic' && (
                <>
                  <div className="settings-btns">
                    <input className="preview-port" type="number" inputMode="numeric" min="1" max="65535"
                      placeholder={t('settings.preview_port_placeholder')} value={port} onChange={(e) => { setPort(e.target.value); setStartErr(''); }} aria-label={t('settings.preview_port_label')} />
                    <button className="fontbtn" disabled={!port || starting} onClick={startDynamic}>{starting ? t('settings.preview_starting') : t('settings.preview_start')}</button>
                  </div>
                  {startErr
                    ? <div className="settings-hint settings-err">{startErr}</div>
                    : <div className="settings-hint">{t('settings.preview_dynamic_hint')}</div>}
                </>
              )}
            </div>
          )}
        </div>
        </div>
      </div>
      <DirPicker
        open={dirOpen}
        seedCwd={seedCwd}
        pane={pane}
        hint={t('settings.dir_picker_hint')}
        onPick={(dir) => { setDirOpen(false); onStartPreview?.(dir); onClose?.(); }}
        onClose={() => setDirOpen(false)}
      />
      <PushScriptSheet
        open={scriptPushOpen}
        pushKey={scriptPushKey}
        notifyOn={notify}
        onClose={() => setScriptPushOpen(false)}
      />
    </>
  );
}
