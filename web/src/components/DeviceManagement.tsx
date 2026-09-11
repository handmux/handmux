import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { deviceManagementApi as api, DeviceManagementError, type DeviceApproval, type DeviceList, type ManagedDevice } from '../deviceManagementApi.js';
import { isDeviceAuth, logoutDevice } from '../authSession.js';
import { useBackButton } from '../hooks/useBackButton.js';
import { useModalFocusTrap } from '../hooks/useModalFocusTrap.js';
import { t } from '../i18n';

export const deviceErrorCopy = (error: unknown): string => {
  const codes: Record<string, string> = {
    DEVICE_CONFLICT: 'devices.conflict', DEVICE_INACTIVE: 'devices.inactive', SESSION_INVALID: 'devices.sessionInvalid',
    CODE_INVALID: 'devices.invalidCode', CLAIM_RATE_LIMIT: 'auth.rateLimit', AUTH_RATE_LIMIT: 'auth.rateLimit',
    PAIRING_NOT_FOUND: 'devices.pairingGone', PAIRING_INACTIVE: 'devices.pairingGone',
    INVALID_NAME: 'devices.invalidName', INVALID_EXPIRE: 'devices.invalidExpire',
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

function DeviceSheet({ title, onClose, children, trapped = true }: { title: string; onClose: () => void; children: ReactNode; trapped?: boolean }) {
  const dialogRef = useRef<HTMLElement>(null); const closeRef = useRef<HTMLButtonElement>(null);
  const returnRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useBackButton(true, onClose);
  useModalFocusTrap({ active: trapped, dialogRef, initialFocusRef: closeRef, returnFocusRef: returnRef, onClose });
  return <div className="device-sheet-layer">
    <div className="settings-backdrop" onClick={onClose} />
    <section className="settings-card device-sheet" role="dialog" aria-modal="true" aria-label={title} ref={dialogRef} tabIndex={-1}>
      <div className="settings-head"><h2 className="settings-title">{title}</h2><button className="settings-close" ref={closeRef} onClick={onClose} aria-label={t('common.close')}>×</button></div>
      <div className="settings-body">{children}</div>
    </section>
  </div>;
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

function DeviceDetail({ device: initial, current, now, onClose, onChanged, onLoggedOut }: {
  device: ManagedDevice; current: boolean; now: number; onClose: () => void; onChanged: () => void; onLoggedOut: () => void;
}) {
  const [device, setDevice] = useState(initial); const [name, setName] = useState(initial.name);
  const [expire, setExpire] = useState('keep'); const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [conflict, setConflict] = useState(false);
  const [copyHint, setCopyHint] = useState(''); const [confirming, setConfirming] = useState(false); const idRef = useRef<HTMLElement>(null);
  const inactive = isInactive(device, now); const duration = expire === 'custom' ? custom : expire;
  const changed = name.trim() !== device.name || expire !== 'keep';
  const close = () => { if (!busy) onClose(); };
  const save = async () => {
    if (!validName(name) || !validExpire(duration) && expire !== 'keep') { setError(t(!validName(name) ? 'devices.invalidName' : 'devices.invalidExpire')); return; }
    setBusy(true); setError('');
    try {
      const result = await api.edit(device.id, { version: device.version, ...(name.trim() !== device.name ? { name: name.trim() } : {}), ...(expire !== 'keep' ? { expire: duration } : {}) });
      setDevice(result.device); setName(result.device.name); setExpire('keep'); setConflict(false); onChanged();
    } catch (e) { setError(deviceErrorCopy(e)); setConflict(e instanceof DeviceManagementError && e.code === 'DEVICE_CONFLICT'); }
    finally { setBusy(false); }
  };
  const refresh = async () => {
    setBusy(true);
    try { const result = await api.list(); const d = result.devices.find(d => d.id === device.id); if (!d) throw new Error('Device missing'); setDevice(d); setName(d.name); setExpire('keep'); setConflict(false); setError(''); onChanged(); }
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
  return <>
    <DeviceSheet title={device.name} onClose={close} trapped={!confirming}>
      {inactive ? <p>{remainingExpiry(device, now)}</p> : <>
        <label className="device-field">{t('devices.name')}<input value={name} onChange={event => setName(event.target.value)} maxLength={160} disabled={busy} /></label>
        <ExpiryPicker value={expire} custom={custom} onChange={setExpire} onCustom={setCustom} keep disabled={busy} />
        <p className="auth-secondary">{expire === 'keep' ? t('devices.keepHint') : t('devices.expireFromSave')}</p>
        <button className="fontbtn device-save" disabled={busy || !changed || conflict} onClick={() => { void save(); }}>{t('common.save')}</button>
      </>}
      <dl className="device-metadata"><dt>{t('devices.id')}</dt><dd><code ref={idRef}>{device.id}</code><button onClick={() => { void copyId(); }}>{t('devices.copyId')}</button></dd>
        <dt>{t('devices.browser')}</dt><dd>{device.browser_summary}</dd><dt>{t('devices.added')}</dt><dd>{date(device.authorized_at)}</dd>
        <dt>{t('devices.lastAccess')}</dt><dd>{date(device.last_used_at)}</dd><dt>{t('devices.expiresAt')}</dt><dd>{date(device.expires_at)}</dd></dl>
      {copyHint && <p role="status">{copyHint}</p>}
      {!confirming && error && <p role="alert">{error}</p>}
      {conflict && <button disabled={busy} onClick={() => { void refresh(); }}>{t('devices.refreshDetails')}</button>}
      {!inactive && <button className="device-danger" disabled={busy} onClick={() => { setError(''); setConfirming(true); }}>{t(current ? 'devices.logout' : 'devices.revoke')}</button>}
    </DeviceSheet>
    {confirming && <RevokeConfirm device={device} current={current} busy={busy} error={error} onClose={() => setConfirming(false)} onConfirm={() => { void revoke(); }} />}
  </>;
}

function AddDevice({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [approval, setApproval] = useState<DeviceApproval | null>(null); const [code, setCode] = useState('');
  const [name, setName] = useState(''); const [expire, setExpire] = useState('30d'); const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(true); const [error, setError] = useState(''); const [now, setNow] = useState(Date.now());
  const offset = useRef(0); const mounted = useRef(true); const changing = useRef(true); const closeRequested = useRef(false); const approvalRef = useRef(approval); approvalRef.current = approval;
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
  const claim = async () => {
    if (!initialized.current && restoredId.current) return;
    const submittedCode = unknownClaim.current ?? code;
    if (!/^\d{6}$/.test(submittedCode)) { setError(t('devices.invalidCode')); return; }
    changing.current = true; setBusy(true); setError('');
    unknownClaim.current = submittedCode;
    try { const result = await api.claim(submittedCode); unknownClaim.current = null; accept(result.approval, result.serverTime); setName(result.approval.browserSummary); setCode(''); }
    catch (e) { if (e instanceof DeviceManagementError && e.code === 'CODE_INVALID') unknownClaim.current = null; setError(deviceErrorCopy(e)); }
    finally { changing.current = false; setBusy(false); if (closeRequested.current) void close(); }
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
  return <DeviceSheet title={t('devices.add')} onClose={() => { void close(); }}>
    <p className="auth-secondary">{t('auth.antiPhishing')}</p>
    {!approval ? <><label className="device-field">{t('devices.code')}<input value={code} inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" maxLength={6} onChange={e => { if (!unknownClaim.current && !restoreUnknown) setCode(e.target.value.replace(/\D/g, '')); }} disabled={busy || !!unknownClaim.current || restoreUnknown} /></label>
      <p className="auth-secondary">{t('devices.codeHint')}</p>
      {restoreUnknown ? <button className="fontbtn" disabled={busy} onClick={() => { void retryRestore(); }}>{t('common.retry')}</button>
        : <button className="fontbtn" disabled={busy || code.length !== 6} onClick={() => { void claim(); }}>{t(unknownClaim.current ? 'common.retry' : 'devices.claim')}</button>}</>
      : approval.state === 'configuring' ? <><p role="status">{t('auth.pending')}</p><p className="auth-secondary">{approval.browserSummary} · {t('auth.setupRemaining', { seconds: remaining })}</p>
        <label className="device-field">{t('devices.name')}<input value={name} onChange={e => setName(e.target.value)} disabled={busy} maxLength={160} /></label>
        <ExpiryPicker value={expire} custom={custom} onChange={setExpire} onCustom={setCustom} disabled={busy} />
        <button className="fontbtn device-save" disabled={busy || remaining === 0} onClick={() => { void authorize(); }}>{t('devices.complete')}</button></>
      : <><p role="status">{t('devices.pairingGone')}</p><button className="fontbtn" disabled={busy} onClick={() => { setApproval(null); approvalRef.current = null; setError(''); }}>{t('devices.newCode')}</button></>}
    {error && <p role="alert">{error}</p>}{busy && <p role="status">{t('common.loading')}</p>}
    <button className="fontbtn sheet-cancel" onClick={() => { void close(); }}>{t('common.cancel')}</button>
  </DeviceSheet>;
}

export default function DeviceManagement({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [data, setData] = useState<DeviceList | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState(false); const [selected, setSelected] = useState<ManagedDevice | null>(null); const [adding, setAdding] = useState(false);
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
  useBackButton(history, () => setHistory(false));
  if (!isDeviceAuth()) return <p className="settings-detail-note">{t('auth.tokenWarning')}</p>;
  const devices = (data?.devices ?? []).filter(d => isInactive(d, now) === history).sort((a, b) => Number(b.id === data?.currentDeviceId) - Number(a.id === data?.currentDeviceId) || b.last_used_at - a.last_used_at);
  const inactiveCount = (data?.devices ?? []).filter(d => isInactive(d, now)).length;
  return <section className="device-management">
    <p className="settings-detail-note">{t('devices.modeReadOnly')}</p>
    {history && <button className="device-inline" onClick={() => setHistory(false)}>{t('devices.activeDevices')}</button>}
    <div className="settings-page-list">
      {devices.map(d => <button className="settings-page-row device-row" key={d.id} onClick={() => setSelected(d)}>
        <span className="device-row-copy"><span className="device-row-main"><span>{d.name}</span>{d.id === data?.currentDeviceId && <small>{t('devices.current')}</small>}</span>
          <span className="device-row-secondary"><span>{d.browser_summary}</span><span>{remainingExpiry(d, now)}</span></span></span><span className="settings-page-chevron" aria-hidden="true">›</span>
      </button>)}
      {!history && <button className="settings-page-row device-add-row" onClick={() => setAdding(true)}>＋ {t('devices.add')}</button>}
    </div>
    {history && devices.length === 0 && !loading && <p className="auth-secondary">{t('devices.noHistory')}</p>}
    {!history && inactiveCount > 0 && <button className="device-inline" onClick={() => setHistory(true)}>{t('devices.history', { n: inactiveCount })}</button>}
    {error && <><p role="alert">{error}</p><button disabled={loading} onClick={() => { void load(); }}>{t('common.retry')}</button></>}
    {loading && !data && <p role="status">{t('common.loading')}</p>}
    {selected && <DeviceDetail key={selected.id} device={selected} current={selected.id === data?.currentDeviceId} now={now} onClose={() => setSelected(null)} onChanged={() => { void load(); }} onLoggedOut={onLoggedOut} />}
    {adding && <AddDevice onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void load(); }} />}
  </section>;
}
