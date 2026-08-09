// Per-device manual-push inbox: each subscribed device gets its own file `<NOTIF_DIR>/<pushKey>.json`, so a
// `--device`/`--session`-scoped push only lands in the targeted devices' inboxes (delete/read are naturally
// per-device too). NOTIF_DIR is injected by the CLI (~/.handmux/notifications) — NEVER the package-internal
// default, which a global reinstall wipes. Low-frequency, so each op is a plain read-modify-write of one
// device file (no in-memory state). The same push shares one record id across its target devices so a
// notification tap's inboxId resolves on whichever device opens it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { readJsonArray, writeJsonAtomic } from './jsonStore.js';
import { sanitizeNotificationUrl } from './urlPolicy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.NOTIF_DIR || path.resolve(here, '../data/notifications');
const CAP = 100;
const genId = () => crypto.randomBytes(9).toString('base64url');

export type NotificationDeliveryStatus = 'pending' | 'success' | 'failed';

export interface NotificationDelivery {
  status: NotificationDeliveryStatus;
  reason?: string;
}

export interface StoredNotification {
  id: string;
  ts: number;
  title: string;
  body: string;
  tag?: string;
  url?: string;
  delivery?: NotificationDelivery;
}

export interface NotificationInput {
  title?: unknown;
  body?: unknown;
  tag?: unknown;
  url?: unknown;
  delivery?: unknown;
}

const DELIVERY_STATUSES = new Set<NotificationDeliveryStatus>(['pending', 'success', 'failed']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseDelivery(value: unknown): NotificationDelivery | undefined {
  if (!isRecord(value) || typeof value.status !== 'string' || !DELIVERY_STATUSES.has(value.status as NotificationDeliveryStatus)) {
    return undefined;
  }
  const delivery: NotificationDelivery = { status: value.status as NotificationDeliveryStatus };
  if (delivery.status === 'failed' && typeof value.reason === 'string') delivery.reason = value.reason;
  return delivery;
}

function parseStoredNotification(value: unknown): StoredNotification | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.ts !== 'number'
    || !Number.isFinite(value.ts)
    || typeof value.title !== 'string'
    || typeof value.body !== 'string') return null;

  const notification: StoredNotification = {
    id: value.id,
    ts: value.ts,
    title: value.title,
    body: value.body,
  };
  if (typeof value.tag === 'string') notification.tag = value.tag;
  if (typeof value.url === 'string') {
    const safeUrl = sanitizeNotificationUrl(value.url);
    if (safeUrl) notification.url = safeUrl;
  }
  const delivery = parseDelivery(value.delivery);
  if (delivery) notification.delivery = delivery;
  return notification;
}

// pushKey is base64url already; sanitize anyway so a hostile value can't escape DIR. Empty → null (skip).
function fileFor(key: unknown): string | null {
  const safe = String(key || '').replace(/[^A-Za-z0-9_-]/g, '');
  return safe ? path.join(DIR, `${safe}.json`) : null;
}
const load = (file: string): StoredNotification[] => readJsonArray(file)
  .map(parseStoredNotification)
  .filter((notification): notification is StoredNotification => notification !== null);

export function record(pushKeys: readonly unknown[] | null | undefined, input: NotificationInput = {}): StoredNotification {
  const { title, body, tag, url } = input;
  const rec: StoredNotification = { id: genId(), ts: Date.now(), title: String(title ?? ''), body: String(body ?? '') };
  if (tag) rec.tag = String(tag);
  const initialDelivery = parseDelivery(input.delivery);
  if (initialDelivery?.status === 'pending') rec.delivery = { status: 'pending' };
  const safeUrl = sanitizeNotificationUrl(url);
  if (safeUrl) rec.url = safeUrl;
  for (const key of pushKeys || []) {
    const file = fileFor(key);
    if (!file) continue;
    const items = load(file);
    items.push(rec);
    writeJsonAtomic(file, items.length > CAP ? items.slice(items.length - CAP) : items);
  }
  return rec;
}

export function updateDelivery(pushKey: unknown, id: unknown, delivery: unknown): boolean {
  const file = fileFor(pushKey);
  if (!file) return false;
  const items = load(file);
  const item = items.find((n) => n.id === id);
  if (!item) return false;
  const nextDelivery = parseDelivery(delivery);
  if (!nextDelivery) return false;
  item.delivery = nextDelivery;
  writeJsonAtomic(file, items);
  return true;
}

export function list(pushKey: unknown): StoredNotification[] {
  const file = fileFor(pushKey);
  return file ? load(file).reverse() : [];
}

export function remove(pushKey: unknown, id: unknown): boolean {
  const file = fileFor(pushKey);
  if (!file) return false;
  const items = load(file);
  const kept = items.filter((n) => n.id !== id);
  if (kept.length === items.length) return false;
  writeJsonAtomic(file, kept);
  return true;
}
