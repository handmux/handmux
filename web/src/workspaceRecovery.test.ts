import { describe, expect, it } from 'vitest';
import { recoveryPromptMode, recoveryReasonKey } from './workspaceRecovery.js';

const activePlan = (overrides = {}) => ({
  checkpointId: 'checkpoint-a',
  promptEligible: true,
  resolved: false,
  pendingCount: 2,
  summary: { sessions: 3 },
  ...overrides,
});

describe('workspace recovery prompt policy', () => {
  it.each([
    ['expired by server', { promptEligible: false, pendingCount: 2 }, {}, 'none'],
    ['ignored', activePlan(), { ignored: true }, 'none'],
    ['live sessions', activePlan(), { liveSessionCount: 1 }, 'card'],
    ['empty first visit', activePlan(), { liveSessionCount: 0, autoShown: false }, 'auto-dialog'],
    ['empty already shown', activePlan(), { liveSessionCount: 0, autoShown: true }, 'card'],
  ])('%s', (_label, plan, device, expected) => {
    expect(recoveryPromptMode(plan, device)).toBe(expected);
  });

  it.each([
    ['missing plan', null],
    ['resolved plan', activePlan({ resolved: true })],
    ['no pending sessions', activePlan({ pendingCount: 0 })],
  ])('hides a %s', (_label, plan) => {
    expect(recoveryPromptMode(plan)).toBe('none');
  });

  it('uses server promptEligible instead of reinterpreting expiresAt with the device clock', () => {
    const plan = activePlan({ expiresAt: '2000-01-01T00:00:00.000Z' });
    expect(recoveryPromptMode(plan, { liveSessionCount: 0 })).toBe('auto-dialog');
  });

  it('keeps a partial recovery visible while pendingCount is non-zero, regardless of total size', () => {
    expect(recoveryPromptMode(activePlan({ pendingCount: 1 }), { liveSessionCount: 2 })).toBe('card');
    expect(recoveryPromptMode(activePlan({ pendingCount: 0 }), { liveSessionCount: 2 })).toBe('none');
  });

  it('treats only literal true as ignored or autoShown in persisted device state', () => {
    expect(recoveryPromptMode(activePlan(), { ignored: 'false', liveSessionCount: 1 })).toBe('card');
    expect(recoveryPromptMode(activePlan(), { autoShown: 'false', liveSessionCount: 0 })).toBe('auto-dialog');
  });

  it.each([
    ['boot-changed', 'workspace.bootDetected'],
    ['tmux-changed', 'workspace.tmuxDetected'],
  ])('selects accurate copy for %s', (changeReason, expected) => {
    expect(recoveryReasonKey({ changeReason })).toBe(expected);
  });
});
