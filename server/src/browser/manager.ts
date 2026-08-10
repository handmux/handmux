import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as importedHammerhead from 'testcafe-hammerhead';
import { createDeviceCookieProfiles } from './cookieProfiles.js';
import { createBrowserProfilePersistence } from './profilePersistence.js';
import { claimPublicOrigin } from './originLabel.js';
import { browserLabelForOrigin } from './originLabel.js';
import { classifyIp, createBrowserTargetPolicy } from './targetPolicy.js';
import {
  hammerheadRebindHeaders,
  installHammerheadRebindLocationCompat,
} from './hammerheadRedirectCompat.js';
import {
  applySiteVersionHeaders,
  normalizeSiteVersion,
  siteVersionIdentity,
  siteVersionNavigatorScript,
} from './siteVersion.js';
import type { Server } from 'node:http';
import type { BrowserTargetDecision } from './targetPolicy.js';
import type { BrowserSiteIdentity, BrowserSiteVersion } from './siteVersion.js';
import type { CookieContainer } from './cookieProfiles.js';

interface HammerServerInfo {
  hostname: string;
  port: number;
  crossDomainPort: number;
  protocol: string;
  domain: string;
}
interface HammerSession {
  id: string;
  cookies: CookieContainer;
  requestHookEventProvider?: RequestHookProvider;
  addRequestEventListeners?: RequestHookProvider['addRequestEventListeners'];
  [key: string]: unknown;
}
interface RequestInfo {
  url: string;
  headers?: Record<string, unknown>;
  isAjax?: boolean;
  isIframe?: boolean;
}
interface RequestOptionsLike {
  headers?: Record<string, string | string[] | number | undefined>;
  autoSelectFamily?: boolean;
  lookup?: (...args: unknown[]) => unknown;
}
interface RequestEvent {
  _requestInfo: RequestInfo;
  requestOptions?: RequestOptionsLike;
  setMock(mock: unknown): unknown | Promise<unknown>;
}
interface RequestHookProvider {
  addRequestEventListeners(
    rule: unknown,
    listeners: { onRequest(event: RequestEvent): unknown | Promise<unknown> },
    errorHandler: (error: unknown) => void,
  ): void;
}
interface HammerSessionConstructor { new (...args: unknown[]): HammerSession }
interface HammerProxy {
  server1Info: HammerServerInfo;
  server2Info: HammerServerInfo;
  server1?: Server;
  server2?: Server;
  start(options: Record<string, unknown>): void;
  close(): void;
  closeSession(session: HammerSession): void;
  openSession(url: string, session: HammerSession): string;
}
interface HammerheadApi {
  Proxy: new () => HammerProxy;
  Session: HammerSessionConstructor;
  RequestFilterRule: { ANY: unknown };
  ResponseMock: new (body: string, status: number, headers: Record<string, string>) => unknown;
}
interface BrowserBootstrap {
  issue(input: {
    url: string;
    origin: string;
    deviceId: string;
    preserveMethod?: boolean;
    redirectStatus?: number;
  }): string;
}
type TimerHandle = ReturnType<typeof setTimeout> | number;
type SetTimer = (callback: () => void, delay: number) => TimerHandle;
type ClearTimer = (timer: TimerHandle) => void;
interface TargetPolicy {
  check(url: string): Promise<BrowserTargetDecision>;
}
interface BrowserPool {
  origin: string;
  proxy: HammerProxy;
  references: number;
  closeTimer: TimerHandle | null;
  ports: [number, number];
}
interface BrowserLease {
  key: string;
  tabId: string;
  deviceId: string;
  originalUrl: string;
  url: string;
  publicOrigin: string;
  channel: string;
  siteVersion: BrowserSiteVersion;
  sourceUserAgent: string;
  pool: BrowserPool;
  session: HammerSession;
  policy: TargetPolicy;
  detachCookies(): void;
  timer: TimerHandle | null;
  disposed: boolean;
}
interface PublicLease {
  tabId: string;
  url: string;
  originalUrl: string;
  channel: string;
  siteVersion: BrowserSiteVersion;
}
interface LeaseInput {
  tabId: string;
  deviceId: string;
  url: string;
  origin: string;
  siteVersion?: unknown;
  sourceUserAgent: string;
}
interface BrowserPreviewManagerOptions {
  hammerhead?: HammerheadApi;
  internalPorts?: [number, number];
  randomId?: () => string;
  randomChannel?: () => string;
  targetPolicyFactory?: (options: { topLevelUrl: string; handmuxOrigin: string }) => TargetPolicy;
  handmuxOrigin?: string;
  previewDomain?: string | null;
  browserBootstrap?: BrowserBootstrap | null;
  cookieProfiles?: ReturnType<typeof createDeviceCookieProfiles>;
  profilePersistence?: ReturnType<typeof createBrowserProfilePersistence>;
  profileDir?: string;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  leaseTtlMs?: number;
}

const hammerheadModule = importedHammerhead as unknown as HammerheadApi & { default?: HammerheadApi };
const defaultHammerhead = hammerheadModule.default || hammerheadModule;
const POOL_IDLE_CLOSE_MS = 1_000;

function normalizedOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('browser origin must use http or https');
  return url.origin;
}

function normalizedTarget(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('browser URL must use http or https');
  return url.toString();
}

function isLoopbackUrl(raw: string): boolean {
  const hostname = new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return hostname === 'localhost' || classifyIp(hostname) === 'loopback';
}

function bridgeScript(channel: string, identity: BrowserSiteIdentity): string {
  const encoded = JSON.stringify(channel);
  return `${siteVersionNavigatorScript(identity)}
  (() => {
    const channel = ${encoded};
    const hammerhead = window['%hammerhead%'];
    const destinationUrl = (url) => {
      try { return hammerhead?.utils?.url?.parseProxyUrl(url)?.destUrl || url; }
      catch { return url; }
    };
    const send = (type, url) => parent.postMessage({ source: 'handmux-browser', channel, type, url: url === undefined ? destinationUrl(location.href) : url, title: document.title }, '*');
    let pending = false;
    const activity = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; send('activity'); }, 250);
    };
    for (const name of ['pointerdown', 'keydown', 'input', 'scroll']) addEventListener(name, activity, { capture: true, passive: true });
    addEventListener('load', () => send('load'));
    addEventListener('popstate', () => send('urlchange'));
    addEventListener('hashchange', () => send('urlchange'));
    for (const name of ['pushState', 'replaceState']) {
      const original = history[name];
      history[name] = function (...args) {
        const result = original.apply(this, args);
        send('urlchange');
        return result;
      };
    }
    addEventListener('pagehide', () => send('navigate'));
    let lastTitle;
    let lastTitleUrl;
    const sendTitle = () => {
      const title = document.title;
      const url = destinationUrl(location.href);
      if (title === lastTitle && url === lastTitleUrl) return;
      lastTitle = title;
      lastTitleUrl = url;
      send('title', url);
    };
    const observeTitle = () => {
      if (!document.head) return;
      const observer = new MutationObserver(sendTitle);
      observer.observe(document.head, { subtree: true, childList: true, characterData: true });
      sendTitle();
    };
    if (document.head) observeTitle();
    else addEventListener('DOMContentLoaded', observeTitle, { once: true });
    addEventListener('message', (event) => {
      if (event.source !== parent || event.data?.source !== 'handmux-browser-parent' || event.data?.channel !== channel) return;
      if (event.data.command === 'back') history.back();
      else if (event.data.command === 'forward') history.forward();
      else if (event.data.command === 'reload') location.reload();
      else if (event.data.command === 'stop') window.stop();
    });
    send('ready');
  })();`;
}

function browserSessionClass(hammerhead: HammerheadApi) {
  return class BrowserSession extends hammerhead.Session {
    channel: string;
    identity: BrowserSiteIdentity;

    constructor(channel: string, identity: BrowserSiteIdentity) {
      super([], {
        disablePageCaching: true,
        allowMultipleWindows: true,
        windowId: channel,
        requestTimeout: { page: 30_000, ajax: 30_000 },
        nativeAutomation: false,
      });
      this.channel = channel;
      this.identity = identity;
    }

    async getPayloadScript(): Promise<string> { return bridgeScript(this.channel, this.identity); }
    async getIframePayloadScript(): Promise<string> { return siteVersionNavigatorScript(this.identity); }
    getAuthCredentials() { return null; }
    handleAttachment() {}
    handleFileDownload() {}
    handlePageError() {}
  };
}

function applyPublicOrigin(proxy: HammerProxy, origin: string): void {
  const url = new URL(origin);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  for (const info of [proxy.server1Info, proxy.server2Info]) {
    info.hostname = url.hostname;
    info.port = port;
    info.crossDomainPort = port;
    info.protocol = url.protocol;
    info.domain = url.origin;
  }
}

async function waitForListening(server: Server | undefined): Promise<void> {
  if (!server || server.listening || typeof server.once !== 'function') return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
      server.removeListener('close', onClose);
    };
    const onListening = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (): void => { cleanup(); reject(new Error('browser manager closing')); };
    server.once('listening', onListening);
    server.once('error', onError);
    server.once('close', onClose);
  });
}

function publicLease(lease: BrowserLease | null | undefined): PublicLease | null {
  if (!lease) return null;
  return {
    tabId: lease.tabId,
    url: lease.url,
    originalUrl: lease.originalUrl,
    channel: lease.channel,
    siteVersion: lease.siteVersion,
  };
}

export async function createBrowserPreviewManager({
  hammerhead = defaultHammerhead,
  internalPorts = [0, 0],
  randomId = () => randomBytes(18).toString('base64url'),
  randomChannel = () => randomBytes(18).toString('base64url'),
  targetPolicyFactory = createBrowserTargetPolicy,
  handmuxOrigin = 'http://127.0.0.1',
  previewDomain = null,
  browserBootstrap = null,
  cookieProfiles: suppliedCookieProfiles,
  profilePersistence: suppliedProfilePersistence,
  profileDir = path.join(os.homedir(), '.handmux', 'browser-profiles'),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  leaseTtlMs = 2 * 60 * 60 * 1000,
}: BrowserPreviewManagerOptions = {}) {
  installHammerheadRebindLocationCompat();
  const ProxyClass = hammerhead.Proxy;
  const SessionClass = browserSessionClass(hammerhead);
  const profilePersistence = suppliedProfilePersistence || createBrowserProfilePersistence({
    dir: profileDir,
    keyFile: path.join(profileDir, 'profile.key'),
  });
  try {
    await profilePersistence.pruneExpiredProfiles?.();
  } catch (error) {
    console.warn(`[handmux] browser profile retention cleanup deferred: ${error instanceof Error ? error.message : String(error)}`);
  }
  const cookieProfiles = suppliedCookieProfiles || createDeviceCookieProfiles({
    createCookies: () => new SessionClass('', siteVersionIdentity('mobile', '')).cookies,
    persistence: profilePersistence,
    setTimer,
    clearTimer,
  });
  const pools = new Map<string, BrowserPool>();
  const pendingPools = new Map<string, Promise<BrowserPool>>();
  const leases = new Map<string, BrowserLease>();
  const leaseQueues = new Map<string, Promise<unknown>>();
  const publicOriginClaims = new Map<string, string>();
  let poolCount = 0;
  let closing = false;
  let rehomeNavigation: (event: RequestEvent, session: HammerSession) => Promise<boolean> = async () => false;

  const leaseKey = (deviceId: string, tabId: string): string => `${deviceId}\u0000${tabId}`;
  const publicOriginFor = (target: string): string | null => {
    if (!previewDomain) return null;
    const base = new URL(/^https?:\/\//i.test(previewDomain) ? previewDomain : `https://${previewDomain}`);
    base.hostname = `${browserLabelForOrigin(new URL(target).origin)}.${base.hostname}`;
    return base.origin;
  };
  const serializeLease = <T>(key: string, operation: () => T | Promise<T>): Promise<T> => {
    const previous = leaseQueues.get(key) || Promise.resolve();
    const current = previous.then(operation);
    const queued = current.catch(() => {});
    leaseQueues.set(key, queued);
    return current.finally(() => {
      if (leaseQueues.get(key) === queued) leaseQueues.delete(key);
    });
  };
  const poolFor = async (origin: string): Promise<BrowserPool> => {
    const existingPool = pools.get(origin);
    if (existingPool) {
      const pool = existingPool;
      if (pool.closeTimer != null) clearTimer(pool.closeTimer);
      pool.closeTimer = null;
      pool.references += 1;
      return pool;
    }
    const existingPending = pendingPools.get(origin);
    if (existingPending) {
      const pool = await existingPending;
      pool.references += 1;
      return pool;
    }
    const pending = (async () => {
      const proxy = new ProxyClass();
      const ports = poolCount++ === 0 ? internalPorts : [0, 0];
      try {
        proxy.start({
          hostname: '127.0.0.1',
          port1: ports[0],
          port2: ports[1],
          disableCrossDomain: true,
          disableHttp2: true,
        });
        await Promise.all([waitForListening(proxy.server1), waitForListening(proxy.server2)]);
        if (closing) throw new Error('browser manager closing');
        applyPublicOrigin(proxy, origin);
        const firstPort = proxy.server1?.address();
        const secondPort = proxy.server2?.address();
        const pool: BrowserPool = {
          origin,
          proxy,
          references: 0,
          closeTimer: null,
          ports: [
            firstPort && typeof firstPort !== 'string' ? firstPort.port : ports[0],
            secondPort && typeof secondPort !== 'string' ? secondPort.port : ports[1],
          ],
        };
        pools.set(origin, pool);
        return pool;
      } catch (error) {
        proxy.close();
        throw error;
      }
    })();
    pendingPools.set(origin, pending);
    try {
      const pool = await pending;
      pool.references += 1;
      return pool;
    } finally {
      if (pendingPools.get(origin) === pending) pendingPools.delete(origin);
    }
  };

  const releasePool = (pool: BrowserPool | null | undefined): void => {
    if (!pool || pool.references <= 0) return;
    pool.references -= 1;
    if (pool.references !== 0) return;
    // A request hook can replace the final lease while the old pool is still writing its redirect.
    // Close after a short idle window so that response can drain; a new lease for the same origin reuses
    // the pool and cancels this timer. This still releases idle Hammerhead ports without worker shutdown.
    pool.closeTimer = setTimer(() => {
      pool.closeTimer = null;
      if (pool.references !== 0) return;
      if (pools.get(pool.origin) === pool) pools.delete(pool.origin);
      publicOriginClaims.delete(pool.origin);
      pool.proxy.close();
    }, POOL_IDLE_CLOSE_MS);
  };

  const disposeLease = (lease: BrowserLease | null | undefined): void => {
    if (!lease || lease.disposed) return;
    lease.disposed = true;
    if (lease.timer != null) clearTimer(lease.timer);
    lease.timer = null;
    lease.detachCookies();
    lease.pool.proxy.closeSession(lease.session);
    releasePool(lease.pool);
  };

  const setDeviceActive = (deviceId: string): void => cookieProfiles.setActive?.(
    deviceId,
    [...leases.values()].some((lease) => lease.deviceId === deviceId),
  );
  const release = (lease: BrowserLease | null | undefined): boolean => {
    if (!lease || leases.get(lease.key) !== lease) return false;
    leases.delete(lease.key);
    disposeLease(lease);
    setDeviceActive(lease.deviceId);
    return true;
  };
  const touch = (lease: BrowserLease): void => {
    if (lease.timer != null) clearTimer(lease.timer);
    lease.timer = setTimer(() => release(lease), leaseTtlMs);
  };
  const createLease = async ({
    tabId, deviceId, url, origin, channel, siteVersion, sourceUserAgent,
  }: LeaseInput & { channel: string; siteVersion: BrowserSiteVersion }): Promise<BrowserLease> => {
    if (closing) throw new Error('browser manager closing');
    const target = normalizedTarget(url);
    const publicOrigin = normalizedOrigin(origin);
    const targetOrigin = new URL(target).origin;
    claimPublicOrigin(publicOriginClaims, publicOrigin, targetOrigin);
    const pool = await poolFor(publicOrigin);
    let session: HammerSession | null = null;
    let detachCookies: (() => void) | null = null;
    try {
      if (closing) throw new Error('browser manager closing');
      const identity = siteVersionIdentity(siteVersion, sourceUserAgent);
      const createdSession = new SessionClass(channel, identity);
      session = createdSession;
      createdSession.id = `_browser-${randomId()}-${encodeURIComponent(tabId)}`;
      const policy = targetPolicyFactory({ topLevelUrl: target, handmuxOrigin });
      const hooks = createdSession.requestHookEventProvider || createdSession;
      if (typeof hooks.addRequestEventListeners !== 'function') {
        throw new Error('browser request hooks unavailable');
      }
      hooks.addRequestEventListeners(hammerhead.RequestFilterRule.ANY, {
        onRequest: async (event: RequestEvent) => {
          if (await rehomeNavigation(event, createdSession)) return;
          const result = await policy.check(event._requestInfo.url);
          if (result.allowed) {
            if (event.requestOptions?.headers) {
              applySiteVersionHeaders(event.requestOptions.headers, identity);
            }
            if (result.addresses?.length && event.requestOptions) {
              const approved = result.addresses.map(({ address, family }) => ({ address, family }));
              event.requestOptions.autoSelectFamily = true;
              event.requestOptions.lookup = (_hostname: unknown, options: unknown, callback: unknown) => {
                if (typeof callback !== 'function') throw new Error('browser DNS callback unavailable');
                const all = Boolean(options && typeof options === 'object' && 'all' in options && options.all);
                if (all) callback(null, approved);
                else {
                  const first = approved[0];
                  if (!first) return callback(new Error('browser DNS result unavailable'));
                  callback(null, first.address, first.family);
                }
              };
            }
            return;
          }
          await event.setMock(new hammerhead.ResponseMock(
            JSON.stringify({ error: 'browser target blocked', reason: result.reason }),
            403,
            { 'content-type': 'application/json; charset=utf-8' },
          ));
        },
      }, () => {});
      detachCookies = cookieProfiles.attach(deviceId, createdSession.cookies);
      const publicUrl = pool.proxy.openSession(target, createdSession);
      return {
        key: leaseKey(deviceId, tabId),
        tabId,
        deviceId,
        originalUrl: target,
        url: publicUrl,
        publicOrigin,
        channel,
        siteVersion,
        sourceUserAgent,
        pool,
        session: createdSession,
        policy,
        detachCookies,
        timer: null,
        disposed: false,
      };
    } catch (error) {
      detachCookies?.();
      if (session) pool.proxy.closeSession(session);
      releasePool(pool);
      throw error;
    }
  };

  const putImpl = async ({
    tabId, deviceId, url, origin, siteVersion, sourceUserAgent,
  }: LeaseInput, requireExisting = false): Promise<PublicLease | null> => {
    if (!deviceId || !tabId) throw new Error('browser lease identity required');
    const key = leaseKey(deviceId, tabId);
    const existing = leases.get(key);
    if (requireExisting && !existing) return null;
    const target = normalizedTarget(url);
    const publicOrigin = normalizedOrigin(origin);
    const requestedVersion = normalizeSiteVersion(siteVersion);
    if (!requestedVersion) throw new Error('invalid browser site version');
    if (existing
      && existing.originalUrl === target
      && existing.publicOrigin === publicOrigin
      && existing.siteVersion === requestedVersion) {
      touch(existing);
      return publicLease(existing);
    }
    const next = await createLease({
      tabId,
      deviceId,
      url: target,
      origin: publicOrigin,
      channel: existing?.channel || randomChannel(),
      siteVersion: requestedVersion,
      sourceUserAgent,
    });
    leases.set(key, next);
    touch(next);
    if (existing) disposeLease(existing);
    setDeviceActive(deviceId);
    return publicLease(next);
  };
  const put = ({ tabId, deviceId, ...options }: LeaseInput, requireExisting = false): Promise<PublicLease | null> => {
    const key = leaseKey(deviceId, tabId);
    return serializeLease(key, () => putImpl(
      { tabId, deviceId, ...options },
      requireExisting,
    ));
  };

  rehomeNavigation = async (event: RequestEvent, session: HammerSession): Promise<boolean> => {
    const info = event?._requestInfo || {};
    const headers = info.headers || {};
    const destination = String(headers['sec-fetch-dest'] || headers['Sec-Fetch-Dest'] || '').toLowerCase();
    const acceptsHtml = String(headers.accept || headers.Accept || '').toLowerCase().includes('text/html');
    const topLevelDocument = !info.isAjax && !info.isIframe
      && (destination === 'document' || destination === 'iframe' || acceptsHtml);
    if (!topLevelDocument) return false;
    let target: string;
    try { target = normalizedTarget(info.url); } catch { return false; }
    const observed = [...leases.values()].find((lease) => lease.session === session);
    if (!observed || new URL(target).origin === new URL(observed.originalUrl).origin) return false;
    const origin = publicOriginFor(target);
    if (!origin || !browserBootstrap) return false;

    return serializeLease(observed.key, async () => {
      const current = leases.get(observed.key);
      if (!current || current.session !== session) return false;
      const result = await current.policy.check(target);
      const loopbackPortChange = isLoopbackUrl(current.originalUrl)
        && isLoopbackUrl(target)
        && new URL(current.originalUrl).origin !== new URL(target).origin;
      if (!result.allowed || loopbackPortChange) {
        await event.setMock(new hammerhead.ResponseMock(
          JSON.stringify({
            error: 'browser target blocked',
            reason: result.allowed ? 'loopback-not-authorized' : result.reason,
          }),
          403,
          { 'content-type': 'application/json; charset=utf-8' },
        ));
        return true;
      }
      const next = await createLease({
        tabId: current.tabId,
        deviceId: current.deviceId,
        url: target,
        origin,
        channel: current.channel,
        siteVersion: current.siteVersion,
        sourceUserAgent: current.sourceUserAgent,
      });
      try {
        const bootstrapUrl = browserBootstrap.issue({
          url: next.url,
          origin: next.publicOrigin,
          deviceId: next.deviceId,
          preserveMethod: true,
          redirectStatus: 307,
        });
        await event.setMock(new hammerhead.ResponseMock(
          '',
          307,
          hammerheadRebindHeaders(bootstrapUrl),
        ));
        leases.set(current.key, next);
        touch(next);
        disposeLease(current);
        return true;
      } catch (error) {
        disposeLease(next);
        throw error;
      }
    });
  };

  const sessionIdForPath = (pathname: unknown): string | null => {
    const descriptor = String(pathname || '').split('/')[1] || '';
    const sessionId = descriptor.split(/[!*]/, 1)[0];
    return sessionId.startsWith('_browser-') ? sessionId : null;
  };

  return {
    putLease: (options: LeaseInput) => put(options),
    navigateLease(
      tabId: string,
      url: string,
      deviceId: string,
      origin: string,
      siteVersion: unknown,
      sourceUserAgent: string,
    ) {
      return put({ tabId, url, deviceId, origin, siteVersion, sourceUserAgent }, true);
    },
    getLease(tabId: string, deviceId: string): PublicLease | null {
      return publicLease(leases.get(leaseKey(deviceId, tabId)));
    },
    deleteLease(tabId: string, deviceId: string): boolean {
      return release(leases.get(leaseKey(deviceId, tabId)));
    },
    hasDevice(deviceId: string | null): boolean {
      return [...leases.values()].some((lease) => lease.deviceId === deviceId);
    },
    ownsPublicPath(pathname: unknown, deviceId: string | null): boolean {
      const sessionId = sessionIdForPath(pathname);
      return [...leases.values()].some((lease) => (
        lease.deviceId === deviceId && lease.session.id === sessionId
      ));
    },
    resolvePublicRequest(pathname: unknown, deviceId: string | null, rawOrigin: string | null) {
      let origin: string;
      if (rawOrigin === null) return null;
      try { origin = normalizedOrigin(rawOrigin); } catch { return null; }
      const sessionId = sessionIdForPath(pathname);
      const lease = [...leases.values()].find((item) => (
        item.deviceId === deviceId
        && item.publicOrigin === origin
        && (!sessionId || item.session.id === sessionId)
      ));
      if (!lease) return null;
      touch(lease);
      return { port: lease.pool.ports[0], origin: lease.publicOrigin };
    },
    configureDeviceProfile(deviceId: string, prefs: unknown) {
      return cookieProfiles.configure(deviceId, prefs);
    },
    async clearDeviceProfile(deviceId: string, { origin }: { origin: string | null }) {
      await cookieProfiles.clear(deviceId, origin === null
        ? {}
        : { hostname: new URL(origin).hostname });
      await cookieProfiles.flush?.(deviceId);
      return { closedTabIds: [] };
    },
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      for (const lease of [...leases.values()]) release(lease);
      await Promise.allSettled([...pendingPools.values(), ...leaseQueues.values()]);
      for (const lease of [...leases.values()]) release(lease);
      for (const pool of pools.values()) {
        if (pool.closeTimer != null) clearTimer(pool.closeTimer);
        pool.closeTimer = null;
        pool.proxy.close();
      }
      pools.clear();
      await cookieProfiles.close?.();
    },
  };
}
