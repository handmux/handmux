// server/test/upload.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiRouter } from '../src/httpApi.js';
import { createDocs } from '../src/docs.js';

let home, app;
const auth = (r) => r.set('Authorization', 'Bearer good');

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'twup-'));
  await fs.mkdir(join(home, 'sub'));
  await fs.mkdir(join(home, '.hidden'));
  await fs.writeFile(join(home, 'sub', 'exists.txt'), 'old');
  app = express();
  app.use('/api', createApiRouter({
    token: 'good', commands: {},
    docs: createDocs({ home }),
    uploadExts: new Set(['txt', 'png', 'zip']),
    maxUploadBytes: 32, // tiny cap → >32 bytes trips 413
  }));
});
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

const post = () => auth(request(app).post('/api/upload'));

describe('POST /api/upload', () => {
  it('requires auth', async () => {
    await request(app).post('/api/upload').field('dir', join(home, 'sub')).attach('file', Buffer.from('hi'), 'a.txt').expect(401);
  });
  it('uploads a file into a subdir (201) and writes it', async () => {
    const res = await post().field('dir', join(home, 'sub')).attach('file', Buffer.from('hi'), 'a.txt').expect(201);
    expect(res.body).toMatchObject({ name: 'a.txt', size: 2 });
    expect(await fs.readFile(join(home, 'sub', 'a.txt'), 'utf8')).toBe('hi');
  });
  it('uploads a ZIP archive when ZIP is allowed', async () => {
    const body = Buffer.from('PK\u0003\u0004test');
    const res = await post().field('dir', join(home, 'sub')).attach('file', body, 'bundle.zip').expect(201);
    expect(res.body).toMatchObject({ name: 'bundle.zip', size: body.length });
    expect(await fs.readFile(join(home, 'sub', 'bundle.zip'))).toEqual(body);
  });
  it('preserves a UTF-8 (Chinese) filename instead of mangling it to latin1 mojibake', async () => {
    const res = await post().field('dir', join(home, 'sub')).attach('file', Buffer.from('hi'), '中文报告.txt').expect(201);
    expect(res.body).toMatchObject({ name: '中文报告.txt', size: 2 });
    expect(await fs.readdir(join(home, 'sub'))).toContain('中文报告.txt');
  });
  it('auto-suffixes a name that already exists (never overwrites)', async () => {
    const res = await post().field('dir', join(home, 'sub')).attach('file', Buffer.from('new'), 'exists.txt').expect(201);
    expect(res.body).toMatchObject({ name: 'exists (1).txt', size: 3 });   // Finder-style "(n)" suffix
    expect(await fs.readFile(join(home, 'sub', 'exists.txt'), 'utf8')).toBe('old');       // original untouched
    expect(await fs.readFile(join(home, 'sub', 'exists (1).txt'), 'utf8')).toBe('new');   // new file beside it
  });
  it('415s a disallowed extension', async () => {
    await post().field('dir', join(home, 'sub')).attach('file', Buffer.from('x'), 'a.exe').expect(415);
  });
  it('400s the home root as target', async () => {
    await post().field('dir', home).attach('file', Buffer.from('x'), 'a.txt').expect(400);
  });
  it('400s a hidden directory as target', async () => {
    await post().field('dir', join(home, '.hidden')).attach('file', Buffer.from('x'), 'a.txt').expect(400);
  });
  it('400s a dotfile name and writes nothing', async () => {
    await post().field('dir', join(home, 'sub')).attach('file', Buffer.from('x'), '.secret').expect(400);
    expect(await fs.readdir(join(home, 'sub'))).toEqual(['exists.txt']);
  });
  it('413s a file over the cap and leaves no temp file', async () => {
    await post().field('dir', join(home, 'sub')).attach('file', Buffer.alloc(100, 1), 'big.txt').expect(413);
    expect(await fs.readdir(join(home, 'sub'))).toEqual(['exists.txt']); // no .big.txt.uploading-*
  });
  it('accepts a file of exactly maxUploadBytes (cap is inclusive)', async () => {
    const res = await post().field('dir', join(home, 'sub')).attach('file', Buffer.alloc(32, 1), 'cap.txt').expect(201);
    expect(res.body).toMatchObject({ name: 'cap.txt', size: 32 });
  });
});
