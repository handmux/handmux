import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh temp NOTIF_DIR + fresh module per call, so each test starts from empty per-device files.
async function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-'));
  process.env.NOTIF_DIR = dir;
  vi.resetModules();
  return import('../src/notifications.js');
}

describe('per-device notifications store', () => {
  it('record writes only to the target devices; list is per-device newest-first', async () => {
    const mod = await freshModule();
    mod.record(['k1'], { title: 'a', body: '1' });
    mod.record(['k1', 'k2'], { title: 'b', body: '2' });
    expect(mod.list('k1').map((n) => n.title)).toEqual(['b', 'a']); // newest first
    expect(mod.list('k2').map((n) => n.title)).toEqual(['b']);
    expect(mod.list('k3')).toEqual([]); // untargeted device
    expect(fs.statSync(path.join(process.env.NOTIF_DIR, 'k1.json')).mode & 0o777).toBe(0o600);
  });

  it('the same push shares one id across target devices', async () => {
    const mod = await freshModule();
    const rec = mod.record(['k1', 'k2'], { title: 'a', body: '1' });
    expect(mod.list('k1')[0].id).toBe(rec.id);
    expect(mod.list('k2')[0].id).toBe(rec.id);
  });

  it('updates delivery status for one device without changing another device\'s copy', async () => {
    const mod = await freshModule();
    const rec = mod.record(['k1', 'k2'], {
      title: 'a', body: '1', delivery: { status: 'pending' },
    });
    expect(mod.updateDelivery('k1', rec.id, { status: 'success' })).toBe(true);
    expect(mod.updateDelivery('k2', rec.id, { status: 'failed', reason: 'rate_limited' })).toBe(true);
    expect(mod.list('k1')[0].delivery).toEqual({ status: 'success' });
    expect(mod.list('k2')[0].delivery).toEqual({ status: 'failed', reason: 'rate_limited' });
  });

  it('tag and url stored only when present', async () => {
    const mod = await freshModule();
    mod.record(['k1'], { title: 'a', body: '1' });
    mod.record(['k1'], { title: 'b', body: '2', tag: 't', url: '/x' });
    const [b, a] = mod.list('k1');
    expect(a.tag).toBeUndefined();
    expect(a.url).toBeUndefined();
    expect(b.tag).toBe('t');
    expect(b.url).toBe('/x');
  });

  it('never persists a notification link with a non-web protocol', async () => {
    const mod = await freshModule();
    mod.record(['k1'], { title: 'a', body: '1', url: 'javascript:alert(1)' });
    expect(mod.list('k1')[0].url).toBeUndefined();
  });

  it('ring buffer keeps the last 100 per device', async () => {
    const mod = await freshModule();
    for (let i = 0; i < 130; i++) mod.record(['k1'], { title: `t${i}`, body: 'x' });
    const items = mod.list('k1');
    expect(items.length).toBe(100);
    expect(items[0].title).toBe('t129');
    expect(items[99].title).toBe('t30');
  });

  it('remove deletes by id within a device only', async () => {
    const mod = await freshModule();
    const rec = mod.record(['k1', 'k2'], { title: 'a', body: '1' });
    expect(mod.remove('k1', rec.id)).toBe(true);
    expect(mod.remove('k1', 'nope')).toBe(false);
    expect(mod.list('k1')).toEqual([]);
    expect(mod.list('k2').length).toBe(1); // other device untouched
  });

  it('unsafe pushKey cannot escape the store dir', async () => {
    const mod = await freshModule();
    // '../evil' sanitizes to 'evil'; a key of only unsafe chars is skipped (no file, empty list)
    mod.record(['../evil'], { title: 'a', body: '1' });
    expect(mod.list('../evil').length).toBe(1); // same sanitization on read → 'evil.json'
    expect(mod.list('/')).toEqual([]); // sanitizes to '' → skipped
  });

  it('corrupt device file degrades to empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-corrupt-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'k1.json'), 'not json');
    process.env.NOTIF_DIR = dir;
    vi.resetModules();
    const mod = await import('../src/notifications.js');
    expect(mod.list('k1')).toEqual([]);
    mod.record(['k1'], { title: 'x', body: 'y' });
    expect(mod.list('k1').length).toBe(1);
  });
});
