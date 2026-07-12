import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent = [];
const optsSeen = []; // the options (incl. topic header) web-push was actually handed, per send
const failEndpoints = new Set();
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub, _data, opts) => {
      optsSeen.push(opts);
      if (failEndpoints.has(sub.endpoint)) { const e = new Error('gone'); e.statusCode = 410; throw e; }
      sent.push(sub.endpoint); return { statusCode: 201 };
    }),
  },
}));

// 隔离的临时 store + VAPID env，必须在 import push.js 之前设好。deliver() 只要配了 VAPID 就投递
// (不再用 NODE_ENV 区分 dev/prod),这里验证的就是配置即投递的路径。
process.env.VAPID_PUBLIC = 'pub';
process.env.VAPID_PRIVATE = 'priv';
process.env.PUSH_STORE = '/tmp/tmw-push-test.json';
import fs from 'node:fs';

let push;
beforeEach(async () => {
  sent.length = 0;
  optsSeen.length = 0;
  failEndpoints.clear();
  try { fs.unlinkSync('/tmp/tmw-push-test.json'); } catch {}
  vi.resetModules();
  push = await import('../src/push.js');
});

describe('push sendToAll and dead-endpoint pruning', () => {
  it('sendToAll delivers to every registered subscription', async () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, ['proj-a']);
    push.addSubscription({ endpoint: 'B', keys: {} }, ['proj-b']);
    const r = await push.sendToAll({ title: 't' }, {});
    expect(r.sent).toBe(2);
    expect(sent.sort()).toEqual(['A', 'B']);
  });

  it('a 410 prunes the dead subscription from the store', async () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, ['proj-a']);
    push.addSubscription({ endpoint: 'B', keys: {} }, ['proj-b']);
    failEndpoints.add('B');
    await push.sendToAll({ title: 't' }, {});
    expect(push.count()).toBe(1); // B was pruned on the failed send
  });
});

describe('push boundSessions routing', () => {
  it('sendToSession only hits subscriptions whose boundSessions include the session', async () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, ['proj-a']);
    push.addSubscription({ endpoint: 'B', keys: {} }, ['proj-b']);
    const r = await push.sendToSession('proj-a', { title: 't' }, {});
    expect(r.sent).toBe(1);
    expect(sent).toEqual(['A']);
  });

  it('updateBound changes which sessions a subscription receives', async () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, ['proj-a']);
    push.updateBound('A', ['proj-b']);
    const r = await push.sendToSession('proj-a', { title: 't' }, {});
    expect(r.sent).toBe(0);
  });
});

describe('push Topic header sanitization (RFC 8030 — URL-safe base64 only)', () => {
  it('strips a tmux pane id\'s % from a pane-derived topic so the send is not rejected', async () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, ['proj-a']);
    const r = await push.sendToSession('proj-a', { title: 't' }, { topic: 'pane-%4' });
    expect(r.sent).toBe(1);                       // delivered, not silently rejected
    expect(optsSeen[0].topic).toBe('pane-4');     // % stripped before reaching web-push
  });

  it('caps an over-long topic at 32 chars and drops a topic that sanitizes to empty', async () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, ['proj-a']);
    await push.sendToAll({ title: 't' }, { topic: 'p'.repeat(50) });
    expect(optsSeen[0].topic).toHaveLength(32);
    await push.sendToAll({ title: 't' }, { topic: '%%%' });
    expect(optsSeen[1].topic).toBeUndefined();
  });
});

describe('push device key + scoped sends', () => {
  it('addSubscription assigns a pushKey; getPushKey returns it', () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, ['proj-a']);
    const key = push.getPushKey('A');
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(16);
  });

  it('re-subscribing the same endpoint keeps the same pushKey', () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, ['proj-a']);
    const first = push.getPushKey('A');
    push.addSubscription({ endpoint: 'A', keys: {} }, ['proj-b']);
    expect(push.getPushKey('A')).toBe(first);
  });

  it('getPushKey lazy-generates for a legacy record with no key', () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, []);
    const key = push.getPushKey('A');
    expect(typeof key).toBe('string');
  });

  it('sendToDevices delivers only to subscriptions whose pushKey matches', async () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, []);
    push.addSubscription({ endpoint: 'B', keys: {} }, []);
    const keyA = push.getPushKey('A');
    const r = await push.sendToDevices([keyA], { title: 't', body: 'b' }, {});
    expect(r.sent).toBe(1);
    expect(sent).toEqual(['A']);
  });

  it('sendToSessions delivers to devices bound to ANY of the sessions, deduped', async () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, ['proj-a', 'proj-b']); // bound to both
    push.addSubscription({ endpoint: 'B', keys: {} }, ['proj-b']);
    const r = await push.sendToSessions(['proj-a', 'proj-b'], { title: 't', body: 'b' }, {});
    expect(r.sent).toBe(2);              // A once (not twice), B once
    expect(sent.sort()).toEqual(['A', 'B']);
  });
});
