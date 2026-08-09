// Web Push (VAPID) — minimal delivery layer. Sends notifications to subscribed devices via the
// browser/OS push services (Android=FCM, iOS=APNs); the server only talks to those services, never
// to the phone directly, so device reachability/queueing is their problem (see TTL/topic below).
//
// Subscriptions are stored as records: { subscription, boundSessions }. The subscription field is
// the raw PushSubscription the browser hands us ({endpoint, keys:{p256dh, auth}}); boundSessions is
// the list of session names this device cares about (used by sendToSession for targeted delivery). A
// dead subscription (404/410 from the push service) is pruned on the next send.
import webpush from 'web-push';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { readJsonArray, writeJsonAtomic } from './jsonStore.js';
import type { PushSubscription, RequestOptions, Urgency } from 'web-push';

const here = path.dirname(fileURLToPath(import.meta.url));
const STORE = process.env.PUSH_STORE || path.resolve(here, '../data/push-subs.json');

// VAPID is optional: without keys every send is a no-op, so the server still boots in an
// environment that hasn't generated keys (configured=false surfaces as a 503 on /vapid). Push delivers
// whenever VAPID is configured — there is no separate "dev vs prod server" anymore (one config file, one
// `handmux start`). If you run a second instance on the same host and don't want it to deliver, leave
// `vapid` out of that instance's config. Init is LAZY (first use) so the module is import-safe.
let inited = false;
let configured = false;
function ensureInit(): void {
  if (inited) return;
  inited = true;
  const vapidPublic = process.env.VAPID_PUBLIC;
  const vapidPrivate = process.env.VAPID_PRIVATE;
  configured = !!(vapidPublic && vapidPrivate);
  if (vapidPublic && vapidPrivate) {
    webpush.setVapidDetails(
      // Apple (APNs) rejects a VAPID subject on a fake/.local domain with BadJwtToken — it must be a
      // valid mailto:/https: with a real-looking domain. example.com is reserved and accepted by both.
      process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
      vapidPublic,
      vapidPrivate,
    );
  }
}

const genKey = (): string => crypto.randomBytes(18).toString('base64url');
const VALID_PUSH_KEY = /^[A-Za-z0-9_-]{16,128}$/;

interface StoredSubscription {
  subscription: PushSubscription;
  boundSessions: string[];
  pushKey?: string;
}

export interface PushPayload {
  [key: string]: unknown;
}

export interface PushOptions {
  ttl?: unknown;
  urgency?: unknown;
  topic?: unknown;
}

export type PushFailureReason = 'expired' | 'rate_limited' | 'service_unavailable' | 'rejected' | 'network_error' | 'not_configured';
export type PushDelivery =
  | { pushKey: string | undefined; status: 'success' }
  | { pushKey: string | undefined; status: 'failed'; reason: PushFailureReason };

export interface PushDeliverySummary {
  sent: number;
  failed: number;
  gone: number;
  configured: boolean;
  deliveries: PushDelivery[];
}

interface PushScope {
  devices?: readonly string[] | null;
  sessions?: readonly string[] | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  : [];
const errorField = (error: unknown, field: string): unknown =>
  isRecord(error) ? error[field] : undefined;

export function parsePushSubscription(value: unknown): PushSubscription | null {
  if (!isRecord(value) || typeof value.endpoint !== 'string' || !value.endpoint) return null;
  if (!isRecord(value.keys) || typeof value.keys.p256dh !== 'string' || typeof value.keys.auth !== 'string') return null;
  const subscription: PushSubscription = {
    endpoint: value.endpoint,
    keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
  };
  if (value.expirationTime === null || (typeof value.expirationTime === 'number' && Number.isFinite(value.expirationTime))) {
    subscription.expirationTime = value.expirationTime;
  }
  return subscription;
}

function parseStoredSubscription(value: unknown): StoredSubscription | null {
  const wrapped = isRecord(value) && 'subscription' in value;
  const subscription = parsePushSubscription(wrapped && isRecord(value) ? value.subscription : value);
  if (!subscription) return null;
  const record: StoredSubscription = {
    subscription,
    boundSessions: wrapped && isRecord(value) ? strings(value.boundSessions) : [],
  };
  if (wrapped && isRecord(value) && typeof value.pushKey === 'string' && VALID_PUSH_KEY.test(value.pushKey)) {
    record.pushKey = value.pushKey;
  }
  return record;
}

let subs: StoredSubscription[] = load();

function load(): StoredSubscription[] {
  return readJsonArray(STORE)
    .map(parseStoredSubscription)
    .filter((record): record is StoredSubscription => record !== null);
}
function persist(): void { writeJsonAtomic(STORE, subs); }

export function isConfigured(): boolean { ensureInit(); return configured; }
export function publicKey(): string | null { ensureInit(); return process.env.VAPID_PUBLIC || null; }
export function count(): number { return subs.length; }

export function addSubscription(sub: unknown, boundSessions: unknown = [], preferredPushKey: unknown = null): string | false {
  const parsed = parsePushSubscription(sub);
  if (!parsed) return false;
  const sessions = strings(boundSessions);
  const endpointRecord = subs.find((s) => s.subscription.endpoint === parsed.endpoint);
  const requestedKey = typeof preferredPushKey === 'string' && VALID_PUSH_KEY.test(preferredPushKey) ? preferredPushKey : null;
  const keyRecord = requestedKey ? subs.find((s) => s.pushKey === requestedKey) : null;
  const pushKey = keyRecord?.pushKey || endpointRecord?.pushKey || requestedKey || genKey();

  // A browser PushSubscription is transport state, not device identity. Re-enabling push can produce a
  // different endpoint; replace the old endpoint that owns this stable key instead of creating a new
  // script-push target. Also collapse any legacy duplicate for the new endpoint.
  subs = subs.filter((s) => s.subscription.endpoint !== parsed.endpoint && s.pushKey !== pushKey);
  subs.push({ subscription: parsed, boundSessions: sessions, pushKey });
  persist();
  return pushKey;
}

export function updateBound(endpoint: unknown, boundSessions: unknown = []): void {
  const rec = subs.find((s) => s.subscription.endpoint === endpoint);
  if (rec) { rec.boundSessions = strings(boundSessions); persist(); }
}

export function removeSubscription(endpoint: unknown): string | null {
  const removed = subs.find((s) => s.subscription.endpoint === endpoint);
  subs = subs.filter((s) => s.subscription.endpoint !== endpoint);
  if (removed) persist();
  return removed?.pushKey || null;
}

// The device-addressing id (NOT an auth credential — see /api/push/send-local). Lazy-generate for
// records stored before the feature existed so an already-subscribed device still has one.
export function getPushKey(endpoint: unknown): string | null {
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
function safeTopic(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const s = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return s || undefined;
}

// TTL bounds staleness (a phone offline longer than this drops the push instead of getting it
// hours later); topic collapses older undelivered messages with the same key so a device coming
// back online sees only the latest per topic. urgency hints the OS how aggressively to wake.
function options(opts: PushOptions = {}): RequestOptions {
  const ttl = typeof opts.ttl === 'number' && Number.isFinite(opts.ttl) ? opts.ttl : 90;
  const urgency: Urgency = ['very-low', 'low', 'normal', 'high'].includes(String(opts.urgency))
    ? String(opts.urgency) as Urgency : 'normal';
  const result: RequestOptions = { TTL: ttl, urgency };
  const topic = safeTopic(opts.topic);
  if (topic) result.topic = topic;
  return result;
}

export function classifyDeliveryFailure(error: unknown): PushFailureReason {
  const status = Number(errorField(error, 'statusCode')) || 0;
  if (status === 404 || status === 410) return 'expired';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'service_unavailable';
  if (status >= 400) return 'rejected';
  return 'network_error';
}

async function deliver(records: readonly StoredSubscription[], payload: PushPayload, opts: PushOptions = {}): Promise<PushDeliverySummary> {
  ensureInit();
  if (!configured) return {
    sent: 0, failed: 0, gone: 0, configured: false,
    deliveries: records.map((rec) => ({ pushKey: rec.pushKey, status: 'failed', reason: 'not_configured' })),
  };
  const data = JSON.stringify(payload);
  const dead: string[] = [];
  const deliveries: PushDelivery[] = [];
  let sent = 0;
  let failed = 0;
  await Promise.all(records.map(async (rec) => {
    try {
      await webpush.sendNotification(rec.subscription, data, options(opts));
      sent += 1;
      deliveries.push({ pushKey: rec.pushKey, status: 'success' });
    }
    catch (e) {
      failed += 1;
      const statusCode = Number(errorField(e, 'statusCode')) || 0;
      if (statusCode === 404 || statusCode === 410) dead.push(rec.subscription.endpoint);
      deliveries.push({ pushKey: rec.pushKey, status: 'failed', reason: classifyDeliveryFailure(e) });
      let host = 'unknown push service';
      try { host = new URL(rec.subscription.endpoint).host; } catch { /* malformed endpoints fail below */ }
      const detail = String(errorField(e, 'body') || errorField(e, 'message') || 'unknown error').replace(/\s+/g, ' ').slice(0, 200);
      console.warn(`[handmux] push delivery failed (${host}, HTTP ${statusCode || 'unknown'}): ${detail}`);
    }
  }));
  if (dead.length) { subs = subs.filter((s) => !dead.includes(s.subscription.endpoint)); persist(); }
  return { sent, failed, gone: dead.length, configured: true, deliveries };
}

export const sendToAll = (payload: PushPayload, opts: PushOptions = {}): Promise<PushDeliverySummary> => deliver(subs, payload, opts);
export const sendToSession = (session: string, payload: PushPayload, opts: PushOptions = {}): Promise<PushDeliverySummary> =>
  deliver(subs.filter((s) => s.boundSessions.includes(session)), payload, opts);

export const sendToDevices = (keys: readonly string[], payload: PushPayload, opts: PushOptions = {}): Promise<PushDeliverySummary> =>
  deliver(subs.filter((s) => typeof s.pushKey === 'string' && keys.includes(s.pushKey)), payload, opts);

// Union of the given sessions, deduped: a device bound to several of them is still delivered once
// (deliver() iterates the record list, so each record appears at most once here).
export const sendToSessions = (sessions: readonly string[], payload: PushPayload, opts: PushOptions = {}): Promise<PushDeliverySummary> =>
  deliver(subs.filter((s) => s.boundSessions.some((x) => sessions.includes(x))), payload, opts);

// The pushKeys a given scope resolves to (mirrors sendToDevices/sendToSessions/sendToAll targeting) — used
// by the inbox to write a record into exactly the devices a manual push is delivered to.
export const resolveTargetKeys = ({ devices, sessions }: PushScope = {}): string[] => {
  const pick = (devices && devices.length)
    ? subs.filter((s) => typeof s.pushKey === 'string' && devices.includes(s.pushKey))
    : (sessions && sessions.length)
      ? subs.filter((s) => s.boundSessions.some((x) => sessions.includes(x)))
      : subs;
  return [...new Set(pick.map((s) => s.pushKey).filter((key): key is string => typeof key === 'string'))];
};

// Back-compat: the /push/subscribe welcome still pushes to a single just-added subscription.
export async function sendToOne(sub: unknown, payload: PushPayload, opts: PushOptions = {}): Promise<PushDeliverySummary> {
  const parsed = parsePushSubscription(sub);
  if (!parsed) return { sent: 0, failed: 1, gone: 0, configured: isConfigured(), deliveries: [] };
  const rec = subs.find((s) => s.subscription.endpoint === parsed.endpoint)
    ?? { subscription: parsed, boundSessions: [] };
  return deliver([rec], payload, opts);
}
