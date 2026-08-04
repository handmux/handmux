// NOTE: this project's server suite runs on VITEST (describe/it/expect), not node:test.
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pageTranscript, transcriptRoutes } from '../src/routes/transcript.js';
import { encodeProjectDir } from '../src/agents/scanUtils.js';
import { claudeContextDir } from '../src/usage.js';

async function call(app, url) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`);
    const body = res.status === 204 ? null : await res.json();
    return { status: res.status, body };
  } finally { server.close(); }
}

// N alternating user/assistant messages, text = "msg-0", "msg-1", ... "msg-(N-1)" — so each message's k
// (its global ordinal) is recoverable from its own text for assertions.
const N = 15;

function fixtureSession(cwd) {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'test-sess.jsonl');
  const lines = [];
  for (let k = 0; k < N; k++) {
    const role = k % 2 === 0 ? 'user' : 'assistant';
    lines.push(JSON.stringify({ type: role, cwd, message: { role, content: 'msg-' + k } }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// Stub claudeEvents whose paneSession always returns null — exercises the fallback (cwd→newest) path,
// same as the pre-Task-14 behavior all the existing tests assert on.
const noHook = { paneSession: () => null };

describe('pageTranscript', () => {
  const parsed = Array.from({ length: N }, (_, k) => ({ text: `msg-${k}` }));

  it('returns the recent page with stable global ordinals', () => {
    expect(pageTranscript(parsed, null, 4)).toEqual({
      messages: [
        { text: 'msg-11', k: 11 }, { text: 'msg-12', k: 12 },
        { text: 'msg-13', k: 13 }, { text: 'msg-14', k: 14 },
      ],
      firstSeq: 11,
      hasMore: true,
    });
  });

  it('uses before as an exclusive, bounded history cursor', () => {
    expect(pageTranscript(parsed, 11, 4)).toEqual({
      messages: [
        { text: 'msg-7', k: 7 }, { text: 'msg-8', k: 8 },
        { text: 'msg-9', k: 9 }, { text: 'msg-10', k: 10 },
      ],
      firstSeq: 7,
      hasMore: true,
    });
    expect(pageTranscript(parsed, -5, 4)).toEqual({ messages: [], firstSeq: null, hasMore: false });
    expect(pageTranscript(parsed, 999, 4).messages.map((m) => m.k)).toEqual([11, 12, 13, 14]);
  });

  it('touches only the requested page, never every message in a long transcript', () => {
    const accessed = [];
    const long = new Proxy(Array.from({ length: 1000 }, (_, k) => ({ text: `msg-${k}` })), {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) accessed.push(Number(prop));
        return Reflect.get(target, prop, receiver);
      },
    });
    const page = pageTranscript(long, null, 10);
    expect(page.messages.map((m) => m.k)).toEqual([990, 991, 992, 993, 994, 995, 996, 997, 998, 999]);
    expect(accessed).toEqual([990, 991, 992, 993, 994, 995, 996, 997, 998, 999]);
  });
});

describe('GET /api/transcript', () => {
  it('resolves and parses a Codex rollout by cwd when hook metadata is unavailable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-route-'));
    const cwd = '/tmp/codex-route-cwd';
    const day = path.join(root, '2026', '08', '04');
    fs.mkdirSync(day, { recursive: true });
    const file = path.join(day, 'rollout-2026-08-04T00-00-00-aaaaaaaa-0000-0000-0000-000000000001.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'aaaaaaaa-0000-0000-0000-000000000001', cwd } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'from-codex' }] } }),
    ].join('\n') + '\n');
    const app = express();
    app.use(transcriptRoutes({
      commands: { paneCurrentPath: async () => cwd },
      claudeEvents: noHook,
      codexDir: root,
    }));
    try {
      const { status, body } = await call(app, '/transcript?pane=%251&agent=codex');
      expect(status).toBe(200);
      expect(body.messages.map((m) => m.text)).toEqual(['from-codex']);
      expect(body.session).toBe('aaaaaaaa-0000-0000-0000-000000000001');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('409s when hook state binds the pane to Codex even if the caller claims Claude', async () => {
    const app = express();
    app.use(transcriptRoutes({
      commands: { paneCurrentPath: async () => '/shared' },
      claudeEvents: { paneSession: () => null, paneAgent: () => 'codex' },
    }));
    const { status } = await call(app, '/transcript?pane=%251&agent=claude');
    expect(status).toBe(409);
  });

  it('uses the Codex parser for the hook-bound rollout path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-route-hook-'));
    const file = path.join(dir, 'rollout-aaaaaaaa-0000-0000-0000-000000000002.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hooked-codex' }] } }) + '\n');
    const app = express();
    app.use(transcriptRoutes({
      commands: {},
      claudeEvents: {
        paneAgent: () => 'codex',
        paneSession: () => ({ agent: 'codex', sessionId: 'aaaaaaaa-0000-0000-0000-000000000002', transcriptPath: file }),
      },
    }));
    try {
      const { status, body } = await call(app, '/transcript?pane=%251&agent=codex');
      expect(status).toBe(200);
      expect(body.messages.map((m) => m.text)).toEqual(['hooked-codex']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns normalized messages for a pane', async () => {
    const cwd = path.join(os.tmpdir(), 'chatlens-fixture-' + process.pid);
    const file = fixtureSession(cwd);
    const app = express();
    app.use(transcriptRoutes({ commands: { paneCurrentPath: async () => cwd }, claudeEvents: noHook }));
    try {
      const { status, body } = await call(app, '/transcript?pane=%25' + '0');
      expect(status).toBe(200);
      expect(body.hash).toBeTruthy();
    } finally { fs.rmSync(file, { force: true }); }
  });

  it('400 on bad pane id', async () => {
    const app = express();
    app.use(transcriptRoutes({ commands: { paneCurrentPath: async () => '/x' }, claudeEvents: noHook }));
    const { status } = await call(app, '/transcript?pane=notapane');
    expect(status).toBe(400);
  });

  it('default limit returns only the last 10 messages, with hasMore + firstSeq', async () => {
    const cwd = path.join(os.tmpdir(), 'chatlens-fixture-limit-' + process.pid);
    const file = fixtureSession(cwd);
    const app = express();
    app.use(transcriptRoutes({ commands: { paneCurrentPath: async () => cwd }, claudeEvents: noHook }));
    try {
      const { status, body } = await call(app, '/transcript?pane=%250');
      expect(status).toBe(200);
      expect(body.messages).toHaveLength(10);
      // Last 10 of N=15 → k = 5..14
      expect(body.messages[0].text).toBe('msg-5');
      expect(body.messages[9].text).toBe('msg-14');
      expect(body.messages[0].k).toBe(5);
      expect(body.messages[9].k).toBe(14);
      expect(body.hasMore).toBe(true);
      expect(body.firstSeq).toBe(5);
    } finally { fs.rmSync(file, { force: true }); }
  });

  it('before cursor pages the older batch (k < before)', async () => {
    const cwd = path.join(os.tmpdir(), 'chatlens-fixture-before-' + process.pid);
    const file = fixtureSession(cwd);
    const app = express();
    app.use(transcriptRoutes({ commands: { paneCurrentPath: async () => cwd }, claudeEvents: noHook }));
    try {
      const first = await call(app, '/transcript?pane=%250');
      const firstSeq = first.body.firstSeq;
      expect(firstSeq).toBe(5);

      const { status, body } = await call(app, `/transcript?pane=%250&before=${firstSeq}&limit=10`);
      expect(status).toBe(200);
      // Older batch: k < 5 → only k = 0..4 exist (5 messages), fewer than limit.
      expect(body.messages).toHaveLength(5);
      expect(body.messages[0].k).toBe(0);
      expect(body.messages[0].text).toBe('msg-0');
      expect(body.messages[4].k).toBe(4);
      expect(body.messages[4].text).toBe('msg-4');
      expect(body.firstSeq).toBe(0);
      expect(body.hasMore).toBe(false);
      expect(body.hash).toBeUndefined();
    } finally { fs.rmSync(file, { force: true }); }
  });

  it('204 when the window hash is unchanged (not the whole file)', async () => {
    const cwd = path.join(os.tmpdir(), 'chatlens-fixture-hash-' + process.pid);
    const file = fixtureSession(cwd);
    const app = express();
    app.use(transcriptRoutes({ commands: { paneCurrentPath: async () => cwd }, claudeEvents: noHook }));
    try {
      const first = await call(app, '/transcript?pane=%250');
      const { status } = await call(app, `/transcript?pane=%250&since=${first.body.hash}`);
      expect(status).toBe(204);
    } finally { fs.rmSync(file, { force: true }); }
  });

  it('ISOLATION: two panes sharing the same cwd get their OWN sessions via hook transcript_path (regression lock)', async () => {
    // Two Claude sessions can share a cwd (verified real on this machine) — cwd→newest would collapse
    // both panes onto the SAME session. The hook state's per-pane transcript_path must keep them apart.
    const cwd = path.join(os.tmpdir(), 'chatlens-fixture-isolation-' + process.pid);
    const dir = path.join(os.tmpdir(), 'chatlens-isolation-sessions-' + process.pid);
    fs.mkdirSync(dir, { recursive: true });
    const fileA = path.join(dir, 'sess-a.jsonl');
    const fileB = path.join(dir, 'sess-b.jsonl');
    fs.writeFileSync(fileA, JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'from-A' } }) + '\n');
    fs.writeFileSync(fileB, JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'from-B' } }) + '\n');
    const claudeEvents = {
      paneSession: (pane) => {
        if (pane === '%1') return { sessionId: 'sess-a', transcriptPath: fileA, cwd };
        if (pane === '%2') return { sessionId: 'sess-b', transcriptPath: fileB, cwd };
        return null;
      },
    };
    const app = express();
    app.use(transcriptRoutes({ commands: { paneCurrentPath: async () => cwd }, claudeEvents }));
    try {
      const a = await call(app, '/transcript?pane=%251');
      const b = await call(app, '/transcript?pane=%252');
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.messages.map((m) => m.text)).toContain('from-A');
      expect(b.body.messages.map((m) => m.text)).toContain('from-B');
      expect(a.body.session).toBe('sess-a');
      expect(b.body.session).toBe('sess-b');
      // The core regression assertion: they must NOT show the same conversation.
      expect(a.body.messages).not.toEqual(b.body.messages);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('FALLBACK: paneSession returns null → resolves via cwd→newest (existing behavior)', async () => {
    const cwd = path.join(os.tmpdir(), 'chatlens-fixture-fallback-' + process.pid);
    const file = fixtureSession(cwd);
    const app = express();
    app.use(transcriptRoutes({ commands: { paneCurrentPath: async () => cwd }, claudeEvents: noHook }));
    try {
      const { status, body } = await call(app, '/transcript?pane=%25' + '0');
      expect(status).toBe(200);
      expect(body.messages.length).toBeGreaterThan(0);
    } finally { fs.rmSync(file, { force: true }); }
  });
});

describe('GET /api/pending-prompt', () => {
  const menu = [' ☐ 颜色', '', '你喜欢哪个?', '', '❯ 1. 红色', '  2. 蓝色',
    '  3. Chat about this', 'Enter to select · Esc to cancel'].join('\n');
  const mount = (capturePlain) =>
    transcriptRoutes({ commands: { capturePlain }, claudeEvents: noHook });

  it('scrapes the on-screen menu into structured options', async () => {
    const app = express();
    app.use(mount(async () => menu));
    const { status, body } = await call(app, '/pending-prompt?pane=%251');
    expect(status).toBe(200);
    expect(body.prompt.kind).toBe('question');
    expect(body.prompt.options).toEqual([
      { n: 1, label: '红色', description: '' },
      { n: 2, label: '蓝色', description: '' },
    ]); // "Chat about this" meta-option dropped
  });

  it('returns prompt:null when no menu is on screen', async () => {
    const app = express();
    app.use(mount(async () => 'just a shell\n$ '));
    const { status, body } = await call(app, '/pending-prompt?pane=%251');
    expect(status).toBe(200);
    expect(body.prompt).toBeNull();
  });

  it('400 on bad pane id', async () => {
    const app = express();
    app.use(mount(async () => menu));
    const { status } = await call(app, '/pending-prompt?pane=nope');
    expect(status).toBe(400);
  });

  it('rejects Codex before capture-pane because its approval keys are not Claude-compatible', async () => {
    const capturePlain = vi.fn();
    const app = express();
    app.use(transcriptRoutes({ commands: { capturePlain }, claudeEvents: noHook }));
    const { status } = await call(app, '/pending-prompt?pane=%251&agent=codex');
    expect(status).toBe(409);
    expect(capturePlain).not.toHaveBeenCalled();
  });
});

describe('GET /api/context', () => {
  const sid = 'ctxtest-' + process.pid;
  const withSession = { paneSession: () => ({ sessionId: sid }) };
  const writeCtx = (snap) => {
    const dir = claudeContextDir();
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, sid + '.json');
    fs.writeFileSync(f, JSON.stringify(snap));
    return f;
  };

  it('joins pane→session→snapshot and returns { model, usedPercent }', async () => {
    const f = writeCtx({ sessionId: sid, model: 'Opus 4.8 (1M context)', usedPercent: 24, updatedAt: 1 });
    const app = express();
    app.use(transcriptRoutes({ commands: {}, claudeEvents: withSession }));
    try {
      const { status, body } = await call(app, '/context?pane=%251');
      expect(status).toBe(200);
      expect(body).toEqual({ model: 'Opus 4.8 (1M context)', usedPercent: 24 });
    } finally { fs.rmSync(f, { force: true }); }
  });

  it('returns nulls when no per-session snapshot exists (capturer not opted in)', async () => {
    const app = express();
    app.use(transcriptRoutes({ commands: {}, claudeEvents: withSession }));
    const { status, body } = await call(app, '/context?pane=%251');
    expect(status).toBe(200);
    expect(body).toEqual({ model: null, usedPercent: null });
  });

  it('returns nulls when the pane has no hook session (hooks off)', async () => {
    const app = express();
    app.use(transcriptRoutes({ commands: {}, claudeEvents: noHook }));
    const { status, body } = await call(app, '/context?pane=%251');
    expect(status).toBe(200);
    expect(body).toEqual({ model: null, usedPercent: null });
  });

  it('400 on bad pane id', async () => {
    const app = express();
    app.use(transcriptRoutes({ commands: {}, claudeEvents: withSession }));
    const { status } = await call(app, '/context?pane=nope');
    expect(status).toBe(400);
  });
});
