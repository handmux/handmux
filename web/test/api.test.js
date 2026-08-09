import { describe, it, expect, vi, afterEach } from 'vitest';
import { getHistory, getPanes, createSession, createWindow, renameSession, renameWindow, deleteWindow, swapWindows, createDir, UnauthorizedError, ApiError, fetchDoc, fetchDir, signAsr, sendInput, parseSseFrames, streamCodexMessages, sendCodexMessage } from '../src/api.js';
import { createPreview, getPreviews, deletePreview, previewUrl, fetchImageUrl } from '../src/api.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

const jsonRes = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

describe('Codex message stream', () => {
  it('parses complete SSE frames and retains a split trailing frame', () => {
    expect(parseSseFrames('data: {"type":"ready"}\n\ndata: {"type":"events"'))
      .toEqual({ frames: ['{"type":"ready"}'], rest: 'data: {"type":"events"' });
  });

  it('keeps bearer auth and expands batched SSE payloads in order', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'stream-token' });
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"type":"ready","threadId":"thread-1"}\n\n',
      'data: {"type":"events","events":[{"type":"delta","delta":"你"},',
      '{"type":"completed","text":"你好"}]}\n\n',
    ].map((value) => encoder.encode(value));
    const reader = {
      read: vi.fn(async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true })),
      releaseLock: vi.fn(),
    };
    const fetchMock = vi.fn(async () => ({
      status: 200, ok: true, body: { getReader: () => reader },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const events = [];

    await streamCodexMessages('%7', { onEvent: (event) => events.push(event) });

    expect(fetchMock).toHaveBeenCalledWith('/api/codex/stream?pane=%257', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer stream-token' }),
    }));
    expect(events).toEqual([
      { type: 'ready', threadId: 'thread-1' },
      { type: 'delta', delta: '你' },
      { type: 'completed', text: '你好' },
    ]);
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });
});

describe('api request timeout', () => {
  it('aborts getHistory after its timeout and rejects with a non-auth error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((url, opts) => new Promise((_, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const p = getHistory('%1').catch((e) => e); // capture the rejection
    await vi.advanceTimersByTimeAsync(8000);    // fire the abort timer
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnauthorizedError);
  });

  it('also times out the pane lookup used during window switching', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, opts) => new Promise((_, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const p = getPanes('@1').catch((e) => e);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await p).toBeInstanceOf(Error);
  });

  it('returns the json on a normal response (timeout cleared, no abort)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, { ansi: 'x', width: 80, height: 24 })));
    await expect(getHistory('%1')).resolves.toEqual({ ansi: 'x', width: 80, height: 24 });
  });

  it('sends the stable Codex request id used to reconcile an uncertain response', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, { queued: true }));
    vi.stubGlobal('fetch', fetchMock);

    await sendCodexMessage('%1', 'next turn', 'codex-send-request-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/codex/send', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ pane: '%1', text: 'next turn', requestId: 'codex-send-request-1' }),
    }));
  });

  it('still maps 401 to UnauthorizedError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(401, { error: 'unauthorized' })));
    await expect(getHistory('%1')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('a non-2xx error carries the status + server token as structured fields (message stays the token)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(409, { error: 'exists' })));
    const err = await renameSession('$1', 'taken').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.serverError).toBe('exists');
    expect(err.message).toBe('exists'); // backward-compatible message
  });

  it('a non-2xx with no json body still carries the status (serverError null)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 500, ok: false, json: async () => { throw new Error('no body'); } })));
    const err = await deleteWindow('@1').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.serverError).toBeNull();
  });

  it('treats a 204 response as an unchanged sentinel (never parses the body)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 204, ok: true, json: async () => { throw new Error('must not parse a 204'); },
    })));
    await expect(getHistory('%1')).resolves.toEqual({ unchanged: true });
  });

  it('passes the last hash as ?since', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, { ansi: 'x', width: 80, height: 24, hash: 'h2' }));
    vi.stubGlobal('fetch', fetchMock);
    await getHistory('%1', 100, 'h1');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('since=h1'), expect.any(Object));
  });

  it('createSession POSTs to /api/sessions with the name', async () => {
    const fetchMock = vi.fn(async () => jsonRes(201, { id: '$7', name: 'new-sess' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createSession('new-sess')).resolves.toEqual({ id: '$7', name: 'new-sess' });
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: 'new-sess' }),
    }));
  });

  it('createWindow POSTs to /api/windows with session + pane + name', async () => {
    const fetchMock = vi.fn(async () => jsonRes(201, { id: '@9' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createWindow('$0', '%1', 'build-1')).resolves.toEqual({ id: '@9' });
    expect(fetchMock).toHaveBeenCalledWith('/api/windows', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ session: '$0', pane: '%1', name: 'build-1' }),
    }));
  });

  it('createWindow drops name from the body when it is undefined (auto-name)', async () => {
    const fetchMock = vi.fn(async () => jsonRes(201, { id: '@9' }));
    vi.stubGlobal('fetch', fetchMock);
    await createWindow('$0', '%1', undefined);
    expect(fetchMock).toHaveBeenCalledWith('/api/windows', expect.objectContaining({
      body: JSON.stringify({ session: '$0', pane: '%1' }), // JSON.stringify omits undefined
    }));
  });

  it('createSession includes cwd in the body only when given', async () => {
    const fetchMock = vi.fn(async () => jsonRes(201, { id: '$8', name: 'web' }));
    vi.stubGlobal('fetch', fetchMock);
    await createSession('web', '/home/u/proj');
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: 'web', cwd: '/home/u/proj' }),
    }));
    vi.unstubAllGlobals();
    const fetchMock2 = vi.fn(async () => jsonRes(201, { id: '$9', name: 'web' }));
    vi.stubGlobal('fetch', fetchMock2);
    await createSession('web');
    expect(fetchMock2).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: 'web' }),
    }));
  });

  it('createWindow includes cwd in the body only when given', async () => {
    const fetchMock = vi.fn(async () => jsonRes(201, { id: '@10' }));
    vi.stubGlobal('fetch', fetchMock);
    await createWindow('$0', '%1', 'build', '/home/u/sub');
    expect(fetchMock).toHaveBeenCalledWith('/api/windows', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ session: '$0', pane: '%1', name: 'build', cwd: '/home/u/sub' }),
    }));
    vi.unstubAllGlobals();
    const fetchMock2 = vi.fn(async () => jsonRes(201, { id: '@11' }));
    vi.stubGlobal('fetch', fetchMock2);
    await createWindow('$0', '%1', 'build');
    expect(fetchMock2).toHaveBeenCalledWith('/api/windows', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ session: '$0', pane: '%1', name: 'build' }),
    }));
  });

  it('createDir posts dir and name', async () => {
    const fetchMock = vi.fn(async () => jsonRes(201, { path: '/home/u/proj/new' }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await createDir('/home/u/proj', 'new');
    expect(fetchMock).toHaveBeenCalledWith('/api/dir', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ dir: '/home/u/proj', name: 'new' }),
    }));
    expect(res.path).toBe('/home/u/proj/new');
  });

  it('sendInput POSTs pane plus hex bytes', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendInput('%1', '611b5b41')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/input', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ pane: '%1', hex: '611b5b41' }),
    }));
  });

  it('renameSession PATCHes /api/sessions with id + name', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, { id: '$0', name: 'prod' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(renameSession('$0', 'prod')).resolves.toEqual({ id: '$0', name: 'prod' });
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ id: '$0', name: 'prod' }),
    }));
  });

  it('renameWindow PATCHes /api/windows with id + name', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, { id: '@1', name: 'build' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(renameWindow('@1', 'build')).resolves.toEqual({ id: '@1', name: 'build' });
    expect(fetchMock).toHaveBeenCalledWith('/api/windows', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ id: '@1', name: 'build' }),
    }));
  });

  it('swapWindows POSTs to /api/windows/swap with the two ids', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(swapWindows('@1', '@2')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/windows/swap', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ a: '@1', b: '@2' }),
    }));
  });

  it('deleteWindow DELETEs /api/windows with the id in the query (204 → unchanged sentinel)', async () => {
    const fetchMock = vi.fn(async () => ({ status: 204, ok: true, json: async () => { throw new Error('no body'); } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(deleteWindow('@2')).resolves.toEqual({ unchanged: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/windows?window=%402', expect.objectContaining({ method: 'DELETE' }));
  });
});

describe('docs api', () => {
  it('fetchDoc requests /api/file with an encoded path', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ name: 'a.md', type: 'markdown', content: '# x' }) }));
    const out = await fetchDoc('/home/u/a b.md');
    expect(global.fetch).toHaveBeenCalledWith('/api/file?path=%2Fhome%2Fu%2Fa%20b.md', expect.any(Object));
    expect(out).toEqual({ name: 'a.md', type: 'markdown', content: '# x' });
  });
  it('fetchDir omits the query when path is falsy', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ entries: [] }) }));
    await fetchDir();
    expect(global.fetch).toHaveBeenCalledWith('/api/dir', expect.any(Object));
  });
  it('fetchDir adds an encoded path when given', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ entries: [] }) }));
    await fetchDir('/home/u');
    expect(global.fetch).toHaveBeenCalledWith('/api/dir?path=%2Fhome%2Fu', expect.any(Object));
  });
});

describe('asr api', () => {
  it('signAsr GETs /api/asr/sign and returns {url, appId}', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ url: 'wss://x/v2/iat?a=1', appId: 'A1' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await signAsr();
    expect(fetchMock).toHaveBeenCalledWith('/api/asr/sign', expect.objectContaining({ cache: 'no-store' }));
    expect(out).toEqual({ url: 'wss://x/v2/iat?a=1', appId: 'A1' });
  });
});

describe('previews api', () => {
  it('previewUrl builds a static token-carrying path for a static entry', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'tok123' });
    expect(previewUrl({ name: 'main-build-3', url: '/preview/main-build-3/preview-only/' }))
      .toBe('/preview/main-build-3/preview-only/');
    expect(previewUrl({ name: 'main-build-3', kind: 'static' })).toBeNull();
  });
  it('createPreview POSTs {name,dir} for a static start', async () => {
    const fetch = vi.fn(async () => jsonRes(200, { name: 'foo', kind: 'static', url: '/preview/foo/preview-only/', expiresAt: 9 }));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('localStorage', { getItem: () => 't' });
    await expect(createPreview('foo', { dir: '/home/u/site' })).resolves.toMatchObject({ name: 'foo' });
    const [, opts] = fetch.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ name: 'foo', dir: '/home/u/site' });
  });
  it('getPreviews GETs the list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, { previews: [] })));
    vi.stubGlobal('localStorage', { getItem: () => 't' });
    await expect(getPreviews()).resolves.toEqual({ previews: [] });
  });
  it('deletePreview DELETEs by name (encoded)', async () => {
    const fetch = vi.fn(async () => jsonRes(204));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('localStorage', { getItem: () => 't' });
    await deletePreview('a b');
    expect(fetch.mock.calls[0][0]).toBe('/api/previews/a%20b');
    expect(fetch.mock.calls[0][1].method).toBe('DELETE');
  });
});

describe('fetchImageUrl', () => {
  it('GETs /api/download as a blob (Bearer) and resolves { url, mtimeMs } from X-Mtime', async () => {
    let inst;
    vi.stubGlobal('localStorage', { getItem: () => 'tok' });
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:img'), revokeObjectURL: vi.fn() });
    vi.stubGlobal('XMLHttpRequest', vi.fn(function XHR() {
      inst = this;
      this.open = vi.fn(); this.setRequestHeader = vi.fn();
      this.getResponseHeader = vi.fn((h) => (h === 'X-Mtime' ? '1717' : null));
      this.send = vi.fn(() => { this.status = 200; this.response = new Blob(['x'], { type: 'image/png' }); this.onload(); });
    }));
    const res = await fetchImageUrl('/home/u/pics/a.png');
    expect(res).toEqual({ url: 'blob:img', mtimeMs: 1717 });
    expect(inst.open).toHaveBeenCalledWith('GET', '/api/download?path=%2Fhome%2Fu%2Fpics%2Fa.png');
    expect(inst.setRequestHeader).toHaveBeenCalledWith('Authorization', 'Bearer tok');
    expect(inst.responseType).toBe('blob');
  });
  it('conditional: passes &mtime= and resolves { notModified } on 304 (no object URL created)', async () => {
    let inst;
    const createObjectURL = vi.fn(() => 'blob:should-not-be-used');
    vi.stubGlobal('localStorage', { getItem: () => 'tok' });
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
    vi.stubGlobal('XMLHttpRequest', vi.fn(function XHR() {
      inst = this;
      this.open = vi.fn(); this.setRequestHeader = vi.fn(); this.getResponseHeader = vi.fn();
      this.send = vi.fn(() => { this.status = 304; this.onload(); });
    }));
    const res = await fetchImageUrl('/home/u/pics/a.png', 1717);
    expect(res).toEqual({ notModified: true });
    expect(inst.open).toHaveBeenCalledWith('GET', '/api/download?path=%2Fhome%2Fu%2Fpics%2Fa.png&mtime=1717');
    expect(createObjectURL).not.toHaveBeenCalled();
  });
  it('rejects with UnauthorizedError on 401', async () => {
    vi.stubGlobal('localStorage', { getItem: () => '' });
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() });
    vi.stubGlobal('XMLHttpRequest', vi.fn(function XHR() {
      this.open = vi.fn(); this.setRequestHeader = vi.fn();
      this.send = vi.fn(() => { this.status = 401; this.onload(); });
    }));
    await expect(fetchImageUrl('/home/u/a.png')).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
