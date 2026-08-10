import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assetFor, resolveCloudflared, drain } from '../src/cli/cloudflared.js';
import type { DownloadResponse } from '../src/cli/cloudflared.js';

// A minimal fetch-Response stand-in whose body streams the given chunks through a getReader(), so we can
// exercise the progress path without a network. content-length is optional (omit to test unknown-size).
function fakeRes(
  chunks: Buffer[],
  { contentLength, ok = true, status = 200 }: { contentLength?: number; ok?: boolean; status?: number } = {},
): DownloadResponse {
  let i = 0;
  return {
    ok, status,
    headers: { get: (k) => (k.toLowerCase() === 'content-length' && contentLength != null ? String(contentLength) : null) },
    body: { getReader: () => ({ read: async () => {
      const value = chunks[i++];
      return value ? { done: false, value } : { done: true };
    } }) },
  };
}

describe('assetFor', () => {
  it('maps macOS to a tgz', () => {
    expect(assetFor('darwin', 'arm64')).toEqual({ file: 'cloudflared-darwin-arm64.tgz', archive: 'tgz', bin: 'cloudflared' });
  });
  it('maps linux x64 to a bare amd64 binary', () => {
    expect(assetFor('linux', 'x64')).toEqual({ file: 'cloudflared-linux-amd64', archive: null, bin: 'cloudflared' });
  });
  it('maps windows to an .exe', () => {
    expect(assetFor('win32', 'x64')).toEqual({ file: 'cloudflared-windows-amd64.exe', archive: null, bin: 'cloudflared.exe' });
  });
});

describe('resolveCloudflared', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cf-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('returns the $PATH binary without downloading', async () => {
    const bin = await resolveCloudflared(home, { which: () => '/usr/local/bin/cloudflared', fetchImpl: () => { throw new Error('should not fetch'); } });
    expect(bin).toBe('/usr/local/bin/cloudflared');
  });

  it('reuses an already-downloaded binary in ~/.handmux/bin', async () => {
    const dir = path.join(home, '.handmux', 'bin');
    fs.mkdirSync(dir, { recursive: true });
    const existing = path.join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    fs.writeFileSync(existing, 'binary');
    const bin = await resolveCloudflared(home, { which: () => null, fetchImpl: () => { throw new Error('should not fetch'); } });
    expect(bin).toBe(existing);
  });

  it('streams the download and reports progress on a bare binary', async () => {
    if (process.platform === 'darwin') return; // darwin ships a tgz (needs tar); covered by the stream test on linux/win
    const chunks = [Buffer.from('AAAA'), Buffer.from('BBBB'), Buffer.from('CC')];
    const progress = vi.fn();
    const bin = await resolveCloudflared(home, {
      which: () => null,
      fetchImpl: async () => fakeRes(chunks, { contentLength: 10 }),
      log: { log: () => {} },
      progress,
    });
    expect(fs.readFileSync(bin, 'utf8')).toBe('AAAABBBBCC');
    // last progress call reports the full 10 bytes
    const last = progress.mock.calls.at(-1);
    expect(last).toEqual([10, 10]);
  });
});

describe('drain', () => {
  it('concatenates streamed chunks and reports cumulative progress with total', async () => {
    const progress = vi.fn();
    const buf = await drain(fakeRes([Buffer.from('ab'), Buffer.from('cde')], { contentLength: 5 }), progress);
    expect(buf.toString()).toBe('abcde');
    expect(progress.mock.calls).toEqual([[2, 5], [5, 5]]);
  });
  it('reports total=0 when the server sends no content-length', async () => {
    const progress = vi.fn();
    await drain(fakeRes([Buffer.from('xyz')]), progress);
    expect(progress.mock.calls).toEqual([[3, 0]]);
  });
  it('falls back to arrayBuffer() when the response is not a readable stream', async () => {
    const progress = vi.fn();
    const res = { headers: { get: () => '4' }, arrayBuffer: async () => new TextEncoder().encode('data').buffer };
    const buf = await drain(res, progress);
    expect(buf.toString()).toBe('data');
    expect(progress).toHaveBeenCalledWith(4, 4);
  });
});
