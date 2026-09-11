import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import hammerhead from 'testcafe-hammerhead';
import { createBrowserPreviewManager } from '../src/browser/manager.js';

const DEVICE = 'device-a';

function fakeHammerhead() {
  const proxies = [];
  class Session {
    constructor(_uploads, options) {
      this.options = options;
      this.cookies = new hammerhead.Session([]).cookies;
      this.requestHookEventProvider = {
        addRequestEventListeners: vi.fn((_rule, listeners) => {
          this.requestListeners = listeners;
        }),
      };
    }
  }
  class Proxy {
    constructor() {
      this.server1 = Object.assign(new EventEmitter(), {
        listening: true,
        address: () => ({ port: 41001 }),
      });
      this.server2 = Object.assign(new EventEmitter(), {
        listening: true,
        address: () => ({ port: 41002 }),
      });
      this.server1Info = {};
      this.server2Info = {};
      this.openSession = vi.fn((url, session) => `https://proxy.example/${session.id}/${url}`);
      this.closeSession = vi.fn();
      this.close = vi.fn();
      this.start = vi.fn();
      proxies.push(this);
    }
  }
  return {
    api: {
      Proxy,
      Session,
      ResponseMock: class {
        constructor(body, statusCode, headers) {
          Object.assign(this, { body, statusCode, headers });
        }
      },
      RequestFilterRule: { ANY: {} },
    },
    proxies,
  };
}

describe('browser proxy leases', () => {
  it('is idempotent by device and client tab id while sibling tabs use separate sessions', async () => {
    const fake = fakeHammerhead();
    const manager = await createBrowserPreviewManager({
      hammerhead: fake.api,
      randomChannel: vi.fn()
        .mockReturnValueOnce('channel-a')
        .mockReturnValueOnce('channel-b'),
    });

    const first = await manager.putLease({
      tabId: 'client-a',
      deviceId: DEVICE,
      url: 'https://app.example/path',
      origin: 'https://b-app.preview.example',
    });
    const repeated = await manager.putLease({
      tabId: 'client-a',
      deviceId: DEVICE,
      url: 'https://app.example/path',
      origin: 'https://b-app.preview.example',
    });
    const sibling = await manager.putLease({
      tabId: 'client-b',
      deviceId: DEVICE,
      url: 'https://app.example/other',
      origin: 'https://b-app.preview.example',
    });

    expect(repeated).toEqual(first);
    expect(sibling.channel).toBe('channel-b');
    expect(fake.proxies).toHaveLength(1);
    expect(fake.proxies[0].openSession).toHaveBeenCalledTimes(2);
    const [, firstSession] = fake.proxies[0].openSession.mock.calls[0];
    const [, siblingSession] = fake.proxies[0].openSession.mock.calls[1];
    expect(firstSession).not.toBe(siblingSession);
    expect(firstSession.cookies._cookieJar).toBe(siblingSession.cookies._cookieJar);
  });

  it('recreates one lease and aligns request headers and navigator when the site version changes', async () => {
    const fake = fakeHammerhead();
    const manager = await createBrowserPreviewManager({
      hammerhead: fake.api,
      targetPolicyFactory: () => ({ check: vi.fn(async () => ({ allowed: true })) }),
    });
    const input = {
      tabId: 'client-a',
      deviceId: DEVICE,
      url: 'https://app.example/',
      origin: 'https://b-app.preview.example',
      sourceUserAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
    };

    const mobile = await manager.putLease({ ...input, siteVersion: 'mobile' });
    const mobileSession = fake.proxies[0].openSession.mock.calls[0][1];
    const requestOptions = { headers: {
      'user-agent': input.sourceUserAgent,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Linux"',
    } };
    await mobileSession.requestListeners.onRequest({
      _requestInfo: { url: input.url, isAjax: false, headers: requestOptions.headers },
      requestOptions,
      setMock: vi.fn(),
    });

    expect(mobile.siteVersion).toBe('mobile');
    expect(requestOptions.headers['user-agent']).toContain('Android');
    expect(requestOptions.headers['sec-ch-ua-mobile']).toBe('?1');
    expect(await mobileSession.getPayloadScript()).toContain('profile.mobile');

    const desktop = await manager.putLease({ ...input, siteVersion: 'desktop' });
    expect(desktop.siteVersion).toBe('desktop');
    expect(fake.proxies[0].openSession).toHaveBeenCalledTimes(2);
    expect(fake.proxies[0].closeSession).toHaveBeenCalledWith(mobileSession);
  });

  it('deleting one lease revokes only its Hammerhead session', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeHammerhead();
      const manager = await createBrowserPreviewManager({ hammerhead: fake.api });
      const first = await manager.putLease({
        tabId: 'client-a', deviceId: DEVICE, url: 'https://app.example/a',
        origin: 'https://b-app.preview.example',
      });
      const second = await manager.putLease({
        tabId: 'client-b', deviceId: DEVICE, url: 'https://app.example/b',
        origin: 'https://b-app.preview.example',
      });

      expect(manager.deleteLease('client-a', DEVICE)).toBe(true);
      expect(manager.getLease('client-a', DEVICE)).toBeNull();
      expect(manager.getLease('client-b', DEVICE)).toEqual(second);
      expect(fake.proxies[0].closeSession).toHaveBeenCalledOnce();
      expect(fake.proxies[0].closeSession.mock.calls[0][0].id).toContain('client-a');
      expect(first.url).not.toBe(second.url);
      expect(fake.proxies[0].close).not.toHaveBeenCalled();
      expect(manager.deleteLease('client-b', DEVICE)).toBe(true);
      expect(fake.proxies[0].close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fake.proxies[0].close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears shared Cookies in place without invalidating open tab leases', async () => {
    const fake = fakeHammerhead();
    const manager = await createBrowserPreviewManager({ hammerhead: fake.api });
    await manager.putLease({
      tabId: 'client-a', deviceId: DEVICE, url: 'https://app.example/a',
      origin: 'https://b-app.preview.example',
    });
    const session = fake.proxies[0].openSession.mock.calls[0][1];
    session.cookies.setByServer('https://app.example/', ['session=value; Path=/']);

    await expect(manager.clearDeviceProfile(DEVICE, { origin: 'https://app.example' }))
      .resolves.toEqual({ closedTabIds: [] });

    expect(manager.getLease('client-a', DEVICE)).not.toBeNull();
    expect(session.cookies.getHeader({
      url: 'https://app.example/', hostname: 'app.example',
    })).toBeNull();
    expect(fake.proxies[0].closeSession).not.toHaveBeenCalled();
  });

  it('reuses an idle pool when a new lease arrives during the response-drain window', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeHammerhead();
      const manager = await createBrowserPreviewManager({ hammerhead: fake.api });
      await manager.putLease({
        tabId: 'first', deviceId: DEVICE, url: 'https://app.example/a',
        origin: 'https://b-app.preview.example',
      });
      manager.deleteLease('first', DEVICE);
      await vi.advanceTimersByTimeAsync(500);

      await manager.putLease({
        tabId: 'second', deviceId: DEVICE, url: 'https://app.example/b',
        origin: 'https://b-app.preview.example',
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(fake.proxies).toHaveLength(1);
      expect(fake.proxies[0].close).not.toHaveBeenCalled();
      manager.deleteLease('second', DEVICE);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fake.proxies[0].close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires idle leases only as resource cleanup', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeHammerhead();
      const manager = await createBrowserPreviewManager({
        hammerhead: fake.api,
        leaseTtlMs: 1_000,
      });
      await manager.putLease({
        tabId: 'client-a', deviceId: DEVICE, url: 'https://app.example/a',
        origin: 'https://b-app.preview.example',
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(manager.getLease('client-a', DEVICE)).toBeNull();
      expect(fake.proxies[0].closeSession).toHaveBeenCalledOnce();
      expect(fake.proxies[0].close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fake.proxies[0].close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates concurrent pool creation and concurrent puts for one lease', async () => {
    const fake = fakeHammerhead();
    const manager = await createBrowserPreviewManager({
      hammerhead: fake.api,
      randomChannel: () => 'channel-a',
    });
    const input = {
      tabId: 'client-a',
      deviceId: DEVICE,
      url: 'https://app.example/path',
      origin: 'https://b-app.preview.example',
    };

    const [first, second] = await Promise.all([
      manager.putLease(input),
      manager.putLease(input),
    ]);
    await Promise.all([
      manager.putLease({ ...input, tabId: 'client-b' }),
      manager.putLease({ ...input, tabId: 'client-c' }),
    ]);

    expect(second).toEqual(first);
    expect(fake.proxies).toHaveLength(1);
    expect(fake.proxies[0].openSession).toHaveBeenCalledTimes(3);
  });

  it('checks destinations against the real Handmux control origin, not the wildcard origin', async () => {
    const fake = fakeHammerhead();
    const targetPolicyFactory = vi.fn(() => ({
      check: vi.fn(async () => ({ allowed: true })),
    }));
    const manager = await createBrowserPreviewManager({
      hammerhead: fake.api,
      handmuxOrigin: 'https://handmux.example',
      targetPolicyFactory,
    });

    await manager.putLease({
      tabId: 'client-a',
      deviceId: DEVICE,
      url: 'https://app.example/',
      origin: 'https://b-app.preview.example',
    });

    expect(targetPolicyFactory).toHaveBeenCalledWith({
      topLevelUrl: 'https://app.example/',
      handmuxOrigin: 'https://handmux.example',
    });
  });

  it('pins every approved address and enables Node dual-stack connection fallback', async () => {
    const fake = fakeHammerhead();
    const approved = [
      { address: '::1', family: 6 },
      { address: '127.0.0.1', family: 4 },
    ];
    const manager = await createBrowserPreviewManager({
      hammerhead: fake.api,
      targetPolicyFactory: () => ({
        check: vi.fn(async () => ({ allowed: true, addresses: approved })),
      }),
    });
    await manager.putLease({
      tabId: 'client-a',
      deviceId: DEVICE,
      url: 'http://localhost:5173/',
      origin: 'https://b-local.preview.example',
    });
    const session = fake.proxies[0].openSession.mock.calls[0][1];
    const requestOptions = {};

    await session.requestListeners.onRequest({
      _requestInfo: {
        url: 'http://localhost:5173/',
        isAjax: true,
        headers: {},
      },
      requestOptions,
      setMock: vi.fn(),
    });

    expect(requestOptions.autoSelectFamily).toBe(true);
    await expect(new Promise((resolve, reject) => {
      requestOptions.lookup('localhost', { all: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses);
      });
    })).resolves.toEqual(approved);
  });

  it.each(['GET', 'POST'])('rehomes cross-origin top-level %s with method-preserving bootstrap', async (method) => {
    const fake = fakeHammerhead();
    const browserBootstrap = {
      issue: vi.fn(() => 'https://b-next.preview.example/_browser-bootstrap/ticket'),
    };
    const manager = await createBrowserPreviewManager({
      hammerhead: fake.api,
      previewDomain: 'preview.example',
      browserBootstrap,
      randomChannel: () => 'channel-a',
      targetPolicyFactory: () => ({
        check: vi.fn(async () => ({ allowed: true })),
      }),
    });
    await manager.putLease({
      tabId: 'client-a',
      deviceId: DEVICE,
      url: 'https://app.example/start',
      origin: 'https://b-app.preview.example',
    });
    const oldSession = fake.proxies[0].openSession.mock.calls[0][1];
    const setMock = vi.fn(async () => {});

    await oldSession.requestListeners.onRequest({
      _requestInfo: {
        url: 'https://next.example/continue',
        method,
        isAjax: false,
        headers: { 'sec-fetch-dest': 'document', accept: 'text/html' },
      },
      requestOptions: {},
      setMock,
    });

    expect(manager.getLease('client-a', DEVICE).originalUrl).toBe('https://next.example/continue');
    expect(browserBootstrap.issue).toHaveBeenCalledWith(expect.objectContaining({
      preserveMethod: true,
      redirectStatus: 307,
      deviceId: DEVICE,
    }));
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 307,
      headers: expect.objectContaining({
        location: 'https://b-next.preview.example/_browser-bootstrap/ticket',
      }),
    }));
    expect(fake.proxies[0].closeSession).toHaveBeenCalledWith(oldSession);
  });

  it('keeps a cross-origin nested iframe inside the current tab session', async () => {
    const fake = fakeHammerhead();
    const check = vi.fn(async () => ({ allowed: true }));
    const browserBootstrap = { issue: vi.fn() };
    const manager = await createBrowserPreviewManager({
      hammerhead: fake.api,
      previewDomain: 'preview.example',
      browserBootstrap,
      targetPolicyFactory: () => ({ check }),
    });
    await manager.putLease({
      tabId: 'client-a',
      deviceId: DEVICE,
      url: 'https://app.example/',
      origin: 'https://b-app.preview.example',
    });
    const session = fake.proxies[0].openSession.mock.calls[0][1];
    const setMock = vi.fn();

    await session.requestListeners.onRequest({
      _requestInfo: {
        url: 'https://frame.example/widget',
        method: 'get',
        isAjax: false,
        isIframe: true,
        headers: { 'sec-fetch-dest': 'iframe', accept: 'text/html' },
      },
      requestOptions: {},
      setMock,
    });

    expect(check).toHaveBeenCalledWith('https://frame.example/widget');
    expect(browserBootstrap.issue).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
    expect(manager.getLease('client-a', DEVICE).originalUrl).toBe('https://app.example/');
  });

  it('rejects a public page top-level redirect to loopback before rehoming', async () => {
    const fake = fakeHammerhead();
    const browserBootstrap = { issue: vi.fn() };
    const manager = await createBrowserPreviewManager({
      hammerhead: fake.api,
      previewDomain: 'preview.example',
      browserBootstrap,
    });
    await manager.putLease({
      tabId: 'client-a', deviceId: DEVICE, url: 'https://app.example/',
      origin: 'https://b-app.preview.example',
    });
    const session = fake.proxies[0].openSession.mock.calls[0][1];
    const setMock = vi.fn(async () => {});

    await session.requestListeners.onRequest({
      _requestInfo: {
        url: 'http://127.0.0.1:9222/json',
        isAjax: false,
        headers: { 'sec-fetch-dest': 'document' },
      },
      requestOptions: {},
      setMock,
    });

    expect(browserBootstrap.issue).not.toHaveBeenCalled();
    expect(manager.getLease('client-a', DEVICE).originalUrl).toBe('https://app.example/');
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('rejects automatic navigation from one explicitly opened loopback port to another', async () => {
    const fake = fakeHammerhead();
    const browserBootstrap = { issue: vi.fn() };
    const manager = await createBrowserPreviewManager({
      hammerhead: fake.api,
      previewDomain: 'preview.example',
      browserBootstrap,
    });
    await manager.putLease({
      tabId: 'client-a', deviceId: DEVICE, url: 'http://127.0.0.1:3000/',
      origin: 'https://b-local.preview.example',
    });
    const session = fake.proxies[0].openSession.mock.calls[0][1];
    await session.requestListeners.onRequest({
      _requestInfo: {
        url: 'http://127.0.0.1:3000/',
        isAjax: false,
        headers: { 'sec-fetch-dest': 'document' },
      },
      requestOptions: {},
      setMock: vi.fn(),
    });
    const setMock = vi.fn(async () => {});

    await session.requestListeners.onRequest({
      _requestInfo: {
        url: 'http://127.0.0.1:4000/',
        isAjax: false,
        headers: { 'sec-fetch-dest': 'document' },
      },
      requestOptions: {},
      setMock,
    });

    expect(browserBootstrap.issue).not.toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('starts when best-effort persisted-profile pruning fails', async () => {
    const fake = fakeHammerhead();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = await createBrowserPreviewManager({
      hammerhead: fake.api,
      profilePersistence: {
        pruneExpiredProfiles: vi.fn(async () => { throw new Error('profile directory unavailable'); }),
        read: vi.fn(async () => null),
        write: vi.fn(),
        remove: vi.fn(),
        readMetadata: vi.fn(async () => null),
        writeMetadata: vi.fn(),
        removeMetadata: vi.fn(),
        close: vi.fn(),
      },
    });

    await expect(manager.putLease({
      tabId: 'client-a', deviceId: DEVICE, url: 'https://app.example/',
      origin: 'https://b-app.preview.example',
    })).resolves.toMatchObject({ tabId: 'client-a' });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('cleanup deferred'));
    warning.mockRestore();
  });

  it('does not publish a lease that races with manager close on an existing pool', async () => {
    const fake = fakeHammerhead();
    const manager = await createBrowserPreviewManager({ hammerhead: fake.api });
    await manager.putLease({
      tabId: 'client-a', deviceId: DEVICE, url: 'https://app.example/a',
      origin: 'https://b-app.preview.example',
    });

    const pending = manager.putLease({
      tabId: 'client-b', deviceId: DEVICE, url: 'https://app.example/b',
      origin: 'https://b-app.preview.example',
    });
    await Promise.resolve();
    const closing = manager.close();

    await expect(pending).rejects.toThrow(/closing/);
    await closing;
    expect(manager.getLease('client-b', DEVICE)).toBeNull();
  });
});
