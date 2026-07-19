// Client side of Web Push (minimal slice): request permission, subscribe through the service
// worker, hand the subscription to the server. The actual notification delivery is server →
// FCM/APNs → SW (see public/sw.js); this module only manages the subscription lifecycle.
import { getToken, getBoundSessions } from './storage.js';
import { t } from './i18n';
import { UnauthorizedError } from './api.js';

const NOTIFY_KEY = 'tw_notify'; // '1' once the user has enabled device notifications on this device
const LOCAL_STEP_TIMEOUT_MS = 10000;
const PUSH_SERVICE_TIMEOUT_MS = 20000;

export const notifyEnabled = () => localStorage.getItem(NOTIFY_KEY) === '1';
const setNotifyFlag = (on) => localStorage.setItem(NOTIFY_KEY, on ? '1' : '0');

export function pushSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
}

// iOS Safari only allows push when the site runs as a home-screen PWA (standalone), not in a tab.
export function isStandalone() {
  return (typeof window !== 'undefined'
    && (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true)) || false;
}
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent || '');

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${getToken() ?? ''}`, ...extra };
}

function timeoutError(key) {
  const error = new Error(t(key));
  error.code = key;
  return error;
}

function setupError(key, vars) {
  const error = new Error(t(key, vars));
  error.code = key;
  return error;
}

// Browser push APIs are allowed to stay pending indefinitely (notably serviceWorker.ready), and
// Chromium can also leave PushManager.subscribe pending while its push service is unavailable. Keep
// each boundary finite so Settings always gives control back with the exact stage that stalled.
function withTimeout(promise, ms, key) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError(key)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Abort network work when its UI deadline expires. Unlike the browser-owned push operations above,
// fetch is cancellable, so there is no reason to leave a dead request running after Settings recovers.
async function fetchWithTimeout(url, options, key) {
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  try {
    return await Promise.race([
      fetch(url, { ...options, signal: controller.signal }),
      new Promise((_, reject) => {
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
    clearTimeout(timer);
  }
}

// VAPID public key arrives as URL-safe base64; PushManager.subscribe wants a Uint8Array.
function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const base = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
  return arr;
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
    if (error?.code === 'push.swRegisterTimeout') throw error;
    throw setupError('push.swRegisterFailed', { reason: error?.message || t('push.unknownReason') });
  }
  const reg = await withTimeout(
    navigator.serviceWorker.ready,
    LOCAL_STEP_TIMEOUT_MS,
    'push.swTimeout',
  );
  const res = await fetchWithTimeout(
    '/api/push/vapid',
    { headers: authHeaders(), cache: 'no-store' },
    'push.configTimeout',
  );
  if (!res.ok) throw new Error(t('push.noVapid'));
  const { key } = await res.json();

  let sub = await withTimeout(
    reg.pushManager.getSubscription(),
    PUSH_SERVICE_TIMEOUT_MS,
    'push.browserTimeout',
  );
  if (!sub) {
    sub = await withTimeout(
      reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      }),
      PUSH_SERVICE_TIMEOUT_MS,
      'push.browserTimeout',
    );
  }

  const r = await fetchWithTimeout(
    '/api/push/subscribe',
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ subscription: sub, boundSessions: getBoundSessions() }),
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
  setNotifyFlag(true);
  return true;
}

export async function disableNotifications() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
  } catch { /* best effort — clearing the local flag is what matters */ }
  setNotifyFlag(false);
}

// Re-report this device's bound-session set after the user binds/unbinds a session, so server-side
// push targeting stays in sync. No-op if notifications aren't enabled / not subscribed.
export async function reportBound() {
  if (!notifyEnabled() || !pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await fetch('/api/push/bound', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ endpoint: sub.endpoint, boundSessions: getBoundSessions() }),
    });
  } catch { /* best effort */ }
}

export async function sendTestPush() {
  const r = await fetch('/api/push/test', { method: 'POST', headers: authHeaders() });
  if (!r.ok) throw new Error(t('push.sendFailed'));
  return r.json();
}

// This device's addressing key, resolved from the live subscription's endpoint (server-token auth).
// Returns null if push isn't enabled/subscribed here. The key is not a secret — it only selects a
// device for `handmux push --device`; sending still requires the loopback server token.
async function resolveScriptPushKey(strict) {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return null;
    const r = await fetch('/api/push/key', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    if (r.status === 401) throw new UnauthorizedError();
    if (!r.ok) {
      if (strict) throw new Error('push key lookup failed');
      return null;
    }
    return (await r.json()).pushKey || null;
  } catch (e) {
    if (strict) throw e;
    return null;
  }
}

export const getScriptPushKey = () => resolveScriptPushKey(false);

// Clear any OS notification for a pane (called when the user navigates to that pane). Best-effort.
export async function clearPaneNotification(pane) {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const notes = await reg.getNotifications({ tag: `pane-${pane}` });
    notes.forEach((n) => n.close());
  } catch { /* best effort */ }
}

// Per-device inbox: resolve THIS device's pushKey (its subscription identity) and scope the fetch to it. A
// device that never subscribed has no pushKey → no inbox. Transport/auth failures MUST reject: treating an
// outage as [] erases the last good list and falsely tells the user they have no notifications.
export async function getNotifications() {
  const key = await resolveScriptPushKey(true);
  if (!key) return [];
  const r = await fetch(`/api/notifications?device=${encodeURIComponent(key)}`, { headers: authHeaders(), cache: 'no-store' });
  if (r.status === 401) throw new UnauthorizedError();
  if (!r.ok) throw new Error('notification inbox load failed');
  return (await r.json()).items || [];
}

export async function deleteNotification(id) {
  const key = await resolveScriptPushKey(true);
  if (!key) throw new Error('notification device unavailable');
  const r = await fetch(`/api/notifications/${encodeURIComponent(id)}?device=${encodeURIComponent(key)}`, { method: 'DELETE', headers: authHeaders() });
  if (r.status === 401) throw new UnauthorizedError();
  if (!r.ok || (await r.json()).ok !== true) throw new Error('notification delete failed');
  return true;
}
