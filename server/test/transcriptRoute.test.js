// NOTE: this project's server suite runs on VITEST (describe/it/expect), not node:test.
import { describe, it, expect } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptRoutes } from '../src/routes/transcript.js';
import { encodeProjectDir } from '../src/agents/scanUtils.js';

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

describe('GET /api/transcript', () => {
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
});
