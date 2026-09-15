import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeviceAuthError, DeviceAuthService } from './service.js';

export const authSocketPath = (home: string): string => path.join(home, '.handmux', 'auth.sock');
export class AuthControlError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AuthControlError'; }
}
export async function startDeviceAuthControl({ service, home, handlePush, handleShortcuts }: {
  service: DeviceAuthService; home: string; handlePush?: (body: unknown) => Promise<unknown>;
  handleShortcuts?: (body: unknown) => Promise<unknown> | unknown;
}): Promise<{ close(): Promise<void> }> {
  const socketPath = authSocketPath(home);
  await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(socketPath), 0o700);
  try {
    const existing = await fs.lstat(socketPath);
    if (!existing.isSocket()) throw new Error('Auth control path is not a socket; refusing to replace it');
    // The shared DB single-instance lock must already be acquired by the caller.
    await fs.unlink(socketPath);
  } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    const owner = randomUUID(); let buffer = ''; let chain = Promise.resolve();
    sockets.add(socket); socket.setTimeout(360_000, () => socket.destroy());
    socket.on('close', () => { sockets.delete(socket); service.cancelOwner(owner); });
    socket.on('error', () => {});
    socket.on('data', bytes => {
      buffer += bytes.toString('utf8');
      if (Buffer.byteLength(buffer) > 16_384) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        chain = chain.then(async () => {
          if (socket.destroyed) return;
          try {
            const input: unknown = JSON.parse(line);
            if (!input || typeof input !== 'object') throw new DeviceAuthError('INVALID_COMMAND', 'Invalid control command');
            const args = input as Record<string, unknown>; let result: unknown;
            if (args.op === 'claim') result = service.claim(args.code, owner);
            else if (args.op === 'authorize') result = service.authorize(String(args.id ?? ''), owner, { name: args.name, expire: args.expire });
            else if (args.op === 'cancel') { service.cancelOwner(owner); result = { ok: true }; }
            else if (args.op === 'device-status') result = { enabled: service.trustedDeviceEnabled, devices: service.list() };
            else if (args.op === 'device-policy') { service.setTrustedDeviceEnabled(args.enabled === true); result = { enabled: service.trustedDeviceEnabled }; }
            else if (args.op === 'device-list') result = service.list();
            else if (args.op === 'device-edit') result = service.edit(String(args.id ?? ''), { name: args.name, expire: args.expire });
            else if (args.op === 'device-revoke') result = service.revoke(String(args.id ?? ''));
            else if (args.op === 'address-status') result = { enabled: service.trustedOriginEnabled, origins: service.trustedOrigins };
            else if (args.op === 'address-policy') { service.setTrustedOriginEnabled(args.enabled === true); result = { enabled: service.trustedOriginEnabled }; }
            else if (args.op === 'address-add') result = { origins: service.addTrustedOrigin(args.origin) };
            else if (args.op === 'address-remove') result = { origins: service.removeTrustedOrigin(args.origin) };
            else if (args.op === 'push' && handlePush) result = await handlePush(args.body);
            else if (args.op === 'shortcuts' && handleShortcuts) result = await handleShortcuts(args.body);
            else throw new DeviceAuthError('INVALID_COMMAND', 'Unknown control command');
            if (!socket.destroyed) socket.write(`${JSON.stringify({ ok: true, result })}\n`);
          } catch (error) {
            if (!socket.destroyed) socket.write(`${JSON.stringify({ ok: false, error: error instanceof DeviceAuthError ? error.code : 'AUTH_UNAVAILABLE', message: error instanceof DeviceAuthError ? error.message : 'Authentication operation unavailable; retry or restart handmux' })}\n`);
          }
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
  await fs.chmod(socketPath, 0o600);
  return { close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.unlink(socketPath).catch(() => {}); } };
}

export async function connectAuthControl(home: string): Promise<{ request(args: Record<string, unknown>): Promise<unknown>; close(): void }> {
  const socket = net.createConnection(authSocketPath(home)); let buffer = '';
  let terminalError: Error | undefined;
  let pending: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  const fail = (error: Error): void => { terminalError = error; pending?.reject(error); pending = undefined; };
  socket.on('error', fail); socket.on('close', () => fail(new Error('handmux control connection closed; start handmux and retry')));
  socket.setTimeout(360_000, () => socket.destroy(new Error('Device setup timed out; pair again')));
  socket.on('data', bytes => {
    buffer += bytes.toString('utf8');
    if (buffer.length > 4_000_000) { socket.destroy(new Error('Control response exceeds limit')); return; }
    const newline = buffer.indexOf('\n'); if (newline < 0) return;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    try {
      const out = JSON.parse(line) as { ok: boolean; result?: unknown; error?: string; message?: string };
      const p = pending; pending = undefined;
      if (out.ok) p?.resolve(out.result);
      else p?.reject(new AuthControlError(out.error ?? 'AUTH_UNAVAILABLE', out.message ?? 'Authentication command unavailable; retry or restart handmux'));
    } catch { fail(new Error('Invalid handmux control response')); }
  });
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return {
    request(args) {
      if (terminalError || socket.destroyed || !socket.writable) return Promise.reject(terminalError ?? new Error('handmux control connection closed; start handmux and pair again'));
      if (pending) return Promise.reject(new Error('Control command already pending'));
      return new Promise((resolve, reject) => { pending = { resolve, reject }; socket.write(`${JSON.stringify(args)}\n`); });
    },
    close() { socket.destroy(); },
  };
}
