import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('tw_notify', '1');
  localStorage.setItem('tw_bound', JSON.stringify(['proj-a', 'proj-b']));
  localStorage.setItem('tw_token', 'tok');
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  global.navigator.serviceWorker = { ready: Promise.resolve({ pushManager: { getSubscription: async () => ({ endpoint: 'E' }) } }) };
  global.window.PushManager = function () {};
  global.window.Notification = function () {};
});

afterEach(() => {
  vi.useRealTimers();
  delete global.navigator.serviceWorker;
});

describe('enableNotifications', () => {
  const response = (body = {}) => ({ ok: true, json: async () => body });
  const allowNotifications = () => {
    global.window.Notification.requestPermission = vi.fn(async () => 'granted');
    localStorage.setItem('tw_notify', '0');
  };

  it('completes the existing subscribe flow and records the device', async () => {
    allowNotifications();
    const subscription = { endpoint: 'NEW' };
    global.navigator.serviceWorker = {
      register: vi.fn(async () => {}),
      ready: Promise.resolve({
        pushManager: {
          getSubscription: vi.fn(async () => null),
          subscribe: vi.fn(async () => subscription),
        },
      }),
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response({ key: 'AQ' }))
      .mockResolvedValueOnce(response());

    const { enableNotifications } = await import('../src/push.js');
    await expect(enableNotifications()).resolves.toBe(true);

    expect(global.navigator.serviceWorker.register).toHaveBeenCalledWith('/sw.js');
    expect(localStorage.getItem('tw_notify')).toBe('1');
    const report = global.fetch.mock.calls.find(([url]) => url === '/api/push/subscribe');
    expect(JSON.parse(report[1].body)).toEqual({
      subscription,
      boundSessions: ['proj-a', 'proj-b'],
    });
  });

  it('returns control when the service worker never becomes ready', async () => {
    vi.useFakeTimers();
    allowNotifications();
    global.navigator.serviceWorker = {
      register: vi.fn(async () => {}),
      ready: new Promise(() => {}),
    };

    const { enableNotifications } = await import('../src/push.js');
    const result = enableNotifications();
    const assertion = expect(result).rejects.toMatchObject({ code: 'push.swTimeout' });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns control when the system permission prompt never resolves', async () => {
    vi.useFakeTimers();
    localStorage.setItem('tw_notify', '0');
    global.window.Notification.requestPermission = vi.fn(() => new Promise(() => {}));

    const { enableNotifications } = await import('../src/push.js');
    const result = enableNotifications();
    const assertion = expect(result).rejects.toMatchObject({ code: 'push.permissionTimeout' });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('aborts a stalled push-configuration request', async () => {
    vi.useFakeTimers();
    allowNotifications();
    global.navigator.serviceWorker = {
      register: vi.fn(async () => {}),
      ready: Promise.resolve({ pushManager: { getSubscription: vi.fn() } }),
    };
    global.fetch = vi.fn(() => new Promise(() => {}));

    const { enableNotifications } = await import('../src/push.js');
    const result = enableNotifications();
    const assertion = expect(result).rejects.toMatchObject({ code: 'push.configTimeout' });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('identifies a stalled browser push-service subscription', async () => {
    vi.useFakeTimers();
    allowNotifications();
    global.navigator.serviceWorker = {
      register: vi.fn(async () => {}),
      ready: Promise.resolve({
        pushManager: {
          getSubscription: vi.fn(async () => null),
          subscribe: vi.fn(() => new Promise(() => {})),
        },
      }),
    };
    global.fetch = vi.fn(async () => response({ key: 'AQ' }));

    const { enableNotifications } = await import('../src/push.js');
    const result = enableNotifications();
    const assertion = expect(result).rejects.toMatchObject({ code: 'push.browserTimeout' });
    await vi.advanceTimersByTimeAsync(20000);
    await assertion;
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts a stalled subscription report and identifies the server stage', async () => {
    vi.useFakeTimers();
    allowNotifications();
    global.navigator.serviceWorker = {
      register: vi.fn(async () => {}),
      ready: Promise.resolve({
        pushManager: { getSubscription: vi.fn(async () => ({ endpoint: 'NEW' })) },
      }),
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response({ key: 'AQ' }))
      .mockImplementationOnce((_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));

    const { enableNotifications } = await import('../src/push.js');
    const result = enableNotifications();
    const assertion = expect(result).rejects.toMatchObject({ code: 'push.reportTimeout' });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    expect(global.fetch.mock.calls[1][1].signal.aborted).toBe(true);
    expect(localStorage.getItem('tw_notify')).toBe('0');
  });

  it('surfaces the browser error when service-worker registration fails', async () => {
    allowNotifications();
    global.navigator.serviceWorker = {
      register: vi.fn(async () => { throw new TypeError('script has an unsupported MIME type'); }),
      ready: new Promise(() => {}),
    };

    const { enableNotifications } = await import('../src/push.js');
    await expect(enableNotifications()).rejects.toMatchObject({
      code: 'push.swRegisterFailed',
      message: expect.stringContaining('unsupported MIME type'),
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('unsubscribes a server-rejected expired subscription so the next tap starts fresh', async () => {
    allowNotifications();
    const subscription = { endpoint: 'STALE', unsubscribe: vi.fn(async () => true) };
    global.navigator.serviceWorker = {
      register: vi.fn(async () => {}),
      ready: Promise.resolve({
        pushManager: { getSubscription: vi.fn(async () => subscription) },
      }),
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response({ key: 'AQ' }))
      .mockResolvedValueOnce({ ok: false, status: 410, json: async () => ({ error: 'push subscription expired' }) });

    const { enableNotifications } = await import('../src/push.js');
    await expect(enableNotifications()).rejects.toMatchObject({ code: 'push.subscriptionExpired' });
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(localStorage.getItem('tw_notify')).toBe('0');
  });

  it('does not report enabled when the push service rejects welcome delivery', async () => {
    allowNotifications();
    const subscription = { endpoint: 'REJECTED', unsubscribe: vi.fn() };
    global.navigator.serviceWorker = {
      register: vi.fn(async () => {}),
      ready: Promise.resolve({
        pushManager: { getSubscription: vi.fn(async () => subscription) },
      }),
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(response({ key: 'AQ' }))
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ error: 'push delivery rejected' }) });

    const { enableNotifications } = await import('../src/push.js');
    await expect(enableNotifications()).rejects.toMatchObject({ code: 'push.deliveryRejected' });
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    expect(localStorage.getItem('tw_notify')).toBe('0');
  });
});

describe('reportBound', () => {
  it('POSTs the current bound set with the subscription endpoint', async () => {
    const { reportBound } = await import('../src/push.js');
    await reportBound();
    const call = global.fetch.mock.calls.find((c) => String(c[0]).includes('/api/push/bound'));
    expect(call).toBeTruthy();
    expect(JSON.parse(call[1].body)).toEqual({ endpoint: 'E', boundSessions: ['proj-a', 'proj-b'] });
  });

  it('no-ops when notifications are disabled', async () => {
    localStorage.setItem('tw_notify', '0');
    vi.resetModules();
    const { reportBound } = await import('../src/push.js');
    await reportBound();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('no-ops when there is no push subscription', async () => {
    global.navigator.serviceWorker = { ready: Promise.resolve({ pushManager: { getSubscription: async () => null } }) };
    const { reportBound } = await import('../src/push.js');
    await reportBound();
    const call = global.fetch.mock.calls.find((c) => String(c[0]).includes('/api/push/bound'));
    expect(call).toBeUndefined();
  });
});

describe('notification inbox failures', () => {
  const response = (ok, body = {}, status = ok ? 200 : 500) => ({ ok, status, json: async () => body });

  it('rejects a failed inbox load instead of turning it into an empty list', async () => {
    global.fetch = vi.fn(async (url) => String(url).includes('/api/push/key')
      ? response(true, { pushKey: 'K' })
      : response(false, {}, 503));
    const { getNotifications } = await import('../src/push.js');
    await expect(getNotifications()).rejects.toThrow();
  });

  it('rejects an unauthorized key lookup so App can return to the token prompt', async () => {
    global.fetch = vi.fn(async () => response(false, {}, 401));
    const { getNotifications } = await import('../src/push.js');
    const { UnauthorizedError } = await import('../src/api.js');
    await expect(getNotifications()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('keeps the Settings device-key lookup best-effort on the same auth failure', async () => {
    global.fetch = vi.fn(async () => response(false, {}, 401));
    const { getScriptPushKey } = await import('../src/push.js');
    await expect(getScriptPushKey()).resolves.toBeNull();
  });

  it('rejects a failed delete instead of reporting success to the optimistic UI', async () => {
    global.fetch = vi.fn(async (url) => String(url).includes('/api/push/key')
      ? response(true, { pushKey: 'K' })
      : response(false, {}, 503));
    const { deleteNotification } = await import('../src/push.js');
    await expect(deleteNotification('n1')).rejects.toThrow();
  });
});
