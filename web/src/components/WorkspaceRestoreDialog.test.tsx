import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';

import WorkspaceRestoreDialog from './WorkspaceRestoreDialog.jsx';
import type { WorkspaceRecoveryPlan, WorkspaceRestoreOperation } from '../workspaceRecovery.js';
import en from '../i18n/en.js';
import zh from '../i18n/zh.js';
import zhTW from '../i18n/zh-TW.js';
import ja from '../i18n/ja.js';
import ko from '../i18n/ko.js';
const styles = readFileSync('src/styles.css', 'utf8');

const plan = (overrides: Partial<WorkspaceRecoveryPlan> = {}): WorkspaceRecoveryPlan => ({
  checkpointId: 'checkpoint-a',
  capturedAt: '2026-07-20T01:42:00.000Z',
  changeReason: 'boot-changed',
  summary: { sessions: 3, windows: 5, panes: 8, agents: 2 },
  planSummary: { create: 1, renamed: 1, alreadyPresent: 1, unsupported: 0 },
  sessions: [
    { logicalId: 'session-api', sourceName: 'api', targetName: 'api', action: 'create' },
    { logicalId: 'session-web', sourceName: 'web', targetName: 'web-restored', action: 'create-renamed' },
    { logicalId: 'session-docs', sourceName: 'docs', action: 'already-present' },
  ],
  ...overrides,
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('WorkspaceRestoreDialog', () => {
  it('shows the checkpoint summary, rename rule, accurate boot reason, and non-destructive promise', () => {
    render(<WorkspaceRestoreDialog open plan={plan()} onClose={() => {}} onIgnore={() => {}} onRestore={() => {}} />);

    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('检测到电脑已重启')).toBeTruthy();
    expect(screen.getByText(/3 个会话 · 5 个窗口 · 8 个窗格/)).toBeTruthy();
    expect(screen.getByText(/将恢复 2 个会话；1 个已经存在/)).toBeTruthy();
    expect(screen.getByText(/web-restored/)).toBeTruthy();
    expect(screen.getByText('当前会话不会被修改、重命名或停止。')).toBeTruthy();
  });

  it('uses tmux-only copy without claiming the computer restarted', () => {
    render(<WorkspaceRestoreDialog open plan={plan({ changeReason: 'tmux-changed' })}
      onClose={() => {}} onIgnore={() => {}} onRestore={() => {}} />);
    expect(screen.getByText('检测到 tmux 已重新启动')).toBeTruthy();
    expect(screen.queryByText('检测到电脑已重启')).toBeNull();
  });

  it('counts only restored results in partial progress and shows localized per-session failures', () => {
    const operation: WorkspaceRestoreOperation = {
      status: 'partial',
      progress: { completed: 2, total: 3 },
      results: [
        { sourceName: 'api', status: 'restored' },
        { sourceName: 'web', status: 'failed', errorCode: 'tmux-unavailable', errorMessage: '/Users/secret must not render' },
      ],
    };
    render(<WorkspaceRestoreDialog open plan={plan()} onClose={() => {}} onIgnore={() => {}} onRestore={() => {}}
      operation={operation} />);
    expect(screen.getByText('已恢复 1 / 3')).toBeTruthy();
    expect(screen.getByText(/web：tmux 不可用；请确认 tmux 已运行后重试/)).toBeTruthy();
    expect(screen.queryByText(/Users\/secret/)).toBeNull();
  });

  it('renders top-level and per-session safe warning codes without raw server text', () => {
    const operation: WorkspaceRestoreOperation = {
      status: 'succeeded',
      progress: { completed: 2, total: 2 },
      warningCodes: ['live-reconcile-failed', 'workspace-unavailable'],
      warningMessage: '/Users/secret/top-level warning',
      results: [{
        sourceName: 'api', status: 'restored',
        warningCodes: ['cwd-fallback', 'layout-fallback', 'agent-warning', 'restore-warning'],
        warningMessage: '/Users/secret/per-result warning',
      }],
    };
    render(<WorkspaceRestoreDialog open plan={plan()} onClose={() => {}} onIgnore={() => {}} onRestore={() => {}}
      operation={operation} />);

    expect(screen.getByText(/实时工作区状态核对失败/)).toBeTruthy();
    expect(screen.getByText(/工作区存储暂时不可用/)).toBeTruthy();
    expect(screen.getByText(/api：工作目录不可用/)).toBeTruthy();
    expect(screen.getByText(/api：窗格布局无法完整恢复/)).toBeTruthy();
    expect(screen.getByText(/api：Agent 未能自动续接/)).toBeTruthy();
    expect(screen.getByText(/api：恢复时出现了可继续处理的提醒/)).toBeTruthy();
    expect(screen.queryByText(/Users\/secret/)).toBeNull();
  });

  it('guards a double tap synchronously before React can commit disabled state', () => {
    const onRestore = vi.fn(() => new Promise<void>(() => {}));
    render(<WorkspaceRestoreDialog open plan={plan()} onClose={() => {}} onIgnore={() => {}} onRestore={onRestore} />);
    const restore = screen.getByRole('button', { name: '恢复' });
    fireEvent.click(restore);
    fireEvent.click(restore);
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('focuses inside, traps Tab in both directions, and restores the trigger on close', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'open recovery';
    document.body.appendChild(trigger);
    trigger.focus();
    const { rerender } = render(<WorkspaceRestoreDialog open plan={plan()}
      onClose={() => {}} onIgnore={() => {}} onRestore={() => {}} />);
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: '关闭' });
    const ignore = screen.getByRole('button', { name: '忽略此备份' });
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(close);

    ignore.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    close.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(ignore);

    rerender(<WorkspaceRestoreDialog open={false} plan={plan()}
      onClose={() => {}} onIgnore={() => {}} onRestore={() => {}} />);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('accounts for top and bottom safe areas in dialog height and fixed actions', () => {
    expect(styles).toContain('max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 24px)');
    expect(styles).toContain('top: calc(env(safe-area-inset-top, 0px) + 12px)');
    expect(styles).toContain('bottom: calc(env(safe-area-inset-bottom, 0px) + 12px)');
    expect(styles).toMatch(/\.workspace-restore-actions\s*\{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom, 0px\)/s);
    expect(styles).toMatch(/\.workspace-restore-primary, \.workspace-restore-ignore\s*\{[^}]*min-height:\s*44px/s);
  });

  it('ships every workspace key in all five locales without English fallback', () => {
    const workspaceKeys = Object.keys(en).filter((key) => key.startsWith('workspace.')).sort();
    expect(workspaceKeys.length).toBeGreaterThan(20);
    for (const locale of [zh, zhTW, ja, ko]) {
      expect(Object.keys(locale).filter((key) => key.startsWith('workspace.')).sort()).toEqual(workspaceKeys);
    }
  });
});
