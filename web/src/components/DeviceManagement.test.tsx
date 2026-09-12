import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceManagement from './DeviceManagement.js';
import { DeviceManagementError, deviceManagementApi as api, type ManagedDevice, type DeviceApproval } from '../deviceManagementApi.js';
import { applyAuthStatus } from '../authSession.js';
import { t } from '../i18n';
vi.mock('../hooks/useBackButton.js', () => ({ useBackButton: vi.fn() }));
vi.mock('../hooks/useModalFocusTrap.js', () => ({ useModalFocusTrap: vi.fn() }));
const now = Date.now();
const current: ManagedDevice = { id: 'dev_current_full_id', name: 'My phone', browser_summary: 'Safari · iOS', authorized_at: now - 60_000, last_used_at: now - 1000, expires_at: now + 7 * 86400_000, revoked_at: null, status: 'active', version: 2 };
const other: ManagedDevice = { ...current, id: 'dev_other_full_id', name: 'Office', browser_summary: 'Chrome · Windows', last_used_at: now, version: 1 };
const history: ManagedDevice = { ...current, id: 'dev_history', name: 'Old phone', revoked_at: now - 1000, status: 'revoked' };
const approval: DeviceApproval = { id: 'pair_1', state: 'configuring', browserSummary: 'Firefox · Linux', source: 'web', expiresAt: now + 300_000 };
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
beforeEach(() => {
  sessionStorage.clear();
  applyAuthStatus({ mode: 'trusted-device', authenticated: true, serverTime: now });
  vi.spyOn(api, 'list').mockResolvedValue({ devices: [other, history, current], currentDeviceId: current.id, serverTime: now });
  vi.spyOn(api, 'approvals').mockResolvedValue({ approvals: [], serverTime: now });
  vi.spyOn(api, 'approval').mockResolvedValue({ approval, serverTime: now });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); applyAuthStatus({ mode: 'token', authenticated: false, serverTime: now }); });
describe('compact device management', () => {
  it('uses compact current-first rows, hides full IDs/times until details, and keeps history read-only', async () => {
    render(<DeviceManagement onLoggedOut={vi.fn()} />); await flush();
    const rows = document.querySelectorAll('.device-row'); expect(rows[0]?.textContent).toContain(current.name); expect(rows).toHaveLength(2);
    expect(screen.queryByText(current.id)).toBeNull(); expect(screen.queryByText(history.name)).toBeNull();
    expect(screen.getByText(t('devices.current'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('devices.selfRegistered') })).toBeNull();
    expect(screen.getByRole('button', { name: t('devices.authorizeOther') })).toBeTruthy();
    const activeTab = screen.getByRole('tab', { name: new RegExp(t('devices.activeTab')) });
    const historyTab = screen.getByRole('tab', { name: new RegExp(t('devices.historyTab')) });
    expect(activeTab.getAttribute('aria-selected')).toBe('true'); expect(activeTab.textContent).toContain('2');
    expect(historyTab.getAttribute('aria-selected')).toBe('false'); expect(historyTab.textContent).toContain('1');
    fireEvent.click(historyTab);
    expect(activeTab.getAttribute('aria-selected')).toBe('false'); expect(historyTab.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(history.name) }));
    expect(screen.getByText(history.id)).toBeTruthy(); expect(screen.getAllByText(history.browser_summary)).toHaveLength(2);
    expect(screen.queryByText(t('devices.activeStatus'))).toBeNull(); expect(screen.getAllByText(t('devices.revoked')).length).toBeGreaterThan(0);
    expect(screen.getByText(t('devices.detailInfo'))).toBeTruthy(); expect(screen.getByText(t('devices.name'))).toBeTruthy(); expect(screen.getByText(t('devices.deviceInfo'))).toBeTruthy();
    expect(screen.getByText(t('devices.status'))).toBeTruthy(); expect(screen.getByText(t('devices.added'))).toBeTruthy(); expect(screen.getByText(t('devices.lastAccess'))).toBeTruthy(); expect(screen.getByText(t('devices.expiresAt'))).toBeTruthy();
    expect(screen.queryByText(t('devices.expire'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('devices.revoke') })).toBeNull(); expect(screen.queryByRole('button', { name: t('common.save') })).toBeNull();
  });
  it('renames using the exact version without sending expire, and copies IDs with HTTP manual fallback', async () => {
    const edit = vi.spyOn(api, 'edit').mockResolvedValue({ device: { ...current, name: 'Personal phone', version: 3 }, serverTime: now });
    render(<DeviceManagement onLoggedOut={vi.fn()} />); await flush(); fireEvent.click(screen.getByRole('button', { name: new RegExp(current.name) }));
    fireEvent.change(screen.getByLabelText(t('devices.name')), { target: { value: 'Personal phone' } });
    fireEvent.click(screen.getByRole('button', { name: t('common.save') })); await flush();
    expect(edit).toHaveBeenCalledWith(current.id, { version: 2, name: 'Personal phone' });
    fireEvent.click(screen.getByRole('button', { name: t('devices.copyId') })); await flush();
    expect(screen.getByText(t('auth.manualCopy'))).toBeTruthy(); expect(window.getSelection()?.toString()).toBe(current.id);
  });
  it('shows an edit conflict without silently rebasing and requires explicit reload', async () => {
    const edit = vi.spyOn(api, 'edit').mockRejectedValue(new DeviceManagementError('DEVICE_CONFLICT', 409));
    render(<DeviceManagement onLoggedOut={vi.fn()} />); await flush(); fireEvent.click(screen.getByRole('button', { name: new RegExp(other.name) }));
    fireEvent.change(screen.getByLabelText(t('devices.name')), { target: { value: 'Different' } }); fireEvent.click(screen.getByRole('button', { name: t('common.save') })); await flush();
    expect(screen.getByRole('alert').textContent).toBe(t('devices.conflict')); expect((screen.getByRole('button', { name: t('common.save') }) as HTMLButtonElement).disabled).toBe(true);
    expect(edit).toHaveBeenCalledTimes(1); fireEvent.click(screen.getByRole('button', { name: t('devices.refreshDetails') })); await flush();
    expect((screen.getByLabelText(t('devices.name')) as HTMLInputElement).value).toBe(other.name);
  });
  it('claims a leading-zero code first, then authorizes only after name/expiry are completed', async () => {
    const claim = vi.spyOn(api, 'claim').mockResolvedValue({ approval, serverTime: now });
    const authorize = vi.spyOn(api, 'authorize').mockResolvedValue({ device: other, serverTime: now });
    render(<DeviceManagement onLoggedOut={vi.fn()} />); await flush(); fireEvent.click(screen.getByRole('button', { name: t('devices.authorizeOther') })); await flush();
    fireEvent.change(screen.getByLabelText(t('devices.code')), { target: { value: '038271' } }); fireEvent.click(screen.getByRole('button', { name: t('devices.claim') })); await flush();
    expect(claim).toHaveBeenCalledWith('038271'); expect(authorize).not.toHaveBeenCalled(); expect(screen.getByText(t('auth.pending'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('devices.name')), { target: { value: 'Linux computer' } }); fireEvent.click(screen.getByRole('button', { name: '7d' }));
    fireEvent.click(screen.getByRole('button', { name: t('devices.complete') })); await flush(); expect(authorize).toHaveBeenCalledWith(approval.id, { name: 'Linux computer', expire: '7d' });
  });
  it('resumes its claimed request after remount and cancellation must be confirmed by the server', async () => {
    sessionStorage.setItem('handmux.pendingApprovalId', approval.id);
    const cancel = vi.spyOn(api, 'cancel').mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ approval: { ...approval, state: 'canceled' }, serverTime: now });
    render(<DeviceManagement onLoggedOut={vi.fn()} />); await flush(); fireEvent.click(screen.getByRole('button', { name: t('devices.authorizeOther') })); await flush();
    expect(screen.queryByLabelText(t('devices.code'))).toBeNull(); expect((screen.getByLabelText(t('devices.name')) as HTMLInputElement).value).toBe(approval.browserSummary);
    expect(api.approval).toHaveBeenCalledWith(approval.id); expect(api.approvals).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') })); await flush(); expect(screen.getByRole('alert')).toBeTruthy(); expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') })); await flush(); expect(cancel).toHaveBeenCalledWith(approval.id); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('recovers a claim whose response was lost before confirming cancellation on close', async () => {
    const claim = vi.spyOn(api, 'claim').mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({ approval, serverTime: now });
    const cancel = vi.spyOn(api, 'cancel').mockResolvedValue({ approval: { ...approval, state: 'canceled' }, serverTime: now });
    render(<DeviceManagement onLoggedOut={vi.fn()} />); await flush(); fireEvent.click(screen.getByRole('button', { name: t('devices.authorizeOther') })); await flush();
    fireEvent.change(screen.getByLabelText(t('devices.code')), { target: { value: '038271' } }); fireEvent.click(screen.getByRole('button', { name: t('devices.claim') })); await flush();
    expect(screen.getByRole('alert')).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: t('common.cancel') })); await flush();
    expect(claim).toHaveBeenNthCalledWith(2, '038271'); expect(cancel).toHaveBeenCalledWith(approval.id); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('never picks another tab’s pending request when this tab has no request ID or storage is unavailable', async () => {
    vi.mocked(api.approvals).mockResolvedValue({ approvals: [approval], serverTime: now });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage denied'); });
    render(<DeviceManagement onLoggedOut={vi.fn()} />); await flush(); fireEvent.click(screen.getByRole('button', { name: t('devices.authorizeOther') })); await flush();
    expect(screen.getByLabelText(t('devices.code'))).toBeTruthy(); expect(screen.queryByLabelText(t('devices.name'))).toBeNull();
    expect(api.approvals).not.toHaveBeenCalled(); expect(api.approval).not.toHaveBeenCalled();
  });
  it('does not overwrite an unknown claim with a new code while retrying', async () => {
    const claim = vi.spyOn(api, 'claim').mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({ approval, serverTime: now });
    render(<DeviceManagement onLoggedOut={vi.fn()} />); await flush(); fireEvent.click(screen.getByRole('button', { name: t('devices.authorizeOther') })); await flush();
    fireEvent.change(screen.getByLabelText(t('devices.code')), { target: { value: '038271' } }); fireEvent.click(screen.getByRole('button', { name: t('devices.claim') })); await flush();
    expect((screen.getByLabelText(t('devices.code')) as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(t('devices.code')), { target: { value: '999999' } }); fireEvent.click(screen.getByRole('button', { name: t('common.retry') })); await flush();
    expect(claim.mock.calls.map(call => call[0])).toEqual(['038271', '038271']); expect((screen.getByLabelText(t('devices.name')) as HTMLInputElement).value).toBe(approval.browserSummary);
  });
  it('blocks new claims until a saved request has been recovered or confirmed gone', async () => {
    sessionStorage.setItem('handmux.pendingApprovalId', approval.id);
    vi.mocked(api.approval).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ approval, serverTime: now });
    const claim = vi.spyOn(api, 'claim');
    render(<DeviceManagement onLoggedOut={vi.fn()} />); await flush(); fireEvent.click(screen.getByRole('button', { name: t('devices.authorizeOther') })); await flush();
    expect((screen.getByLabelText(t('devices.code')) as HTMLInputElement).disabled).toBe(true); expect(screen.queryByRole('button', { name: t('devices.claim') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('common.retry') })); await flush();
    expect(api.approval).toHaveBeenNthCalledWith(2, approval.id); expect(claim).not.toHaveBeenCalled(); expect(screen.getByLabelText(t('devices.name'))).toBeTruthy();
  });
  it('does not replace a missing saved request with another pending request after restart', async () => {
    sessionStorage.setItem('handmux.pendingApprovalId', 'pair_previous');
    vi.mocked(api.approval).mockRejectedValue(new DeviceManagementError('PAIRING_NOT_FOUND', 404));
    vi.mocked(api.approvals).mockResolvedValue({ approvals: [approval], serverTime: now });
    render(<DeviceManagement onLoggedOut={vi.fn()} />); await flush(); fireEvent.click(screen.getByRole('button', { name: t('devices.authorizeOther') })); await flush();
    expect(screen.getByLabelText(t('devices.code'))).toBeTruthy(); expect(api.approval).toHaveBeenCalledWith('pair_previous');
    expect(api.approvals).not.toHaveBeenCalled(); expect(sessionStorage.getItem('handmux.pendingApprovalId')).toBeNull();
  });
  it('requires confirmation before removing another device and uses actual logout for the current device', async () => {
    const revoke = vi.spyOn(api, 'revoke').mockResolvedValue({ device: { ...other, status: 'revoked' }, serverTime: now });
    const loggedOut = vi.fn(); const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ mode: 'trusted-device', authenticated: false, serverTime: now }) })); vi.stubGlobal('fetch', fetcher);
    render(<DeviceManagement onLoggedOut={loggedOut} />); await flush(); fireEvent.click(screen.getByRole('button', { name: new RegExp(other.name) }));
    fireEvent.click(screen.getByRole('button', { name: t('devices.revoke') })); expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: t('devices.revoke') })); await flush(); expect(revoke).toHaveBeenCalledWith(other.id);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(current.name) })); fireEvent.click(screen.getByRole('button', { name: t('devices.logout') }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: t('devices.logout') })); await flush();
    expect(fetcher).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' })); expect(loggedOut).toHaveBeenCalledOnce();
  });
  it('trusted-device mode remains available when fixed token is disabled', async () => {
    applyAuthStatus({ mode: 'trusted-device', authenticated: true, tokenEnabled: false, serverTime: now }); render(<DeviceManagement onLoggedOut={vi.fn()} />); await flush();
    expect(api.list).toHaveBeenCalled(); expect(screen.queryByText('固定 Token 登录')).toBeNull();
  });
});

describe('fixed Token login retirement', () => {
  it('shows the list but requires this browser, even if other devices are trusted', async () => {
    vi.mocked(api.list).mockResolvedValue({ devices: [other], currentDeviceId: null, tokenEnabled: true, serverTime: now });
    render(<DeviceManagement onLoggedOut={vi.fn()} />); await flush();
    expect(screen.getByText(other.name)).toBeTruthy();
    expect((screen.getByRole('button', { name: t('devices.disableToken') }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: t('devices.addSelf') }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('confirms before disabling and removes the entire Token module after success', async () => {
    vi.mocked(api.list).mockResolvedValue({ devices: [current], currentDeviceId: current.id, tokenEnabled: true, serverTime: now });
    const disable = vi.spyOn(api, 'disableToken').mockResolvedValue({ mode: 'trusted-device', tokenEnabled: false, authenticated: true, serverTime: now });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ mode: 'trusted-device', authenticated: true, currentDeviceId: current.id, tokenEnabled: false, serverTime: now }) })));
    render(<DeviceManagement onLoggedOut={vi.fn()} />); await flush();
    fireEvent.click(screen.getByRole('button', { name: t('devices.disableToken') }));
    expect(disable).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog'); expect(dialog.textContent).toContain('handmux auth token enable');
    vi.mocked(api.list).mockResolvedValue({ devices: [current], currentDeviceId: current.id, tokenEnabled: false, serverTime: now });
    fireEvent.click(within(dialog).getByRole('button', { name: t('devices.disableToken') })); await flush();
    expect(disable).toHaveBeenCalledOnce(); expect(screen.queryByText(t('devices.fixedToken'))).toBeNull();
    expect(screen.getByText(current.name)).toBeTruthy();
  });
  it('does not report successful self-registration when the formal Cookie did not arrive', async () => {
    vi.mocked(api.list).mockResolvedValue({ devices: [], currentDeviceId: null, tokenEnabled: true, serverTime: now });
    vi.spyOn(api, 'addSelf').mockResolvedValue({ device: current, serverTime: now });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ mode: 'trusted-device', authenticated: true, currentDeviceId: null, tokenEnabled: true, serverTime: now }) })));
    render(<DeviceManagement onLoggedOut={vi.fn()} />); await flush();
    fireEvent.click(screen.getByRole('button', { name: t('devices.addSelf') }));
    const sheet = screen.getByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: t('devices.addSelf') })); await flush(); await flush();
    expect(within(sheet).getByRole('alert').textContent).toBe(t('devices.cookieRequired'));
    expect((screen.getByRole('button', { name: t('devices.disableToken') }) as HTMLButtonElement).disabled).toBe(true);
  });
});
