// Web Push (VAPID) — minimal delivery layer. Sends notifications to subscribed devices via the
// browser/OS push services (Android=FCM, iOS=APNs); the server only talks to those services, never
// to the phone directly, so device reachability/queueing is their problem (see TTL/topic below).
//
// Subscriptions are stored as records: { subscription, boundSessions }. The subscription field is
// the raw PushSubscription the browser hands us ({endpoint, keys:{p256dh, auth}}); boundSessions is
// the list of session names this device cares about (used by sendToSession for targeted delivery). A
// dead subscription (404/410 from the push service) is pruned on the next send.
import webpush from 'web-push';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { writeJsonAtomic } from './jsonStore.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STORE = process.env.PUSH_STORE || path.resolve(here, '../data/push-subs.json');

// VAPID is optional: without keys every send is a no-op, so the server still boots in an
// environment that hasn't generated keys (configured=false surfaces as a 503 on /vapid). Push delivers
// whenever VAPID is configured — there is no separate "dev vs prod server" anymore (one config file, one
// `handmux start`). If you run a second instance on the same host and don't want it to deliver, leave
// `vapid` out of that instance's config. Init is LAZY (first use) so the module is import-safe.
let inited = false;
let configured = false;
function ensureInit() {
  if (inited) return;
  inited = true;
  configured = !!(process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE);
  if (configured) {
    webpush.setVapidDetails(
      // Apple (APNs) rejects a VAPID subject on a fake/.local domain with BadJwtToken — it must be a
      // valid mailto:/https: with a real-looking domain. example.com is reserved and accepted by both.
      process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
      process.env.VAPID_PUBLIC,
      process.env.VAPID_PRIVATE,
    );
  }
}

const genKey = () => crypto.randomBytes(18).toString('base64url');

let subs = load();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8')) || [];
    return raw.map((e) => (e && e.subscription)
      ? { subscription: e.subscription, boundSessions: e.boundSessions || [], pushKey: e.pushKey || undefined }
      : { subscription: e, boundSessions: [] }); // migrate old bare-subscription entries
  } catch { return []; }
}
function persist() { writeJsonAtomic(STORE, subs); }

export function isConfigured() { ensureInit(); return configured; }
export function publicKey() { ensureInit(); return process.env.VAPID_PUBLIC || null; }
export function count() { return subs.length; }

export function addSubscription(sub, boundSessions = []) {
  if (!sub || typeof sub.endpoint !== 'string') return false;
  const i = subs.findIndex((s) => s.subscription.endpoint === sub.endpoint);
  if (i === -1) subs.push({ subscription: sub, boundSessions, pushKey: genKey() });
  else subs[i] = { subscription: sub, boundSessions, pushKey: subs[i].pushKey || genKey() };
  persist();
  return true;
}

export function updateBound(endpoint, boundSessions = []) {
  const rec = subs.find((s) => s.subscription.endpoint === endpoint);
  if (rec) { rec.boundSessions = boundSessions; persist(); }
}

export function removeSubscription(endpoint) {
  const before = subs.length;
  subs = subs.filter((s) => s.subscription.endpoint !== endpoint);
  if (subs.length !== before) persist();
}

// The device-addressing id (NOT an auth credential — see /api/push/send-local). Lazy-generate for
// records stored before the feature existed so an already-subscribed device still has one.
export function getPushKey(endpoint) {
  const rec = subs.find((s) => s.subscription.endpoint === endpoint);
  if (!rec) return null;
  if (!rec.pushKey) { rec.pushKey = genKey(); persist(); }
  return rec.pushKey;
}

// The push-service Topic header (RFC 8030) must be ≤32 URL/filename-safe base64 chars [A-Za-z0-9_-].
// An invalid topic makes the service reject the ENTIRE send with a non-404/410 error that deliver()
// swallows — a silent zero-delivery, no log, no prune. tmux pane ids carry a '%' (e.g. %4), so a
// pane-derived topic ("pane-%4") breaks every per-pane push (需要你 / 已完成). Sanitize here, the layer
// that owns the web-push contract, so no caller has to know the rule.
function safeTopic(t) {
  if (!t) return undefined;
  const s = t.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return s || undefined;
}

// TTL bounds staleness (a phone offline longer than this drops the push instead of getting it
// hours later); topic collapses older undelivered messages with the same key so a device coming
// back online sees only the latest per topic. urgency hints the OS how aggressively to wake.
function options(opts = {}) {
  return { TTL: opts.ttl ?? 90, urgency: opts.urgency || 'normal', topic: safeTopic(opts.topic) };
}

async function deliver(records, payload, opts = {}) {
  ensureInit();
  if (!configured) return { sent: 0, failed: 0, gone: 0, configured: false };
  const data = JSON.stringify(payload);
  const dead = [];
  let sent = 0;
  let failed = 0;
  await Promise.all(records.map(async (rec) => {
    try { await webpush.sendNotification(rec.subscription, data, options(opts)); sent += 1; }
    catch (e) {
      failed += 1;
      if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(rec.subscription.endpoint);
      let host = 'unknown push service';
      try { host = new URL(rec.subscription.endpoint).host; } catch { /* malformed endpoints fail below */ }
      const detail = String(e?.body || e?.message || 'unknown error').replace(/\s+/g, ' ').slice(0, 200);
      console.warn(`[handmux] push delivery failed (${host}, HTTP ${e?.statusCode || 'unknown'}): ${detail}`);
    }
  }));
  if (dead.length) { subs = subs.filter((s) => !dead.includes(s.subscription.endpoint)); persist(); }
  return { sent, failed, gone: dead.length, configured: true };
}

export const sendToAll = (payload, opts = {}) => deliver(subs, payload, opts);
export const sendToSession = (session, payload, opts = {}) =>
  deliver(subs.filter((s) => s.boundSessions.includes(session)), payload, opts);

export const sendToDevices = (keys, payload, opts = {}) =>
  deliver(subs.filter((s) => keys.includes(s.pushKey)), payload, opts);

// Union of the given sessions, deduped: a device bound to several of them is still delivered once
// (deliver() iterates the record list, so each record appears at most once here).
export const sendToSessions = (sessions, payload, opts = {}) =>
  deliver(subs.filter((s) => s.boundSessions.some((x) => sessions.includes(x))), payload, opts);

// The pushKeys a given scope resolves to (mirrors sendToDevices/sendToSessions/sendToAll targeting) — used
// by the inbox to write a record into exactly the devices a manual push is delivered to.
export const resolveTargetKeys = ({ devices, sessions } = {}) => {
  const pick = (devices && devices.length)
    ? subs.filter((s) => devices.includes(s.pushKey))
    : (sessions && sessions.length)
      ? subs.filter((s) => s.boundSessions.some((x) => sessions.includes(x)))
      : subs;
  return [...new Set(pick.map((s) => s.pushKey).filter(Boolean))];
};

// Back-compat: the /push/subscribe welcome still pushes to a single just-added subscription.
export async function sendToOne(sub, payload, opts = {}) {
  const rec = subs.find((s) => s.subscription.endpoint === sub.endpoint)
    ?? { subscription: sub, boundSessions: [] };
  return deliver([rec], payload, opts);
}
