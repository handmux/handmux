import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../src/push.js', () => ({
  notifyEnabled: () => false, enableNotifications: vi.fn(), disableNotifications: vi.fn(), pushSupported: () => false,
}));
vi.mock('../src/api.js', () => ({ fetchPaneCwd: vi.fn(async () => ({ cwd: '/home/u/proj' })) }));

import Settings from '../src/components/Settings.jsx';
import { getLangCode } from '../src/i18n/index.js';
import en from '../src/i18n/en.js';
import zh from '../src/i18n/zh.js';
import zhTW from '../src/i18n/zh-TW.js';
import ja from '../src/i18n/ja.js';
import ko from '../src/i18n/ko.js';

const DICTS = { en, zh, 'zh-TW': zhTW, ja, ko };
const copy = (key) => (DICTS[getLangCode()] || en)[key];

let container; let root;
const termRef = { current: { getFontSize: () => ({ size: 14, auto: false }) } };
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });

const render = (workspaceProtection) => act(() => root.render(
  <Settings open onClose={() => {}} termRef={termRef}
    onColAdjust={() => {}} onColRestore={() => {}} onOpenChangelog={() => {}} changelogUnread={false}
    workspaceProtection={workspaceProtection} />,
));

describe('Settings workspace protection notice', () => {
  it('explains a writer lock that stopped capture, and names the holder', async () => {
    await render({ status: 'degraded', errorCode: 'writer-locked', blockedBy: 'restore-abc (pid 123)' });

    const alert = container.querySelector('.settings-page-alert');
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain(copy('workspace.protection.writer-locked'));
    // Not the catch-all reason: the code has to survive the reason mapping, or the notice says nothing useful.
    expect(alert.textContent).not.toContain(copy('workspace.protection.unknown'));
    expect(alert.textContent).toContain('restore-abc (pid 123)');
  });

  it('leaves the notice off while the workspace is protected', async () => {
    await render({ status: 'protected', errorCode: null });
    expect(container.querySelector('.settings-page-alert')).toBeNull();
  });
});
