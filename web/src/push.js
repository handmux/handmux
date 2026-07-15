// Client side of Web Push (minimal slice): request permission, subscribe through the service
// worker, hand the subscription to the server. The actual notification delivery is server →
// FCM/APNs → SW (see public/sw.js); this module only manages the subscription lifecycle.
import { getToken, getBoundSessions } from './storage.js';
import { t } from './i18n';

const NOTIFY_KEY = 'tw_notify'; // '1' once the user has enabled device notifications on this device

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
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(t('push.permissionDenied'));

  const reg = await navigator.serviceWorker.ready;
  const res = await fetch('/api/push/vapid', { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(t('push.noVapid'));
  const { key } = await res.json();

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }

  const r = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ subscription: sub, boundSessions: getBoundSessions() }),
  });
  if (!r.ok) throw new Error(t('push.subscribeFailed'));
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
export async function getScriptPushKey() {
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
    if (!r.ok) return null;
    return (await r.json()).pushKey || null;
  } catch { return null; }
}

// Clear any OS notification for a pane (called when the user navigates to that pane). Best-effort.
export async function clearPaneNotification(pane) {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const notes = await reg.getNotifications({ tag: `pane-${pane}` });
    notes.forEach((n) => n.close());
  } catch { /* best effort */ }
}

// Manual-push inbox: list stored notifications (newest first), or delete one. Best-effort — a failed
// fetch returns an empty list / false so the sheet just shows the empty state.
export async function getNotifications() {
  try {
    const r = await fetch('/api/notifications', { headers: authHeaders(), cache: 'no-store' });
    if (!r.ok) return [];
    return (await r.json()).items || [];
  } catch { return []; }
}

export async function deleteNotification(id) {
  try {
    const r = await fetch(`/api/notifications/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
    if (!r.ok) return false;
    return (await r.json()).ok === true;
  } catch { return false; }
}
