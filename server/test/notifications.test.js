import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh temp store + fresh module per call: set NOTIF_STORE, reset the module registry, then re-import
// so notifications.js re-reads the env and starts from an empty in-memory store.
async function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-'));
  process.env.NOTIF_STORE = path.join(dir, 'notifications.json');
  vi.resetModules();
  return import('../src/notifications.js');
}

describe('notifications store', () => {
  it('record appends and list returns newest-first', async () => {
    const mod = await freshModule();
    mod.record({ title: 'a', body: '1' });
    mod.record({ title: 'b', body: '2' });
    const items = mod.list();
    expect(items.length).toBe(2);
    expect(items[0].title).toBe('b'); // newest first
    expect(items[1].title).toBe('a');
    expect(items[0].id).toBeTruthy();
    expect(typeof items[0].ts).toBe('number');
  });

  it('ring buffer keeps only the last 100', async () => {
    const mod = await freshModule();
    for (let i = 0; i < 130; i++) mod.record({ title: `t${i}`, body: 'x' });
    const items = mod.list();
    expect(items.length).toBe(100);
    expect(items[0].title).toBe('t129'); // newest
    expect(items[99].title).toBe('t30'); // oldest kept (dropped t0..t29)
  });

  it('remove deletes by id', async () => {
    const mod = await freshModule();
    const rec = mod.record({ title: 'a', body: '1' });
    mod.record({ title: 'b', body: '2' });
    expect(mod.remove(rec.id)).toBe(true);
    expect(mod.remove('nope')).toBe(false);
    expect(mod.list().map((n) => n.title)).toEqual(['b']);
  });

  it('tag is stored only when present', async () => {
    const mod = await freshModule();
    mod.record({ title: 'a', body: '1' });
    mod.record({ title: 'b', body: '2', tag: 'build' });
    const [b, a] = mod.list();
    expect(a.tag).toBeUndefined();
    expect(b.tag).toBe('build');
  });

  it('url is stored only when present', async () => {
    const mod = await freshModule();
    mod.record({ title: 'a', body: '1' });
    mod.record({ title: 'b', body: '2', url: '/x' });
    const [b, a] = mod.list();
    expect(a.url).toBeUndefined();
    expect(b.url).toBe('/x');
  });

  it('corrupt store file degrades to empty at load', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-corrupt-'));
    const file = path.join(dir, 'notifications.json');
    fs.writeFileSync(file, 'not json at all');
    process.env.NOTIF_STORE = file;
    vi.resetModules();
    const mod = await import('../src/notifications.js');
    expect(mod.list()).toEqual([]); // bad file → readJsonArray returns [], never throws
    mod.record({ title: 'x', body: 'y' }); // and recording recovers over the bad file
    expect(mod.list().length).toBe(1);
  });
});
