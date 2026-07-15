// Manual-push inbox: persist each `handmux push` notification so the phone can review history.
// Module singleton mirroring push.js — records live in memory (source of truth), flushed whole on
// each mutation. Store path comes from NOTIF_STORE (the CLI injects ~/.handmux/notifications.json;
// NEVER the package-internal server/data default, which a global reinstall wipes). Ring-buffered to
// the most recent CAP entries so the file can't grow without bound.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { readJsonArray, writeJsonAtomic } from './jsonStore.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STORE = process.env.NOTIF_STORE || path.resolve(here, '../data/notifications.json');
const CAP = 100;

// Stored oldest→newest in memory; list() reverses for the client.
let items = readJsonArray(STORE).filter((n) => n && typeof n.title === 'string');
const persist = () => writeJsonAtomic(STORE, items);
const genId = () => crypto.randomBytes(9).toString('base64url');

export function record({ title, body, tag, url } = {}) {
  const rec = { id: genId(), ts: Date.now(), title: String(title ?? ''), body: String(body ?? '') };
  if (tag) rec.tag = String(tag);
  if (url) rec.url = String(url);
  items.push(rec);
  if (items.length > CAP) items = items.slice(items.length - CAP);
  persist();
  return rec;
}

export function list() { return items.slice().reverse(); }

export function remove(id) {
  const before = items.length;
  items = items.filter((n) => n.id !== id);
  if (items.length !== before) { persist(); return true; }
  return false;
}

export function count() { return items.length; }
