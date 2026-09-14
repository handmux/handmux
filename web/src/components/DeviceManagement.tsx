import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { deviceManagementApi as api, DeviceManagementError, type DeviceApproval, type DeviceList, type ManagedDevice } from '../deviceManagementApi.js';
import { isDeviceAuth, logoutDevice, authRequest, applyAuthStatus } from '../authSession.js';
import { useBackButton } from '../hooks/useBackButton.js';
import { useModalFocusTrap } from '../hooks/useModalFocusTrap.js';
import { OverlayPortal } from '../overlays/OverlayHost.js';
import { t } from '../i18n';

export const deviceErrorCopy = (error: unknown): string => {
  const codes: Record<string, string> = {
    DEVICE_CONFLICT: 'devices.conflict', DEVICE_INACTIVE: 'devices.inactive', DEVICE_EXPIRY_CLI_ONLY: 'devices.expiryCliOnly', SESSION_INVALID: 'devices.sessionInvalid',
    CODE_INVALID: 'devices.invalidCode', CLAIM_RATE_LIMIT: 'auth.rateLimit', AUTH_RATE_LIMIT: 'auth.rateLimit',
    PAIRING_NOT_FOUND: 'devices.pairingGone', PAIRING_INACTIVE: 'devices.pairingGone',
    INVALID_NAME: 'devices.invalidName', INVALID_EXPIRE: 'devices.invalidExpire',
    TRUSTED_ORIGIN_MISMATCH: 'devices.originMismatch', AUTH_ORIGIN_REJECTED: 'devices.originMismatch', origin_rejected: 'devices.originMismatch',
    INVALID_ORIGIN: 'devices.invalidOrigin', ORIGIN_LIMIT: 'devices.originLimit',
  };
  return t(error instanceof DeviceManagementError ? codes[error.code] ?? 'devices.requestError' : 'devices.requestError');
};
const isInactive = (d: ManagedDevice, now: number): boolean => d.status !== 'active' || d.expires_at !== null && d.expires_at <= now;
const date = (value: number | null): string => value === null ? t('devices.never') : new Date(value).toLocaleString();
export function remainingExpiry(d: ManagedDevice, now: number): string {
  if (d.revoked_at !== null) return t('devices.revoked');
  if (d.expires_at === null) return t('devices.never');
  const seconds = Math.ceil((d.expires_at - now) / 1000);
  if (seconds <= 0) return t('devices.expired');
  const days = Math.ceil(seconds / 86400);
  return seconds >= 86400 ? t('devices.daysRemaining', { n: days }) : seconds >= 3600
    ? t('devices.hoursRemaining', { n: Math.ceil(seconds / 3600) }) : t('devices.minutesRemaining', { n: Math.ceil(seconds / 60) });
}

function DeviceSheet({ title, onClose, children, trapped = true, variant = 'sheet' }: { title: string; onClose: () => void; children: ReactNode; trapped?: boolean; variant?: 'sheet' | 'dialog' }) {
  const dialogRef = useRef<HTMLElement>(null); const closeRef = useRef<HTMLButtonElement>(null);
  const returnRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useBackButton(true, onClose);
  useModalFocusTrap({ active: trapped, dialogRef, initialFocusRef: closeRef, returnFocusRef: returnRef, onClose });
  const layer = <div className={`device-sheet-layer${variant === 'dialog' ? ' device-dialog-layer' : ''}`}>
    <div className="settings-backdrop" onClick={onClose} />
    <section className={`settings-card device-sheet${variant === 'dialog' ? ' device-dialog' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={dialogRef} tabIndex={-1}>
      <div className="settings-head"><h2 className="settings-title">{title}</h2><button className="settings-close" ref={closeRef} onClick={onClose} aria-label={t('common.close')}>×</button></div>
      <div className="settings-body">{children}</div>
    </section>
  </div>;
  return variant === 'dialog' ? <OverlayPortal>{layer}</OverlayPortal> : layer;
}
function ExpiryPicker({ value, custom, onChange, onCustom, keep = false, disabled = false }: {
  value: string; custom: string; onChange: (value: string) => void; onCustom: (value: string) => void; keep?: boolean; disabled?: boolean;
}) {
  return <div className="device-expiry-picker">
    <span id="device-expiry-label">{t('devices.expire')}</span>
    <div className="settings-btns" role="group" aria-labelledby="device-expiry-label">
      {[...(keep ? ['keep'] : []), '1h', '1d', '7d', '30d', 'custom', 'never'].map(v => <button key={v} type="button" className="fontbtn" disabled={disabled}
        aria-pressed={value === v} onClick={() => onChange(v)}>{['keep', 'custom', 'never'].includes(v) ? t(`devices.${v}`) : v}</button>)}
    </div>
    {value === 'custom' && <label>{t('devices.customDuration')}<input value={custom} placeholder="7d" disabled={disabled} onChange={event => onCustom(event.target.value)} autoCapitalize="none" autoCorrect="off" /></label>}
  </div>;
}
const validName = (name: string) => !!name.trim() && [...name.trim()].length <= 80 && !/[\x00-\x1f\x7f-\x9f]/.test(name);
const validExpire = (expire: string) => expire === 'never' || /^[1-9]\d*[mhd]$/.test(expire);
const APPROVAL_STORAGE_KEY = 'handmux.pendingApprovalId';
function readApprovalId(): string | null {
  try { const id = sessionStorage.getItem(APPROVAL_STORAGE_KEY); return id && /^pair_[a-zA-Z0-9_]+$/.test(id) ? id : null; } catch { return null; }
}
function storeApprovalId(id: string | null): void {
  // Only a public request identifier is stored. Neither the short code nor any credential is stored.
  try { if (id) sessionStorage.setItem(APPROVAL_STORAGE_KEY, id); else sessionStorage.removeItem(APPROVAL_STORAGE_KEY); } catch { /* No cross-tab guessing when storage is unavailable. */ }
}

function RevokeConfirm({ device, current, busy, error, onClose, onConfirm }: {
  device: ManagedDevice; current: boolean; busy: boolean; error: string; onClose: () => void; onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null); const cancelRef = useRef<HTMLButtonElement>(null);
  const returnRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useBackButton(true, () => { if (!busy) onClose(); });
  useModalFocusTrap({ active: true, dialogRef, initialFocusRef: cancelRef, returnFocusRef: returnRef, onClose: () => { if (!busy) onClose(); } });
  return <div className="auth-logout-backdrop device-revoke-layer"><section className="auth-logout-dialog" ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="device-revoke-title" aria-describedby="device-revoke-copy" tabIndex={-1}>
    <h3 id="device-revoke-title">{t(current ? 'devices.logout' : 'devices.revoke')}</h3>
    <p id="device-revoke-copy">{t('devices.revokeDescription', { name: device.name })}</p>
    {error && <p role="alert">{error}</p>}
    <div className="auth-logout-actions"><button ref={cancelRef} disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      <button disabled={busy} onClick={onConfirm}>{t(busy ? 'common.loading' : current ? 'devices.logout' : 'devices.revoke')}</button></div>
  </section></div>;
}

function OriginRemoveConfirm({ origin, devices, currentDeviceId, busy, error, onClose, onConfirm }: {
  origin: string;
  devices: Array<{ id: string; name: string; browser_summary: string }>;
  currentDeviceId: string | null;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null); const cancelRef = useRef<HTMLButtonElement>(null);
  const returnRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const currentImpact = devices.some(device => device.id === currentDeviceId);
  useBackButton(true, () => { if (!busy) onClose(); });
  useModalFocusTrap({ active: true, dialogRef, initialFocusRef: cancelRef, returnFocusRef: returnRef, onClose: () => { if (!busy) onClose(); } });
  return <div className="auth-logout-backdrop device-revoke-layer">
    <section className="auth-logout-dialog origin-remove-dialog" ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="origin-remove-title" aria-describedby={`origin-remove-copy${currentImpact ? ' origin-remove-current-impact' : ''}`} tabIndex={-1}>
      <h3 id="origin-remove-title">{t('devices.removeOriginTitle')}</h3>
      <p id="origin-remove-copy"><code className="origin-remove-value">{origin}</code></p>
      {devices.length > 0
        ? <><p>{t('devices.removeOriginImpact')}</p>{currentImpact && <p id="origin-remove-current-impact" className="origin-remove-current-warning" role="alert">{t('devices.removeOriginCurrentImpact')}</p>}<ul className="origin-remove-devices">{devices.map(device => <li key={device.id}><span className="origin-remove-device-name"><strong>{device.name}</strong>{device.id === currentDeviceId && <small className="device-current-badge">{t('devices.current')}</small>}</span><span>{device.browser_summary}</span></li>)}</ul></>
        : <p>{t('devices.removeOriginNoImpact')}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="auth-logout-actions"><button ref={cancelRef} disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
        <button className="device-danger" disabled={busy} onClick={onConfirm}>{t(busy ? 'common.loading' : 'devices.removeOriginConfirm')}</button></div>
    </section>
  </div>;
}

function DeviceDetail({ device: initial, current, now, onClose, onChanged, onLoggedOut }: {
  device: ManagedDevice; current: boolean; now: number; onClose: () => void; onChanged: () => void; onLoggedOut: () => void;
}) {
  const [device, setDevice] = useState(initial); const [name, setName] = useState(initial.name);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [conflict, setConflict] = useState(false);
  const [copyHint, setCopyHint] = useState(''); const [confirming, setConfirming] = useState(false); const idRef = useRef<HTMLElement>(null);
  const inactive = isInactive(device, now);
  const changed = name.trim() !== device.name;
  const close = () => { if (!busy) onClose(); };
  const save = async () => {
    if (!validName(name)) { setError(t('devices.invalidName')); return; }
    setBusy(true); setError('');
    try {
      const result = await api.edit(device.id, { version: device.version, name: name.trim() });
      setDevice(result.device); setName(result.device.name); setConflict(false); onChanged();
    } catch (e) { setError(deviceErrorCopy(e)); setConflict(e instanceof DeviceManagementError && e.code === 'DEVICE_CONFLICT'); }
    finally { setBusy(false); }
  };
  const refresh = async () => {
    setBusy(true);
    try { const result = await api.list(); const d = result.devices.find(d => d.id === device.id); if (!d) throw new Error('Device missing'); setDevice(d); setName(d.name); setConflict(false); setError(''); onChanged(); }
    catch (e) { setError(deviceErrorCopy(e)); } finally { setBusy(false); }
  };
  const revoke = async () => {
    setBusy(true); setError('');
    try { if (current) { await logoutDevice(); onLoggedOut(); } else { await api.revoke(device.id); onChanged(); onClose(); } }
    catch (e) { setError(current ? t('auth.logoutError') : deviceErrorCopy(e)); } finally { setBusy(false); }
  };
  const copyId = async () => {
    try { if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(device.id); setCopyHint(t('auth.copied')); }
    catch { if (idRef.current) { const range = document.createRange(); range.selectNodeContents(idRef.current); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); } setCopyHint(t('auth.manualCopy')); }
  };
  const statusText = device.revoked_at !== null ? t('devices.revoked') : device.expires_at !== null && device.expires_at <= now ? t('devices.expired') : t('devices.activeStatus');
  return <>
    <DeviceSheet title={t('devices.detailInfo')} onClose={close} trapped={!confirming}>
      <div className="device-edit-layout">
        {inactive ? <div className="device-readonly-field"><span className="device-field-label">{t('devices.name')}</span><strong>{device.name}</strong></div>
          : <label className="device-field"><span className="device-field-label">{t('devices.name')}</span><input value={name} onChange={event => setName(event.target.value)} maxLength={160} disabled={busy} /></label>}
        <dl className="device-readonly-metadata">
          <dt>{t('devices.deviceInfo')}</dt><dd>{device.browser_summary}</dd>
          <dt>{t('devices.status')}</dt><dd>{statusText}</dd>
          <dt>{t('devices.added')}</dt><dd>{date(device.authorized_at)}</dd>
          <dt>{t('devices.lastAccess')}</dt><dd>{date(device.last_used_at)}</dd>
          <dt>{t('devices.expiresAt')}</dt><dd>{date(device.expires_at)}</dd>
          <dt>{t('devices.id')}</dt><dd className="device-id-value"><code ref={idRef}>{device.id}</code><button type="button" className="device-copy-button" onClick={() => { void copyId(); }}>{t('devices.copyId')}</button></dd>
        </dl>
        {inactive && <p className="device-inactive-note">{t('devices.inactive')}</p>}
        {!inactive && <button className="fontbtn device-save" disabled={busy || !changed || conflict} onClick={() => { void save(); }}>{t('common.save')}</button>}
      </div>
      {copyHint && <p role="status">{copyHint}</p>}
      {!confirming && error && <p role="alert">{error}</p>}
      {conflict && <button disabled={busy} onClick={() => { void refresh(); }}>{t('devices.refreshDetails')}</button>}
      {!inactive && <div className="device-detail-actions"><button className="device-danger" disabled={busy} onClick={() => { setError(''); setConfirming(true); }}>{t(current ? 'devices.logout' : 'devices.revoke')}</button></div>}
    </DeviceSheet>
    {confirming && <RevokeConfirm device={device} current={current} busy={busy} error={error} onClose={() => setConfirming(false)} onConfirm={() => { void revoke(); }} />}
  </>;
}

function AddDevice({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [approval, setApproval] = useState<DeviceApproval | null>(null); const [code, setCode] = useState('');
  const [name, setName] = useState(''); const [expire, setExpire] = useState('30d'); const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(true); const [claimingCode, setClaimingCode] = useState(false); const [error, setError] = useState(''); const [now, setNow] = useState(Date.now());
  const offset = useRef(0); const mounted = useRef(true); const changing = useRef(true); const closeRequested = useRef(false); const approvalRef = useRef(approval); approvalRef.current = approval;
  const codeInputRef = useRef<HTMLInputElement>(null); const nameInputRef = useRef<HTMLInputElement>(null);
  const unknownClaim = useRef<string | null>(null); const initialized = useRef(false);
  const restoredId = useRef(readApprovalId());
  const complete = useRef(onAdded); complete.current = onAdded;
  const accept = (next: DeviceApproval, serverTime: number) => {
    offset.current = serverTime - Date.now(); setNow(serverTime); setApproval(next); approvalRef.current = next;
    if (next.state === 'configuring') { restoredId.current = next.id; storeApprovalId(next.id); }
    else { restoredId.current = null; storeApprovalId(null); }
    if (next.state === 'authorized') complete.current();
  };
  const close = async () => {
    if (changing.current) { closeRequested.current = true; return; }
    closeRequested.current = false;
    changing.current = true; setBusy(true); setError('');
    try {
      if (unknownClaim.current) {
        // The claim may have committed even though its response was lost. Repeating this same code
        // is idempotent for the owning Session; never close while its cancellation is unknown.
        try {
          const recovered = await api.claim(unknownClaim.current);
          unknownClaim.current = null; accept(recovered.approval, recovered.serverTime);
          if (recovered.approval.state === 'authorized') return;
        } catch (e) {
          if (!(e instanceof DeviceManagementError) || e.code !== 'CODE_INVALID') throw e;
          unknownClaim.current = null;
        }
      }
      if (!initialized.current) {
        if (restoredId.current) {
          try { const result = await api.approval(restoredId.current); accept(result.approval, result.serverTime); }
          catch (e) { if (!(e instanceof DeviceManagementError) || e.code !== 'PAIRING_NOT_FOUND') throw e; restoredId.current = null; storeApprovalId(null); }
        }
        initialized.current = true;
      }
      if (approvalRef.current?.state !== 'configuring') { storeApprovalId(null); onClose(); return; }
      const result = await api.cancel(approvalRef.current.id); storeApprovalId(null); if (result.approval.state === 'authorized') onAdded(); else onClose();
    }
    catch (e) { setError(deviceErrorCopy(e)); } finally { changing.current = false; setBusy(false); }
  };
  useEffect(() => {
    mounted.current = true;
    const restore = async () => {
      try {
        if (restoredId.current) {
          const result = await api.approval(restoredId.current);
          if (mounted.current) { accept(result.approval, result.serverTime); setName(result.approval.browserSummary); }
        }
        initialized.current = true;
      } catch (e) {
        if (e instanceof DeviceManagementError && e.code === 'PAIRING_NOT_FOUND') { restoredId.current = null; storeApprovalId(null); initialized.current = true; }
        if (mounted.current) setError(deviceErrorCopy(e));
      } finally { if (mounted.current) { changing.current = false; setBusy(false); if (closeRequested.current) void close(); } }
    };
    void restore();
    let polling = false;
    const poll = async () => {
      const pending = approvalRef.current;
      if (document.hidden || changing.current || polling || pending?.state !== 'configuring') return;
      polling = true;
      try { const result = await api.approval(pending.id); if (mounted.current && !changing.current) { accept(result.approval, result.serverTime); setError(''); } }
      catch (e) { if (mounted.current) setError(deviceErrorCopy(e)); } finally { polling = false; }
    };
    const timer = setInterval(() => { setNow(Date.now() + offset.current); void poll(); }, 1500);
    const resume = () => { if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', resume); window.addEventListener('focus', resume);
    return () => { mounted.current = false; clearInterval(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('focus', resume); };
  }, []);
  const retryRestore = async () => {
    if (!restoredId.current) return;
    changing.current = true; setBusy(true); setError('');
    try { const result = await api.approval(restoredId.current); accept(result.approval, result.serverTime); setName(result.approval.browserSummary); initialized.current = true; }
    catch (e) {
      if (e instanceof DeviceManagementError && e.code === 'PAIRING_NOT_FOUND') { restoredId.current = null; storeApprovalId(null); initialized.current = true; }
      setError(deviceErrorCopy(e));
    } finally { changing.current = false; setBusy(false); if (closeRequested.current) void close(); }
  };
  const claim = async (value = code) => {
    if (!initialized.current && restoredId.current) return;
    const submittedCode = unknownClaim.current ?? value;
    if (!/^\d{6}$/.test(submittedCode)) { setError(t('devices.invalidCode')); return; }
    if (changing.current || busy) return;
    changing.current = true; setBusy(true); setClaimingCode(true); setError('');
    unknownClaim.current = submittedCode;
    try { const result = await api.claim(submittedCode); unknownClaim.current = null; accept(result.approval, result.serverTime); setName(result.approval.browserSummary); setCode(''); }
    catch (e) {
      if (e instanceof DeviceManagementError && e.code === 'CODE_INVALID') {
        unknownClaim.current = null;
        setCode('');
      }
      setError(deviceErrorCopy(e));
    }
    finally { changing.current = false; setBusy(false); setClaimingCode(false); if (closeRequested.current) void close(); }
  };
  const authorize = async () => {
    const duration = expire === 'custom' ? custom : expire;
    if (!approval || !validName(name) || !validExpire(duration)) { setError(t(!validName(name) ? 'devices.invalidName' : 'devices.invalidExpire')); return; }
    changing.current = true; setBusy(true); setError('');
    try { await api.authorize(approval.id, { name: name.trim(), expire: duration }); storeApprovalId(null); onAdded(); }
    catch (e) { setError(deviceErrorCopy(e)); }
    finally { changing.current = false; setBusy(false); if (closeRequested.current) void close(); }
  };
  const remaining = Math.max(0, Math.ceil(((approval?.expiresAt ?? now) - now) / 1000));
  const restoreUnknown = !initialized.current && restoredId.current !== null;
  useEffect(() => {
    if (approval?.state === 'configuring' && !busy) nameInputRef.current?.focus();
    else if (!approval && !busy && !restoreUnknown && !unknownClaim.current) codeInputRef.current?.focus();
  }, [approval, busy, restoreUnknown]);
  const updateCode = (raw: string) => {
    if (unknownClaim.current || restoreUnknown || busy) return;
    const next = raw.replace(/\D/g, '').slice(0, 6);
    setCode(next);
    setError('');
    if (next.length === 6) void claim(next);
  };
  return <DeviceSheet title={approval?.state === 'configuring' ? t('devices.configureTitle') : t('devices.authorizeOther')} variant="dialog" onClose={() => { void close(); }}>
    {!approval ? <><div className={`device-code-entry${busy || restoreUnknown || !!unknownClaim.current ? ' is-disabled' : ''}`}>
        <label className="device-code-label" htmlFor="device-approval-code">{t('devices.code')}</label>
        <div className={`device-code-shell${error ? ' has-error' : ''}`}>
          <div className="device-code-slots" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => <span key={index} className={`device-code-slot${index === code.length && !busy ? ' is-current' : ''}`}>{code[index] ?? ''}</span>)}
          </div>
          <input ref={codeInputRef} id="device-approval-code" className="device-code-input" value={code} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} aria-describedby="device-code-hint" aria-invalid={Boolean(error)} onChange={e => updateCode(e.target.value)} disabled={busy || !!unknownClaim.current || restoreUnknown} />
        </div>
        <p id="device-code-hint" className="device-code-hint">{t('devices.codeHint')}</p>
        {error && <p className="device-code-error" role="alert">{error}</p>}
      </div>
      {restoreUnknown
        ? <button className="fontbtn" disabled={busy} onClick={() => { void retryRestore(); }}>{t('common.retry')}</button>
        : unknownClaim.current
          ? <button className="fontbtn" disabled={busy} onClick={() => { void claim(); }}>{t('common.retry')}</button>
          : null}</>
      : approval.state === 'configuring' ? <><p role="status">{t('auth.pending')}</p><p className="auth-secondary">{approval.browserSummary} · {t('auth.setupRemaining', { seconds: remaining })}</p>{approval.origin && <p className="device-approval-origin"><span>{t('devices.approvalOrigin')}</span><code>{approval.origin}</code></p>}
        <label className="device-field">{t('devices.name')}<input ref={nameInputRef} value={name} onChange={e => setName(e.target.value)} disabled={busy} maxLength={160} /></label>
        <ExpiryPicker value={expire} custom={custom} onChange={setExpire} onCustom={setCustom} disabled={busy} />
        <div className="device-form-actions">
          <button className="fontbtn device-save device-form-confirm" disabled={busy || remaining === 0} onClick={() => { void authorize(); }}>{t('devices.complete')}</button>
          <button className="fontbtn device-sheet-cancel" disabled={busy} onClick={() => { void close(); }}>{t('common.cancel')}</button>
        </div></>
      : <><p role="status">{t('devices.pairingGone')}</p><button className="fontbtn" disabled={busy} onClick={() => { setApproval(null); approvalRef.current = null; setError(''); }}>{t('devices.newCode')}</button></>}
    {approval && error && <p role="alert">{error}</p>}{busy && <p role="status">{claimingCode ? t('devices.verifyingCode') : t('common.loading')}</p>}
    {approval?.state !== 'configuring' && <button className="fontbtn sheet-cancel device-sheet-cancel" onClick={() => { void close(); }}>{t('common.cancel')}</button>}
  </DeviceSheet>;
}

export default function DeviceManagement({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [data, setData] = useState<DeviceList | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const [deviceTab, setDeviceTab] = useState<'active' | 'history'>('active'); const [selected, setSelected] = useState<ManagedDevice | null>(null); const [adding, setAdding] = useState(false);
  const [selfSheet, setSelfSheet] = useState(false); const [selfName, setSelfName] = useState(() => {
    const ua = navigator.userAgent;
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser';
    const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${browser} · ${os}` : browser;
  }); const [selfExpire, setSelfExpire] = useState('30d');
  const [selfCustom, setSelfCustom] = useState(''); const [busy, setBusy] = useState(false);
  const [originBusy, setOriginBusy] = useState(false);
  const [confirmEnable, setConfirmEnable] = useState<'device' | 'origin' | null>(null);
  const [originHelp, setOriginHelp] = useState<'public' | 'preview' | null>(null);
  const [originRemoval, setOriginRemoval] = useState<{ origin: string; devices: Array<{ id: string; name: string; browser_summary: string }> } | null>(null);
  const [now, setNow] = useState(Date.now()); const offset = useRef(0); const alive = useRef(true); const requestId = useRef(0);
  const load = useCallback(async () => {
    if (!isDeviceAuth()) return;
    const id = ++requestId.current; setLoading(true);
    try { const result = await api.list(); if (alive.current && id === requestId.current) { setData(result); offset.current = result.serverTime - Date.now(); setNow(result.serverTime); setError(''); } }
    catch (e) { if (alive.current && id === requestId.current) setError(deviceErrorCopy(e)); }
    finally { if (alive.current && id === requestId.current) setLoading(false); }
  }, []);
  useEffect(() => {
    alive.current = true; void load();
    const refresh = () => { if (!document.hidden) void load(); };
    const timer = setInterval(refresh, 30_000); const clock = setInterval(() => setNow(Date.now() + offset.current), 1000);
    document.addEventListener('visibilitychange', refresh); window.addEventListener('focus', refresh);
    return () => { alive.current = false; requestId.current++; clearInterval(timer); clearInterval(clock); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); };
  }, [load]);
  if (!isDeviceAuth()) return <p className="settings-detail-note">{t('auth.tokenWarning')}</p>;
  if (!data) return <section className="device-management device-management-state" aria-busy="true">
    {error ? <div className="device-feedback"><p role="alert">{error}</p><button type="button" disabled={loading} onClick={() => { void load(); }}>{t('common.retry')}</button></div>
      : <p className="device-loading" role="status">{t('common.loading')}</p>}
  </section>;
  const showingHistory = deviceTab === 'history';
  const devices = data.devices.filter(d => isInactive(d, now) === showingHistory).sort((a, b) => Number(b.id === data.currentDeviceId) - Number(a.id === data.currentDeviceId) || b.last_used_at - a.last_used_at);
  const addSelf = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await authRequest('/api/auth/pairing', 'POST');
      await api.addSelf(selfName, selfExpire === 'custom' ? selfCustom : selfExpire);
      const status = await authRequest(); applyAuthStatus(status);
      if (!status.currentDeviceId) { setError(t('devices.cookieRequired')); return; }
      setSelfSheet(false); await load();
    } catch (e) { setError(deviceErrorCopy(e)); } finally { setBusy(false); }
  };
  const inactiveCount = data.devices.filter(d => isInactive(d, now)).length;
  const activeCount = data.devices.length - inactiveCount;
  const currentOrigin = window.location.origin;
  const accessOrigin = data.publicUrl?.trim() || null;
  const previewOrigin = data.previewDomain?.trim() || null;
  const trustedDeviceEnabled = data.trustedDeviceEnabled !== false;
  const trustedOriginEnabled = data.trustedOriginEnabled !== false;
  const enableDeviceProtection = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await authRequest('/api/auth/pairing', 'POST');
      await api.addSelf(selfName, selfExpire === 'custom' ? selfCustom : selfExpire);
      await api.enableTrustedDevice();
      const status = await authRequest(); applyAuthStatus(status);
      await load();
    } catch (e) { setError(deviceErrorCopy(e)); } finally { setBusy(false); }
  };
  const enableOriginProtection = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { await api.enableTrustedOrigin(); const status = await authRequest(); applyAuthStatus(status); await load(); }
    catch (e) { setError(deviceErrorCopy(e)); } finally { setBusy(false); }
  };
  const removeTrustedOrigin = async (value: string) => {
    if (originBusy) return;
    setOriginBusy(true); setError('');
    try { const impact = await api.inspectTrustedOriginRemoval(value); setOriginRemoval({ origin: value, devices: impact.affectedDevices }); }
    catch (e) { setError(deviceErrorCopy(e)); }
    finally { setOriginBusy(false); }
  };
  const confirmRemoveTrustedOrigin = async () => {
    if (!originRemoval || originBusy) return;
    setOriginBusy(true); setError('');
    try { await api.removeTrustedOrigin(originRemoval.origin); setOriginRemoval(null); await load(); }
    catch (e) { setError(deviceErrorCopy(e)); }
    finally { setOriginBusy(false); }
  };
  return <section className="device-management">
    <section className="device-settings-group device-list-group" aria-labelledby="device-protection-title">
      <h2 id="device-protection-title">{t('devices.deviceProtectionSection')}</h2>
      <div className="settings-page-list device-policy-list">
        <div className="settings-page-row device-policy-row">
          <div className="device-policy-copy"><strong>{t('devices.deviceProtectionStatus')}</strong><span className={trustedDeviceEnabled ? 'device-policy-enabled' : 'device-policy-disabled'}>{t(trustedDeviceEnabled ? 'devices.policyEnabled' : 'devices.policyDisabled')}</span></div>
          {!trustedDeviceEnabled && <button type="button" className="fontbtn device-policy-enable" disabled={busy} onClick={() => setConfirmEnable('device')}>{t(busy ? 'common.loading' : 'devices.enableProtection')}</button>}
        </div>
      </div>
      {trustedDeviceEnabled && <p className="settings-detail-note device-policy-enabled-note">{t('devices.deviceProtectionEnabledHint')}</p>}
      {trustedDeviceEnabled && <>
      {!showingHistory && data.currentDeviceId && <button type="button" className="device-authorize-other" aria-label={t('devices.authorizeOther')} disabled={busy} onClick={() => setAdding(true)}>{t('devices.authorizeOther')}</button>}
      <h3 id="device-list-title">{t('devices.listTitle')}</h3>
      <div className="device-tabs" role="tablist" aria-label={t('devices.title')}>
        <button id="device-active-tab" role="tab" aria-selected={!showingHistory} aria-controls="device-list-panel" className="device-tab" onClick={() => setDeviceTab('active')}>{t('devices.activeTab')}<span>{activeCount}</span></button>
        <button id="device-history-tab" role="tab" aria-selected={showingHistory} aria-controls="device-list-panel" className="device-tab" onClick={() => setDeviceTab('history')}>{t('devices.historyTab')}<span>{inactiveCount}</span></button>
      </div>
      <div id="device-list-panel" role="tabpanel" aria-labelledby={showingHistory ? 'device-history-tab' : 'device-active-tab'}>
        {devices.length > 0 && <div className="settings-page-list">
          {devices.map(d => <button className="settings-page-row device-row" key={d.id} onClick={() => setSelected(d)}>
            <span className="device-row-copy"><span className="device-row-main"><span>{d.name}</span>{d.id === data.currentDeviceId && <small className="device-current-badge">{t('devices.current')}</small>}</span>
              <span className="device-row-secondary"><span>{d.browser_summary}</span><span>{remainingExpiry(d, now)}</span></span></span><span className="settings-page-chevron" aria-hidden="true">›</span>
          </button>)}
        </div>}
        {devices.length === 0 && <p className="device-empty" role="status">{t(showingHistory ? 'devices.noHistory' : 'devices.noActive')}</p>}
        {!showingHistory && !data.currentDeviceId && <div className="settings-page-list device-action-list">
          <button type="button" className="settings-page-row device-add-row" aria-label={t('devices.addSelf')} disabled={busy} onClick={() => setSelfSheet(true)}><span className="device-action-copy"><strong>{t('devices.addSelf')}</strong><small>{t('devices.addSelfAddress', { origin: currentOrigin })}</small></span><span className="settings-page-chevron" aria-hidden="true">›</span></button>
        </div>}
      </div>
      </>}
    </section>
    <section className="device-settings-group" aria-labelledby="device-origin-title">
      <h2 id="device-origin-title">{t('devices.accessSection')}</h2>
      <div className="settings-page-list device-policy-list">
        <div className="settings-page-row device-policy-row">
          <div className="device-policy-copy"><strong>{t('devices.originProtectionStatus')}</strong><span className={trustedOriginEnabled ? 'device-policy-enabled' : 'device-policy-disabled'}>{t(trustedOriginEnabled ? 'devices.policyEnabled' : 'devices.policyDisabled')}</span></div>
          {!trustedOriginEnabled && <button type="button" className="fontbtn device-policy-enable" disabled={busy} onClick={() => setConfirmEnable('origin')}>{t(busy ? 'common.loading' : 'devices.enableOriginProtection')}</button>}
        </div>
      </div>
      {trustedOriginEnabled && <p className="settings-detail-note device-policy-enabled-note">{t('devices.originProtectionEnabledHint')}</p>}
      {trustedOriginEnabled && <>
      <div className="settings-page-list device-origin-list">
        <div className="settings-page-row device-origin-row">
          <span className="device-origin-label"><b>{t('devices.publicUrlLabel')}</b> <button type="button" className="device-origin-help" aria-label={t('devices.publicUrlInfo')} onClick={() => setOriginHelp('public')}>?</button></span>
          <code className={`device-origin-value${accessOrigin ? '' : ' is-empty'}`}>{accessOrigin ?? t('devices.originUnset')}</code>
        </div>
        <div className="settings-page-row device-origin-row">
          <span className="device-origin-label"><b>{t('devices.previewDomainLabel')}</b> <button type="button" className="device-origin-help" aria-label={t('devices.previewDomainInfo')} onClick={() => setOriginHelp('preview')}>?</button></span>
          <code className={`device-origin-value${previewOrigin ? '' : ' is-empty'}`}>{previewOrigin ?? t('devices.originUnset')}</code>
        </div>
        {data.trustedOrigins?.map((origin, index) => <div className="settings-page-row device-origin-row device-origin-custom-row" key={origin}>
            <span className="device-origin-label"><b>{t('devices.trustedOriginLabel', { n: index + 1 })}</b></span>
            <code className="device-origin-value">{origin}</code>
            <button type="button" className="device-origin-remove" aria-label={`${t('common.delete')} ${origin}`} disabled={originBusy} onClick={() => { void removeTrustedOrigin(origin); }}>{t('common.delete')}</button>
        </div>)}
      </div>
      </>}
    </section>
    {error && <div className="device-feedback"><p role="alert">{error}</p><button type="button" disabled={loading} onClick={() => { void load(); }}>{t('common.retry')}</button></div>}
    {selected && <DeviceDetail key={selected.id} device={selected} current={selected.id === data?.currentDeviceId} now={now} onClose={() => setSelected(null)} onChanged={() => { void load(); }} onLoggedOut={onLoggedOut} />}
    {adding && <AddDevice onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void load(); }} />}
    {selfSheet && <DeviceSheet title={t('devices.addSelfTitle')} onClose={() => { if (!busy) setSelfSheet(false); }}><p className="device-sheet-note">{t('devices.addSelfOrigin', { origin: currentOrigin })}</p><label className="device-field">{t('devices.name')}<input disabled={busy} value={selfName} onChange={e => setSelfName(e.target.value)} /></label><ExpiryPicker value={selfExpire} custom={selfCustom} onChange={setSelfExpire} onCustom={setSelfCustom} disabled={busy} /><button className="fontbtn device-save" disabled={busy || !validName(selfName) || !validExpire(selfExpire === 'custom' ? selfCustom : selfExpire)} onClick={() => { void addSelf(); }}>{t(busy ? 'common.loading' : 'devices.addSelf')}</button>{error && <p role="alert">{error}</p>}</DeviceSheet>}
    {originHelp && <DeviceSheet title={originHelp === 'public' ? t('devices.publicUrlLabel') : t('devices.previewDomainLabel')} onClose={() => setOriginHelp(null)}><p className="device-sheet-note">{t(originHelp === 'public' ? 'devices.publicUrlInfo' : 'devices.previewDomainInfo')}</p></DeviceSheet>}
    {originRemoval && <OriginRemoveConfirm origin={originRemoval.origin} devices={originRemoval.devices} currentDeviceId={data.currentDeviceId} busy={originBusy} error={error} onClose={() => { if (!originBusy) { setOriginRemoval(null); setError(''); } }} onConfirm={() => { void confirmRemoveTrustedOrigin(); }} />}
    {confirmEnable && <div className="settings-confirm-backdrop" onClick={() => { if (!busy) setConfirmEnable(null); }}>
      <div className="settings-confirm" role="alertdialog" aria-modal="true" aria-labelledby="device-enable-confirm-title" onClick={event => event.stopPropagation()}>
        <h2 id="device-enable-confirm-title">{t('devices.enableConfirmTitle')}</h2>
        <p>{t(confirmEnable === 'device' ? 'devices.enableDeviceConfirm' : 'devices.enableOriginConfirm')}</p>
        <div className="settings-confirm-actions">
          <button type="button" disabled={busy} onClick={() => setConfirmEnable(null)}>{t('common.cancel')}</button>
          <button type="button" disabled={busy} onClick={() => { const kind = confirmEnable; setConfirmEnable(null); void (kind === 'device' ? enableDeviceProtection() : enableOriginProtection()); }}>{t(busy ? 'common.loading' : 'devices.enableConfirm')}</button>
        </div>
      </div>
    </div>}
  </section>;
}
