import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent = [];
const optsSeen = []; // the options (incl. topic header) web-push was actually handed, per send
const failEndpoints = new Map();
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub, _data, opts) => {
      optsSeen.push(opts);
      if (failEndpoints.has(sub.endpoint)) {
        const status = failEndpoints.get(sub.endpoint);
        const e = new Error(status === 410 ? 'gone' : 'push service error');
        e.statusCode = status;
        throw e;
      }
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
  const mod = await import('../src/push.js');
  push = {
    ...mod,
    addSubscription: (subscription, ...args) => mod.addSubscription({
      ...subscription,
      keys: { p256dh: 'p', auth: 'a', ...subscription.keys },
    }, ...args),
  };
});

describe('push sendToAll and dead-endpoint pruning', () => {
  it('rejects a malformed browser subscription before persistence or delivery', () => {
    expect(push.parsePushSubscription({ endpoint: 'A', keys: {} })).toBeNull();
    expect(push.count()).toBe(0);
  });

  it('sendToAll delivers to every registered subscription', async () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, ['proj-a']);
    push.addSubscription({ endpoint: 'B', keys: {} }, ['proj-b']);
    const keyA = push.getPushKey('A');
    const keyB = push.getPushKey('B');
    const r = await push.sendToAll({ title: 't' }, {});
    expect(r.sent).toBe(2);
    expect(sent.sort()).toEqual(['A', 'B']);
    expect(r.deliveries).toEqual(expect.arrayContaining([
      { pushKey: keyA, status: 'success' },
      { pushKey: keyB, status: 'success' },
    ]));
    expect(fs.statSync(process.env.PUSH_STORE).mode & 0o777).toBe(0o600);
  });

  it('a 410 prunes the dead subscription from the store', async () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, ['proj-a']);
    push.addSubscription({ endpoint: 'B', keys: {} }, ['proj-b']);
    const keyB = push.getPushKey('B');
    failEndpoints.set('B', 410);
    const r = await push.sendToAll({ title: 't' }, {});
    expect(push.count()).toBe(1); // B was pruned on the failed send
    expect(r).toMatchObject({ sent: 1, failed: 1, gone: 1 });
    expect(r.deliveries).toContainEqual({ pushKey: keyB, status: 'failed', reason: 'expired' });
  });

  it('reports a non-expiry rejection without pruning the subscription', async () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, ['proj-a']);
    const keyA = push.getPushKey('A');
    failEndpoints.set('A', 503);
    const r = await push.sendToAll({ title: 't' }, {});
    expect(r).toMatchObject({ sent: 0, failed: 1, gone: 0 });
    expect(r.deliveries).toContainEqual({ pushKey: keyA, status: 'failed', reason: 'service_unavailable' });
    expect(push.count()).toBe(1);
  });

  it('classifies per-device failure reasons without inventing a partial state', () => {
    expect(push.classifyDeliveryFailure({ statusCode: 410 })).toBe('expired');
    expect(push.classifyDeliveryFailure({ statusCode: 429 })).toBe('rate_limited');
    expect(push.classifyDeliveryFailure({ statusCode: 503 })).toBe('service_unavailable');
    expect(push.classifyDeliveryFailure({ statusCode: 403 })).toBe('rejected');
    expect(push.classifyDeliveryFailure(new TypeError('fetch failed'))).toBe('network_error');
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

  it('moves a stable pushKey to a replacement browser subscription', async () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, ['proj-a']);
    const first = push.getPushKey('A');
    expect(push.addSubscription({ endpoint: 'B', keys: {} }, ['proj-b'], first)).toBe(first);

    expect(push.count()).toBe(1);
    expect(push.getPushKey('A')).toBeNull();
    expect(push.getPushKey('B')).toBe(first);
    const result = await push.sendToDevices([first], { title: 't', body: 'b' });
    expect(result.sent).toBe(1);
    expect(sent).toEqual(['B']);
  });

  it('ignores an invalid preferred pushKey', () => {
    const key = push.addSubscription({ endpoint: 'A', keys: {} }, [], 'not valid');
    expect(key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(key).not.toBe('not valid');
  });

  it('returns the stable pushKey when a subscription is removed', () => {
    push.addSubscription({ endpoint: 'A', keys: {} }, []);
    const key = push.getPushKey('A');
    expect(push.removeSubscription('A')).toBe(key);
    expect(push.removeSubscription('missing')).toBeNull();
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
