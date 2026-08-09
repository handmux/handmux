import { describe, expect, it } from 'vitest';
import { settleCodexOutgoing } from '../src/codexOutgoing.js';

const outgoing = (source = 'queue') => [{
  id: 'request-1', paneId: '%1', text: 'continue', source, status: 'sending',
}];

describe('Codex outgoing reconciliation', () => {
  it('does not turn an ambiguous transport timeout into a false failed message', () => {
    expect(settleCodexOutgoing(outgoing(), 'request-1', {
      error: new Error('/api/codex/send -> timeout'), uncertain: true,
    })).toEqual(outgoing());
  });

  it('keeps ordinary instant messages pending on an ambiguous transport failure', () => {
    expect(settleCodexOutgoing(outgoing('send'), 'request-1', {
      error: new Error('network lost'), uncertain: true,
    })).toEqual(outgoing('send'));
  });

  it('hands an acknowledged queue send to the exact server queue item', () => {
    expect(settleCodexOutgoing(outgoing(), 'request-1', {
      result: { queued: true, item: { id: 'queued-1' } },
    })[0]).toMatchObject({ status: 'queued', queueId: 'queued-1' });
  });

  it('removes a queue placeholder only after a definite server rejection', () => {
    expect(settleCodexOutgoing(outgoing(), 'request-1', {
      error: { status: 409, serverError: 'queue is full' }, uncertain: false,
    })).toEqual([]);
  });

  it('moves a queue-predicted send into chat if the server starts it immediately', () => {
    expect(settleCodexOutgoing(outgoing(), 'request-1', {
      result: { turn: { id: 'turn-1' } },
    })[0]).toMatchObject({ source: 'send', status: 'accepted' });
  });
});
