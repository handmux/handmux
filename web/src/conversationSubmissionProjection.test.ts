import { describe, expect, it } from 'vitest';
import {
  projectConversationActivity,
  projectConversationSubmissions,
  projectConversationTimeline,
  reconcileConversationSubmissionClaims,
  resolveConversationSubmissionClaims,
} from './conversationSubmissionProjection.js';
import type { AgentConversationViewItem } from './hooks/useAgentConversation.js';

const canonical = (id: string): AgentConversationViewItem => ({
  key: `canonical:${id}`,
  provisional: false,
  item: {
    id: `item:${id}`, sessionId: 'session-1', status: 'complete',
    kind: 'message', role: 'user', correlationId: id,
    content: [{ type: 'text', text: 'same text' }],
  },
});

const uncorrelated = (
  key: string,
  text = 'same text',
  sourceCreatedAt?: number,
): AgentConversationViewItem => ({
  key,
  provisional: false,
  item: {
    id: `item:${key}`, sessionId: 'session-1', status: 'complete',
    kind: 'message', role: 'user', content: [{ type: 'text', text }],
    ...(sourceCreatedAt === undefined ? {} : { sourceCreatedAt }),
  },
});

describe('conversation submission projection', () => {
  it('keeps one stable-id owner with canonical > Timeline outgoing > Queue priority', () => {
    const local = [{
      clientRequestId: 'submission-1', text: 'same text', owner: 'timeline' as const,
      status: 'sending' as const, createdAt: 1,
    }];
    const queue = [{ id: 'queue-1', requestId: 'submission-1', text: 'same text', createdAt: 1 }];

    expect(projectConversationSubmissions([], local, queue)).toEqual({ timeline: local, queue: [] });
    expect(projectConversationSubmissions([canonical('submission-1')], local, queue))
      .toEqual({ timeline: [], queue: [] });
  });

  it('does not merge identical text from different stable submissions', () => {
    const local = [{
      clientRequestId: 'submission-2', text: 'same text', owner: 'queue' as const,
      status: 'sending' as const, createdAt: 2,
    }];
    const queue = [{ id: 'queue-1', requestId: 'submission-1', text: 'same text', createdAt: 1 }];

    const result = projectConversationSubmissions([canonical('submission-1')], local, queue);
    expect(result.timeline).toEqual([]);
    expect(result.queue.map((item) => item.requestId)).toEqual(['submission-2']);
  });

  it('does not let assistant, tool, or notice correlations claim a user submission', () => {
    const local = [{
      clientRequestId: 'submission-1', text: 'pending user message', owner: 'timeline' as const,
      status: 'sending' as const, createdAt: 1,
    }];
    const nonUserCanonical: AgentConversationViewItem[] = [
      {
        key: 'canonical:assistant', provisional: false,
        item: {
          id: 'item:assistant', sessionId: 'session-1', status: 'complete',
          kind: 'message', role: 'assistant', correlationId: 'submission-1',
          content: [{ type: 'text', text: 'assistant response' }],
        },
      },
      {
        key: 'canonical:tool', provisional: false,
        item: {
          id: 'item:tool', sessionId: 'session-1', status: 'complete',
          kind: 'tool_call', callId: 'call-1', name: 'shell', correlationId: 'submission-1',
        },
      },
      {
        key: 'canonical:notice', provisional: false,
        item: {
          id: 'item:notice', sessionId: 'session-1', status: 'complete',
          kind: 'notice', level: 'info', message: 'working', correlationId: 'submission-1',
        },
      },
    ];

    expect(projectConversationSubmissions(nonUserCanonical, local, []).timeline).toEqual(local);
    const queued = local.map((entry) => ({ ...entry, owner: 'queue' as const }));
    expect(projectConversationSubmissions(nonUserCanonical, queued, []).queue).toEqual([
      expect.objectContaining({ requestId: 'submission-1', text: 'pending user message' }),
    ]);
  });

  it('replaces an optimistic Queue row with its durable row without duplicating it', () => {
    const local = [{
      clientRequestId: 'submission-1', text: 'queued', owner: 'queue' as const,
      status: 'accepted' as const, createdAt: 1,
    }];
    const durable = [{ id: 'queue-1', requestId: 'submission-1', text: 'queued', createdAt: 1 }];
    expect(projectConversationSubmissions([], local, durable).queue).toEqual(durable);
  });

  it('claims a baseline-protected uncorrelated occurrence in the render projection', () => {
    const history = uncorrelated('canonical:history');
    const tail: AgentConversationViewItem = {
      key: 'canonical:tail', provisional: false,
      item: {
        id: 'item:tail', sessionId: 'session-1', status: 'complete', kind: 'message',
        role: 'assistant', content: [{ type: 'text', text: 'tail' }],
      },
    };
    const live = uncorrelated('canonical:live');
    const local = [{
      clientRequestId: 'submission-1', text: 'same text', owner: 'timeline' as const,
      status: 'accepted' as const, createdAt: 10,
      baselineKeys: [history.key, tail.key], baselineTailKey: tail.key,
    }];

    // This pure projection is the render-before-effect frame: canonical already owns the occurrence.
    const projection = projectConversationSubmissions([history, tail, live], local, []);
    expect(projection.timeline).toEqual([]);
    expect(projectConversationTimeline([history, tail, live], projection.timeline)
      .filter(({ item }) => item.kind === 'message' && item.role === 'user')).toHaveLength(2);
  });

  it('does not let prepended historical same text cross the send baseline', () => {
    const older = uncorrelated('canonical:older', 'same text', 1);
    const tail: AgentConversationViewItem = {
      key: 'canonical:tail', provisional: false,
      item: {
        id: 'item:tail', sessionId: 'session-1', status: 'complete', kind: 'message',
        role: 'assistant', content: [{ type: 'text', text: 'tail' }],
      },
    };
    const local = [{
      clientRequestId: 'submission-1', text: 'same text', owner: 'timeline' as const,
      status: 'unknown' as const, createdAt: 10_000,
      baselineKeys: [tail.key], baselineTailKey: tail.key,
    }];

    expect(projectConversationSubmissions([older, tail], local, []).timeline).toEqual(local);
  });

  it('uses an explicit time boundary when a restored dispatch baseline was empty', () => {
    const historical = uncorrelated('canonical:historical', 'same text', 1);
    const current = uncorrelated('canonical:current', 'same text', 6_000);
    const local = [{
      clientRequestId: 'submission-1', text: 'same text', owner: 'timeline' as const,
      status: 'accepted' as const, createdAt: 10_000, baselineKeys: [] as string[],
      occurrenceNotBefore: 5_000,
    }];

    const claims = resolveConversationSubmissionClaims([historical, current], local);
    expect(claims.occurrenceKeys.get('submission-1')).toBe(current.key);
    expect(projectConversationSubmissions([historical], local, []).timeline).toEqual(local);
  });

  it('claims consecutive identical uncorrelated occurrences one-to-one', () => {
    const local = ['submission-1', 'submission-2'].map((clientRequestId, index) => ({
      clientRequestId, text: 'repeat', owner: 'timeline' as const,
      status: 'accepted' as const, createdAt: index + 1, baselineKeys: [] as string[],
    }));
    const first = uncorrelated('canonical:first-repeat', 'repeat');
    const second = uncorrelated('canonical:second-repeat', 'repeat');

    expect(projectConversationSubmissions([first], local, []).timeline
      .map((item) => item.clientRequestId)).toEqual(['submission-2']);
    expect(projectConversationSubmissions([first, second], local, []).timeline).toEqual([]);
  });

  it('retires an occurrence reservation when its canonical row leaves the retained window', () => {
    const firstAttempt = [{
      clientRequestId: 'submission-1', text: 'repeat', owner: 'timeline' as const,
      status: 'accepted' as const, createdAt: 1, baselineKeys: [] as string[],
    }];
    const firstCanonical = uncorrelated('canonical:first-repeat', 'repeat');
    const claimed = reconcileConversationSubmissionClaims([firstCanonical], firstAttempt);
    expect(claimed.local).toEqual([
      expect.objectContaining({ claimedCanonicalKey: firstCanonical.key }),
    ]);

    // Once the 1,000-item window drops that exact occurrence, the old attempt is terminally retired.
    expect(reconcileConversationSubmissionClaims([], claimed.local).local).toEqual([]);
    const secondAttempt = [{
      clientRequestId: 'submission-2', text: 'repeat', owner: 'timeline' as const,
      status: 'accepted' as const, createdAt: 2, baselineKeys: [] as string[],
    }];
    const secondCanonical = uncorrelated('canonical:second-repeat', 'repeat');
    const second = reconcileConversationSubmissionClaims([secondCanonical], secondAttempt);
    expect(second.local).toEqual([
      expect.objectContaining({
        clientRequestId: 'submission-2', claimedCanonicalKey: secondCanonical.key,
      }),
    ]);
    expect(projectConversationSubmissions([secondCanonical], second.local, []).timeline).toEqual([]);
  });

  it('keeps a steer outgoing at its click-time anchor while newer canonical rows arrive', () => {
    const first = canonical('first');
    const anchor = canonical('anchor');
    const newer = canonical('newer');
    const local = [{
      clientRequestId: 'steer-1', text: 'guide', owner: 'timeline' as const,
      status: 'sending' as const, createdAt: 1,
      anchor: { viewId: 'view-1', afterItemId: 'item:anchor' },
    }];

    expect(projectConversationTimeline([first, anchor], local).map((item) => item.key))
      .toEqual(['canonical:first', 'canonical:anchor', 'outgoing:steer-1']);
    expect(projectConversationTimeline([first, anchor, newer], local).map((item) => item.key))
      .toEqual(['canonical:first', 'canonical:anchor', 'outgoing:steer-1', 'canonical:newer']);
  });

  it('prefers the exact baseline tail over the durable anchor and falls back in order', () => {
    const first = canonical('first');
    const durable = canonical('durable');
    const baseline = canonical('baseline');
    const local = [{
      clientRequestId: 'steer-1', text: 'guide', owner: 'timeline' as const,
      status: 'sending' as const, createdAt: 1, baselineTailKey: baseline.key,
      anchor: { viewId: 'view-1', afterItemId: 'item:durable' },
    }];

    expect(projectConversationTimeline([first, durable, baseline], local).map((item) => item.key))
      .toEqual(['canonical:first', 'canonical:durable', 'canonical:baseline', 'outgoing:steer-1']);
    expect(projectConversationTimeline([first, durable], local).map((item) => item.key))
      .toEqual(['canonical:first', 'canonical:durable', 'outgoing:steer-1']);
    expect(projectConversationTimeline([first], local).map((item) => item.key))
      .toEqual(['canonical:first', 'outgoing:steer-1']);
  });

  it('keeps an explicit empty-transcript anchor before canonical rows that arrive later', () => {
    const local = [{
      clientRequestId: 'steer-empty', text: 'guide', owner: 'timeline' as const,
      status: 'sending' as const, createdAt: 1, baselineKeys: [] as string[],
      anchor: { viewId: 'view-1' },
    }];

    expect(projectConversationTimeline([], local).map((item) => item.key))
      .toEqual(['outgoing:steer-empty']);
    expect(projectConversationTimeline([canonical('newer')], local).map((item) => item.key))
      .toEqual(['outgoing:steer-empty', 'canonical:newer']);
  });

  it('appends after a non-empty baseline disappears without leaving a durable anchor', () => {
    const local = [{
      clientRequestId: 'steer-missing', text: 'guide', owner: 'timeline' as const,
      status: 'sending' as const, createdAt: 1,
      baselineKeys: ['canonical:gone'], baselineTailKey: 'canonical:gone',
      anchor: { viewId: 'view-1' },
    }];

    expect(projectConversationTimeline([canonical('newer')], local).map((item) => item.key))
      .toEqual(['canonical:newer', 'outgoing:steer-missing']);
  });

  it('projects an in-flight timeline steer as working only over idle or unknown activity', () => {
    const steer = (status: 'sending' | 'accepted' | 'failed' | 'unknown') => [{
      clientRequestId: 'steer-1', text: 'guide', delivery: 'steer' as const,
      owner: 'timeline' as const, status, createdAt: 1,
    }];

    expect(projectConversationActivity('idle', steer('sending'))).toBe('working');
    expect(projectConversationActivity('unknown', steer('sending'))).toBe('working');
    expect(projectConversationActivity('idle', steer('accepted'))).toBe('idle');
    expect(projectConversationActivity('unknown', steer('accepted'))).toBe('unknown');
    expect(projectConversationActivity('idle', steer('unknown'))).toBe('idle');
    expect(projectConversationActivity('unknown', steer('unknown'))).toBe('unknown');
    expect(projectConversationActivity('idle', steer('failed'))).toBe('idle');
    expect(projectConversationActivity('idle', [{ ...steer('sending')[0]!, owner: 'queue' }]))
      .toBe('idle');
    expect(projectConversationActivity('working', steer('sending'))).toBe('working');
    expect(projectConversationActivity('waiting', steer('sending'))).toBe('waiting');
    expect(projectConversationActivity('compacting', steer('sending'))).toBe('compacting');
  });
});
