// Client side of Web Push (minimal slice): request permission, subscribe through the service
// worker, hand the subscription to the server. The actual notification delivery is server →
// FCM/APNs → SW (see public/sw.js); this module only manages the subscription lifecycle.
import { getToken, getBoundSessions } from './storage.js';
import { t } from './i18n';
import { UnauthorizedError } from './api.js';

export type DeliveryStatus = 'pending' | 'success' | 'failed';

export interface PushDelivery {
  status: DeliveryStatus;
  reason?: string | null;
}

export interface PushInboxItem {
  id: string;
  title: string;
  body: string;
  ts: number;
  url?: string | null;
  delivery?: PushDelivery | null;
}

class PushError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'PushError';
    this.code = code;
  }
}

class PushHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'PushHttpError';
    this.status = status;
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pushKeyOf(value: unknown): string | null {
  const key = recordOf(value)?.pushKey;
  return typeof key === 'string' ? key : null;
}

function parsePushDelivery(value: unknown): PushDelivery | null {
  const record = recordOf(value);
  if (!record || !['pending', 'success', 'failed'].includes(String(record.status))) return null;
  return {
    status: record.status as DeliveryStatus,
    ...(typeof record.reason === 'string' || record.reason === null ? { reason: record.reason } : {}),
  };
}

function parsePushInboxItems(value: unknown): PushInboxItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): PushInboxItem[] => {
    const record = recordOf(candidate);
    if (!record
      || typeof record.id !== 'string'
      || typeof record.title !== 'string'
      || typeof record.body !== 'string'
      || typeof record.ts !== 'number'
      || !Number.isFinite(record.ts)) return [];
    const delivery = parsePushDelivery(record.delivery);
    return [{
      id: record.id,
      title: record.title,
      body: record.body,
      ts: record.ts,
      ...(typeof record.url === 'string' || record.url === null ? { url: record.url } : {}),
      ...(delivery ? { delivery } : {}),
    }];
  });
}

const NOTIFY_KEY = 'tw_notify'; // '1' once the user has enabled device notifications on this device
const PUSH_DEVICE_KEY = 'tw_push_device_key'; // stable script-push identity across unsubscribe/resubscribe
const VALID_PUSH_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const LOCAL_STEP_TIMEOUT_MS = 10000;
const PUSH_SERVICE_TIMEOUT_MS = 20000;

export const notifyEnabled = () => localStorage.getItem(NOTIFY_KEY) === '1';
const setNotifyFlag = (on: boolean): void => localStorage.setItem(NOTIFY_KEY, on ? '1' : '0');
const storedPushKey = () => {
  const value = localStorage.getItem(PUSH_DEVICE_KEY);
  return VALID_PUSH_KEY.test(value || '') ? value : null;
};
const rememberPushKey = (value: unknown): string | null => {
  if (typeof value !== 'string' || !VALID_PUSH_KEY.test(value)) return null;
  localStorage.setItem(PUSH_DEVICE_KEY, value);
  return value;
};

export function pushSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
}

// iOS Safari only allows push when the site runs as a home-screen PWA (standalone), not in a tab.
export function isStandalone() {
  if (typeof window === 'undefined') return false;
  const iosNavigator = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.('(display-mode: standalone)').matches || iosNavigator.standalone === true;
}
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent || '');

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${getToken() ?? ''}`, ...extra };
}

function timeoutError(key: string): PushError {
  return new PushError(t(key), key);
}

function setupError(key: string, vars?: Record<string, unknown>): PushError {
  return new PushError(t(key, vars), key);
}

// Browser push APIs are allowed to stay pending indefinitely (notably serviceWorker.ready), and
// Chromium can also leave PushManager.subscribe pending while its push service is unavailable. Keep
// each boundary finite so Settings always gives control back with the exact stage that stalled.
function withTimeout<T>(promise: PromiseLike<T> | T, ms: number, key: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(promise),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeoutError(key)), ms); }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

// Abort network work when its UI deadline expires. Unlike the browser-owned push operations above,
// fetch is cancellable, so there is no reason to leave a dead request running after Settings recovers.
async function fetchWithTimeout(url: string, options: RequestInit, key: string): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      fetch(url, { ...options, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(timeoutError(key));
        }, LOCAL_STEP_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // abort dispatch can make fetch reject before the timeout promise wins the race. Normalize that
    // ordering difference so callers always receive the stage-specific error, never bare AbortError.
    if (timedOut) throw timeoutError(key);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const readyServiceWorker = () => withTimeout(
  navigator.serviceWorker.ready,
  LOCAL_STEP_TIMEOUT_MS,
  'push.swTimeout',
);

const currentSubscription = (reg: ServiceWorkerRegistration): Promise<PushSubscription | null> => withTimeout(
  reg.pushManager.getSubscription(),
  PUSH_SERVICE_TIMEOUT_MS,
  'push.browserTimeout',
);

// VAPID public key arrives as URL-safe base64; PushManager.subscribe wants a Uint8Array.
function urlBase64ToArrayBuffer(b64: string): ArrayBuffer {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const base = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
  return arr.buffer as ArrayBuffer;
}

export async function enableNotifications() {
  if (!pushSupported()) throw new Error(t('push.unsupported'));
  if (isIOS() && !isStandalone()) throw new Error(t('push.iosAddToHome'));
  const perm = await withTimeout(
    Notification.requestPermission(),
    LOCAL_STEP_TIMEOUT_MS,
    'push.permissionTimeout',
  );
  if (perm !== 'granted') throw new Error(t('push.permissionDenied'));

  // Registration used to happen only in the app bootstrap as a separate best-effort side effect whose
  // errors were swallowed. Push then waited on `ready` forever when that distant setup never produced an
  // active worker. Register here as an idempotent prerequisite so the operation cannot start without the
  // service it needs, and preserve the browser's real registration error for the user.
  try {
    await withTimeout(
      navigator.serviceWorker.register('/sw.js'),
      LOCAL_STEP_TIMEOUT_MS,
      'push.swRegisterTimeout',
    );
  } catch (error) {
    if (error instanceof PushError && error.code === 'push.swRegisterTimeout') throw error;
    throw setupError('push.swRegisterFailed', {
      reason: error instanceof Error && error.message ? error.message : t('push.unknownReason'),
    });
  }
  const reg = await readyServiceWorker();
  const res = await fetchWithTimeout(
    '/api/push/vapid',
    { headers: authHeaders(), cache: 'no-store' },
    'push.configTimeout',
  );
  if (!res.ok) throw new Error(t('push.noVapid'));
  const config = recordOf(await res.json());
  const key = typeof config?.key === 'string' ? config.key : null;
  if (!key) throw new Error(t('push.noVapid'));

  let sub = await currentSubscription(reg);
  if (!sub) {
    sub = await withTimeout(
      reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToArrayBuffer(key),
      }),
      PUSH_SERVICE_TIMEOUT_MS,
      'push.browserTimeout',
    );
  }

  const subscribeBody: {
    subscription: PushSubscription;
    boundSessions: string[];
    pushKey?: string;
  } = { subscription: sub, boundSessions: getBoundSessions() };
  const previousPushKey = storedPushKey();
  if (previousPushKey) subscribeBody.pushKey = previousPushKey;
  const r = await fetchWithTimeout(
    '/api/push/subscribe',
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(subscribeBody),
    },
    'push.reportTimeout',
  );
  if (!r.ok) {
    if (r.status === 410) {
      // The push service rejected this browser-held subscription as expired. Remove it locally as well;
      // the next tap then creates a genuinely fresh FCM/APNs subscription instead of reporting the same
      // dead endpoint forever.
      try { await sub.unsubscribe(); } catch { /* the server has already pruned it */ }
      setNotifyFlag(false);
      throw setupError('push.subscriptionExpired');
    }
    if (r.status === 502) throw setupError('push.deliveryRejected');
    throw new Error(t('push.subscribeFailed'));
  }
  rememberPushKey(pushKeyOf(await r.json()));
  setNotifyFlag(true);
  return true;
}

export async function disableNotifications() {
  // The switch is local product state, so turn it off synchronously and never make Settings wait on a
  // browser push service. Remote + browser cleanup continues best-effort, but every boundary is finite.
  setNotifyFlag(false);
  void (async () => {
    try {
      const reg = await readyServiceWorker();
      const sub = await currentSubscription(reg);
      if (!sub) return;
      const [serverCleanup] = await Promise.allSettled([
        fetchWithTimeout('/api/push/unsubscribe', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }, 'push.reportTimeout'),
        withTimeout(
          Promise.resolve().then(() => sub.unsubscribe()),
          PUSH_SERVICE_TIMEOUT_MS,
          'push.browserTimeout',
        ),
      ]);
      if (serverCleanup.status === 'fulfilled' && serverCleanup.value.ok) {
        rememberPushKey(pushKeyOf(await serverCleanup.value.json()));
      }
    } catch { /* best effort — the local switch is already off */ }
  })();
}

// Re-report this device's bound-session set after the user binds/unbinds a session, so server-side
// push targeting stays in sync. No-op if notifications aren't enabled / not subscribed.
export async function reportBound() {
  if (!notifyEnabled() || !pushSupported()) return;
  try {
    const reg = await readyServiceWorker();
    const sub = await currentSubscription(reg);
    if (!sub) return;
    await fetchWithTimeout('/api/push/bound', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ endpoint: sub.endpoint, boundSessions: getBoundSessions() }),
    }, 'push.reportTimeout');
  } catch { /* best effort */ }
}

export async function sendTestPush() {
  const r = await fetchWithTimeout(
    '/api/push/test',
    { method: 'POST', headers: authHeaders() },
    'push.reportTimeout',
  );
  if (!r.ok) throw new Error(t('push.sendFailed'));
  return r.json();
}

// This device's addressing key, resolved from the live subscription's endpoint (server-token auth).
// Returns null if push isn't enabled/subscribed here. The key is not a secret — it only selects a
// device for `handmux push --device`; sending still requires the loopback server token.
async function resolveScriptPushKey(strict: boolean): Promise<string | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await readyServiceWorker();
    const sub = await currentSubscription(reg);
    if (!sub) return null;
    const r = await fetchWithTimeout('/api/push/key', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }, 'push.configTimeout');
    if (r.status === 401) throw new UnauthorizedError();
    if (!r.ok) {
      if (strict) {
        throw new PushHttpError('push key lookup failed', r.status);
      }
      return null;
    }
    return rememberPushKey(pushKeyOf(await r.json()));
  } catch (e) {
    if (strict) throw e;
    return null;
  }
}

export const getScriptPushKey = () => resolveScriptPushKey(false);

// Clear any OS notification for a pane (called when the user navigates to that pane). Best-effort.
export async function clearPaneNotification(pane: string): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await readyServiceWorker();
    const notes = await withTimeout(
      reg.getNotifications({ tag: `pane-${pane}` }),
      LOCAL_STEP_TIMEOUT_MS,
      'push.swTimeout',
    );
    notes.forEach((n) => n.close());
  } catch { /* best effort */ }
}

// Per-device inbox: resolve THIS device's pushKey (its subscription identity) and scope the fetch to it. A
// device that never subscribed has no pushKey → no inbox. Transport/auth failures MUST reject: treating an
// outage as [] erases the last good list and falsely tells the user they have no notifications.
export async function getNotifications(): Promise<PushInboxItem[]> {
  // The inbox is per push subscription. With the device switch off there is no active identity to
  // query, so do not wait on serviceWorker.ready and turn that expected state into a load error.
  if (!notifyEnabled()) return [];
  const key = await resolveScriptPushKey(true);
  if (!key) return [];
  const r = await fetchWithTimeout(
    `/api/notifications?device=${encodeURIComponent(key)}`,
    { headers: authHeaders(), cache: 'no-store' },
    'push.configTimeout',
  );
  if (r.status === 401) throw new UnauthorizedError();
  if (!r.ok) {
    throw new PushHttpError('notification inbox load failed', r.status);
  }
  return parsePushInboxItems(recordOf(await r.json())?.items);
}

export async function deleteNotification(id: string): Promise<boolean> {
  const key = await resolveScriptPushKey(true);
  if (!key) throw new Error('notification device unavailable');
  const r = await fetchWithTimeout(
    `/api/notifications/${encodeURIComponent(id)}?device=${encodeURIComponent(key)}`,
    { method: 'DELETE', headers: authHeaders() },
    'push.reportTimeout',
  );
  if (r.status === 401) throw new UnauthorizedError();
  if (!r.ok || recordOf(await r.json())?.ok !== true) throw new Error('notification delete failed');
  return true;
}
