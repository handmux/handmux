import { describe, expect, it, vi } from 'vitest';
import { completedEntryAnchor, positionCompletedEntry } from './completedEntryAnchor.js';

const row = (
  key: string,
  durableAssistantText = false,
) => ({ key, durableAssistantText });

describe('completedEntryAnchor', () => {
  it('starts at the final durable assistant text in the authoritative latest tail', () => {
    expect(completedEntryAnchor([
      row('old-answer', true), row('thinking'), row('intermediate', true), row('tool'),
      row('plan'), row('final', true), row('goal'),
    ])).toEqual({ kind: 'target', key: 'final', edge: 'start' });
  });

  it('positions an assistant-only latest tail without reconstructing its user turn', () => {
    expect(completedEntryAnchor([row('final', true)]))
      .toEqual({ kind: 'target', key: 'final', edge: 'start' });
  });

  it('falls back when the latest tail has no completed assistant text', () => {
    expect(completedEntryAnchor([row('thinking'), row('tool')])).toEqual({ kind: 'fallback' });
  });

  it('positions either at a reply start or immediately after a trailing prompt', () => {
    const viewport = document.createElement('div');
    const user = document.createElement('div');
    const answer = document.createElement('div');
    user.dataset.completedEntryKey = 'user';
    answer.dataset.completedEntryKey = 'answer';
    viewport.append(user, answer);
    viewport.scrollTop = 40;
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(user, 'getBoundingClientRect').mockReturnValue({ top: 120, bottom: 180 } as DOMRect);
    vi.spyOn(answer, 'getBoundingClientRect').mockReturnValue({ top: 240, bottom: 300 } as DOMRect);

    expect(positionCompletedEntry(viewport, { kind: 'target', key: 'answer', edge: 'start' })).toBe(168);
    viewport.scrollTop = 40;
    expect(positionCompletedEntry(viewport, { kind: 'target', key: 'user', edge: 'after' })).toBe(108);
  });
});
