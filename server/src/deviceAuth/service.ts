import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

export type AuthMode = 'token' | 'trusted-device';
export interface DevicePrincipal { deviceId: string; sessionId: string; expiresAt: number | null; origin: string }
export interface AuthDevice {
  id: string; name: string; browser_summary: string; authorized_at: number;
  expires_at: number | null; last_used_at: number; revoked_at: number | null;
  status: 'active' | 'expired' | 'revoked';
}
export class DeviceAuthError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function parseExpire(value: unknown): number | null {
  if (value === 'never') return null;
  if (typeof value !== 'string' || !/^[1-9]\d*[mhd]$/.test(value)) throw new DeviceAuthError('INVALID_EXPIRE', 'Use a positive duration such as 1h, 7d, 30d, or never');
  const unit = value.slice(-1);
  const duration = Number(value.slice(0, -1)) * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
  if (!Number.isSafeInteger(duration) || duration > 8_640_000_000_000_000 - Date.now()) throw new DeviceAuthError('INVALID_EXPIRE', 'Duration is too large');
  return duration;
}
export function validateName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new DeviceAuthError('INVALID_NAME', 'Device name must contain 1–80 characters without control characters');
  return value.trim();
}
const hash = (secret: string): string => createHash('sha256').update(secret).digest('hex');
export const sessionCookieName = (origin: string): string => origin.startsWith('https:') ? '__Host-handmux_session' : 'handmux_session_http';
export const pairingCookieName = (origin: string): string => origin.startsWith('https:') ? '__Host-handmux_pairing' : 'handmux_pairing_http';
function readCookieSecret(req: IncomingMessage, name: string): string | null {
  const matches = (req.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export const readSessionSecret = (req: IncomingMessage, origin: string): string | null => readCookieSecret(req, sessionCookieName(origin));
export function readPairingCookies(req: IncomingMessage, origin: string): Array<{ name: string; secret: string }> {
  const prefix = `${pairingCookieName(origin)}_`;
  const names = (req.headers.cookie ?? '').split(';').map(v => v.trim().split('=')[0] ?? '')
    .filter(name => name.startsWith(prefix) && /^[a-f0-9]{32}$/.test(name.slice(prefix.length)));
  // The HTTP header itself is bounded by Node. Cap additional hash lookups independently.
  return [...new Set(names)].slice(0, 32).flatMap(name => { const secret = readCookieSecret(req, name); return secret ? [{ name, secret }] : []; });
}
type PairState = 'waiting' | 'configuring' | 'authorized' | 'expired' | 'canceled';
interface Pairing {
  id: string; secretHash: string; origin: string; code: string; state: PairState;
  expiresAt: number; browserSummary: string; owner?: string; source?: 'cli'; deviceId?: string;
}
export interface PairingStatus { id: string; state: PairState; code?: string; expiresAt: number; source?: 'cli' }

export class DeviceAuthService {
  readonly mode: AuthMode;
  private db: DatabaseSync;
  private now: () => number;
  private write: () => void;
  private pending = new Map<string, Pairing>();
  private retired = new Map<string, number>();
  private listeners = new Set<(deviceId: string) => void>();
  private activity = new Map<string, { deviceId: string; at: number }>();
  private expireNotified = new Set<string>();
  private observedDevices = new Set<string>();
  private timer: ReturnType<typeof setInterval>;
  private flushTimer: ReturnType<typeof setInterval>;
  private claimFailures: number[] = [];
  private closed = false;
  constructor({ db, mode, now = Date.now, onSuccessfulWrite = () => {} }: {
    db: DatabaseSync; mode: AuthMode; now?: () => number; onSuccessfulWrite?: () => void;
  }) {
    this.db = db; this.mode = mode; this.now = now; this.write = onSuccessfulWrite;
    const last = db.prepare("SELECT value FROM auth_meta WHERE key='mode'").get() as { value: string } | undefined;
    this.transaction(() => {
      if (last?.value !== mode) {
        db.prepare('UPDATE auth_devices SET revoked_at=? WHERE revoked_at IS NULL').run(now());
        db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE revoked_at IS NULL').run(now());
      }
      db.prepare("INSERT INTO auth_meta(key,value) VALUES('mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(mode);
    });
    this.timer = setInterval(() => this.sweep(), 1000); this.timer.unref();
    this.flushTimer = setInterval(() => { try { this.flush(); } catch { console.error('[auth] Activity flush failed; will retry'); } }, 30_000); this.flushTimer.unref();
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    let out: T;
    try { out = run(); this.db.exec('COMMIT'); }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
    // Backup scheduling is auxiliary; it must never turn an already committed authorization into a
    // reported failure or leave its in-memory pairing state behind the durable transaction.
    try { this.write(); } catch { console.error('[auth] Backup scheduling failed'); }
    return out;
  }
  private requireMode(): void {
    if (this.closed || this.mode !== 'trusted-device') throw new DeviceAuthError('DEVICE_AUTH_DISABLED', 'Device authorization is not enabled; select it in handmux setup and restart', 409);
  }
  onRevoke(listener: (deviceId: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(id: string): void { for (const listener of this.listeners) { try { listener(id); } catch { console.error('[auth] Capability cleanup failed'); } } }
  private device(id: string): AuthDevice {
    const row = this.db.prepare('SELECT id,name,browser_summary,authorized_at,expires_at,last_used_at,revoked_at FROM auth_devices WHERE id=?').get(id) as unknown as Omit<AuthDevice, 'status'> | undefined;
    if (!row) throw new DeviceAuthError('DEVICE_NOT_FOUND', 'Device ID not found; use handmux auth list', 404);
    return { ...row, status: row.revoked_at !== null ? 'revoked' : row.expires_at !== null && row.expires_at <= this.now() ? 'expired' : 'active' };
  }
  isDeviceActive(id: string): boolean {
    if (this.closed || this.mode !== 'trusted-device') return false;
    try { return this.device(id).status === 'active'; } catch (error) { if (error instanceof DeviceAuthError) return false; throw error; }
  }
  isActive(principal: DevicePrincipal): boolean {
    if (!this.isDeviceActive(principal.deviceId)) return false;
    return !!this.db.prepare('SELECT id FROM auth_sessions WHERE id=? AND device_id=? AND revoked_at IS NULL').get(principal.sessionId, principal.deviceId);
  }
  authenticateRequest(req: IncomingMessage, origin: string): DevicePrincipal | null {
    const secret = readSessionSecret(req, origin);
    return secret ? this.authenticateSecret(secret, origin) : null;
  }
  authenticateSecret(secret: string, origin: string): DevicePrincipal | null {
    if (this.closed || this.mode !== 'trusted-device') return null;
    const row = this.db.prepare(`SELECT s.id AS sessionId,s.device_id AS deviceId,d.expires_at AS expiresAt,s.origin
      FROM auth_sessions s JOIN auth_devices d ON d.id=s.device_id WHERE s.secret_hash=? AND s.origin=?
      AND s.transport=? AND s.revoked_at IS NULL AND d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at>?)`).get(hash(secret), origin, origin.startsWith('https:') ? 'https' : 'http', this.now()) as unknown as DevicePrincipal | undefined;
    if (!row) return null;
    this.observedDevices.add(row.deviceId); this.touch(row); return row;
  }
  touch(principal: DevicePrincipal): void { if (this.isActive(principal)) this.activity.set(principal.sessionId, { deviceId: principal.deviceId, at: this.now() }); }
  flush(): void {
    if (!this.activity.size) return;
    const entries = [...this.activity];
    this.transaction(() => { for (const [sessionId, { deviceId, at }] of entries) {
      this.db.prepare('UPDATE auth_sessions SET last_used_at=MAX(last_used_at,?) WHERE id=?').run(at, sessionId);
      this.db.prepare('UPDATE auth_devices SET last_used_at=MAX(last_used_at,?) WHERE id=?').run(at, deviceId);
    } });
    for (const [id, value] of entries) if (this.activity.get(id) === value) this.activity.delete(id);
  }
  list(): AuthDevice[] {
    this.requireMode();
    const ids = this.db.prepare('SELECT id FROM auth_devices ORDER BY last_used_at DESC,id').all() as Array<{ id: string }>;
    return ids.map(({ id }) => { const d = this.device(id); for (const a of this.activity.values()) if (a.deviceId === id) d.last_used_at = Math.max(d.last_used_at, a.at); return d; });
  }
  edit(id: string, values: { name?: unknown; expire?: unknown }): AuthDevice & { previousExpiresAt: number | null } {
    this.requireMode();
    if (values.name === undefined && values.expire === undefined) throw new DeviceAuthError('INVALID_EDIT', 'Provide --name or --expire');
    const name = values.name === undefined ? undefined : validateName(values.name);
    const duration = values.expire === undefined ? undefined : parseExpire(values.expire);
    return this.transaction(() => {
      const d = this.device(id);
      if (d.status !== 'active') throw new DeviceAuthError('DEVICE_INACTIVE', 'Expired or revoked devices must pair again', 409);
      const expires = duration === undefined ? d.expires_at : duration === null ? null : this.now() + duration;
      this.db.prepare('UPDATE auth_devices SET name=?,expires_at=? WHERE id=?').run(name ?? d.name, expires, id);
      return { ...this.device(id), previousExpiresAt: d.expires_at };
    });
  }
  revoke(id: string): AuthDevice {
    this.requireMode(); const d = this.device(id);
    if (d.revoked_at === null) this.transaction(() => {
      const now = this.now();
      this.db.prepare('UPDATE auth_devices SET revoked_at=? WHERE id=?').run(now, id);
      this.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL').run(now, id);
    });
    this.notify(id); return this.device(id);
  }
  private retire(p: Pairing): void { this.retired.set(p.code, this.now() + 600_000); }
  private updatePair(p: Pairing): void {
    if ((p.state === 'waiting' || p.state === 'configuring') && p.expiresAt <= this.now()) { p.state = 'expired'; this.retire(p); }
    if (p.state === 'authorized' && p.deviceId && !this.isDeviceActive(p.deviceId)) {
      p.state = this.device(p.deviceId).status === 'expired' ? 'expired' : 'canceled'; this.retire(p);
    }
  }
  private view(p: Pairing): PairingStatus { this.updatePair(p); return { id: p.id, state: p.state, ...(p.state === 'waiting' ? { code: p.code } : {}), expiresAt: p.expiresAt, ...(p.source ? { source: p.source } : {}) }; }
  pairing(secret: string | null, origin: string): PairingStatus | null {
    if (!secret) return null;
    const p = this.pending.get(hash(secret));
    return p?.origin === origin ? this.view(p) : null;
  }
  createPairing(secret: string | null, origin: string, browserSummary: string): { pairing: PairingStatus; secret?: string } {
    this.requireMode(); this.sweep();
    const existing = secret ? this.pending.get(hash(secret)) : null;
    if (existing?.origin === origin && (existing.state === 'waiting' || existing.state === 'configuring' || existing.state === 'authorized')) return { pairing: this.view(existing) };
    if (this.pending.size >= 256) throw new DeviceAuthError('PAIRING_CAPACITY', 'Too many pending requests; wait a few minutes and try again', 429);
    let code: string;
    do { code = String(randomInt(1_000_000)).padStart(6, '0'); } while (this.retired.has(code) || [...this.pending.values()].some(p => p.code === code));
    const next = randomBytes(32).toString('base64url');
    const p: Pairing = { id: `pair_${randomUUID().replaceAll('-', '')}`, secretHash: hash(next), origin, code, state: 'waiting', expiresAt: this.now() + 60_000, browserSummary: browserSummary.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 160) || 'Browser' };
    if (existing) { existing.state = 'canceled'; this.retire(existing); this.pending.delete(existing.secretHash); }
    this.pending.set(p.secretHash, p); return { pairing: this.view(p), secret: next };
  }
  cancelPairing(secret: string | null, origin: string, id: string): PairingStatus | null {
    this.requireMode(); const p = secret ? this.pending.get(hash(secret)) : null;
    if (!p || p.origin !== origin || p.id !== id) throw new DeviceAuthError('PAIRING_NOT_FOUND', 'Pairing request changed; refresh this page', 409);
    if (p.state !== 'authorized') { p.state = 'canceled'; this.retire(p); }
    return this.view(p);
  }
  claim(code: unknown, owner: string): { id: string; browserSummary: string; expiresAt: number } {
    this.requireMode(); this.sweep();
    this.claimFailures = this.claimFailures.filter(at => at > this.now() - 60_000);
    if (this.claimFailures.length >= 10) throw new DeviceAuthError('CLAIM_RATE_LIMIT', 'Too many invalid codes; wait one minute before trying again', 429);
    const p = typeof code === 'string' && /^\d{6}$/.test(code) ? [...this.pending.values()].find(p => p.code === code && p.state === 'waiting') : undefined;
    if (!p) { this.claimFailures.push(this.now()); throw new DeviceAuthError('CODE_INVALID', 'Code is invalid, expired, or already used; request a fresh code', 409); }
    p.state = 'configuring'; p.owner = owner; p.source = 'cli'; p.expiresAt = this.now() + 300_000; this.retire(p);
    return { id: p.id, browserSummary: p.browserSummary, expiresAt: p.expiresAt };
  }
  cancelOwner(owner: string): void { for (const p of this.pending.values()) if (p.owner === owner && p.state === 'configuring') { p.state = 'canceled'; this.retire(p); } }
  authorize(id: string, owner: string, values: { name: unknown; expire: unknown }): AuthDevice {
    this.requireMode(); const name = validateName(values.name); const duration = parseExpire(values.expire);
    const p = [...this.pending.values()].find(p => p.id === id && p.owner === owner);
    if (!p) throw new DeviceAuthError('PAIRING_NOT_FOUND', 'Pairing is no longer owned by this operation', 409);
    this.updatePair(p);
    if (p.state === 'authorized' && p.deviceId) return this.device(p.deviceId);
    if (p.state !== 'configuring') throw new DeviceAuthError('PAIRING_INACTIVE', 'Pairing was canceled or expired; request a new code', 409);
    const deviceId = `dev_${randomUUID().replaceAll('-', '')}`; const now = this.now();
    this.transaction(() => {
      this.db.prepare('INSERT INTO auth_devices(id,pairing_request_id,name,browser_summary,authorized_at,expires_at,last_used_at) VALUES(?,?,?,?,?,?,?)').run(deviceId, p.id, name, p.browserSummary, now, duration === null ? null : now + duration, now);
      this.db.prepare('INSERT INTO auth_sessions(id,device_id,secret_hash,origin,transport,created_at,last_used_at) VALUES(?,?,?,?,?,?,?)').run(`ses_${randomUUID().replaceAll('-', '')}`, deviceId, p.secretHash, p.origin, p.origin.startsWith('https:') ? 'https' : 'http', now, now);
    });
    p.state = 'authorized'; p.deviceId = deviceId; return this.device(deviceId);
  }
  private sweep(): void {
    try {
      for (const [key, p] of this.pending) { this.updatePair(p); if (p.expiresAt + 600_000 < this.now()) this.pending.delete(key); }
      for (const [code, until] of this.retired) if (until <= this.now()) this.retired.delete(code);
      if (this.closed || this.mode !== 'trusted-device') return;
      const expired = this.db.prepare('SELECT id FROM auth_devices WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at<=?').all(this.now()) as Array<{id:string}>;
      for (const { id } of expired) if (!this.expireNotified.has(id)) { this.expireNotified.add(id); this.notify(id); }
    } catch {
      // A storage fault must stop already-authorized streams as well as fail new requests closed.
      for (const id of this.observedDevices) this.notify(id);
      this.observedDevices.clear();
      console.error('[auth] Expiry check unavailable; device connections closed');
    }
  }
  close(): void { clearInterval(this.timer); clearInterval(this.flushTimer); try { this.flush(); } finally { this.closed = true; this.pending.clear(); } }
}
