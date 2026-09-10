import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createClaudeEvents } from '../src/claudeEvents.js';
import { createBuiltinAgentRuntime } from '../src/agent-runtime/builtinRuntime.js';
import { FileInboxStateStore } from '../src/agent-runtime/inboxStore.js';
import { ClaudeNativeTailReader } from '../src/agents/claudeNativeTail.js';
import { interruptClaudePane, interruptPane } from '../src/paneInput.js';
import { ClaudeHookBridgeConnector } from '../connectors/claude/index.js';

const SESSION = '4442e3d0-8d46-4cce-9822-b86558f69922';
const INTERRUPT = '4442e3d0-8d46-4cce-9822-b86558f69924';
const PROMPT = '4442e3d0-8d46-4cce-9822-b86558f69923';
const closes: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

function nativeFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-native-tail-'));
  closes.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const transcript = path.join(directory, `${SESSION}.jsonl`);
  const payload = { session_id: SESSION, transcript_path: transcript, prompt_id: PROMPT };
  const marker = { type: 'user', isSidechain: false, sessionId: SESSION, session_id: 'a-different-native-field',
    uuid: INTERRUPT, promptId: PROMPT, interruptedMessageId: 'msg_011Cd1pN6E1q6VecasqQUVUc',
    timestamp: new Date(2000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } };
  const write = (rows: unknown[], suffix = '\n') => fs.writeFileSync(transcript, rows.map((row) => JSON.stringify(row)).join('\n') + suffix);
  write([marker]);
  const reader = new ClaudeNativeTailReader();
  return { directory, transcript, payload, marker, write, reader, read: () => reader.read(payload, 1000, 10000) };
}

it.each(['ordinary', 'tool', 'tool-duration'])('accepts the native %s interruption structure with stable identity', (mode) => {
  const h = nativeFixture();
  if (mode !== 'ordinary') {
    const { interruptedMessageId: _unused, ...tool } = h.marker;
    tool.message.content[0]!.text = '[Request interrupted by user for tool use]';
    const rows: unknown[] = [tool];
    if (mode === 'tool-duration') rows.push({ type: 'system', subtype: 'turn_duration', sessionId: SESSION,
      isSidechain: false, uuid: PROMPT, parentUuid: INTERRUPT, timestamp: new Date(2003).toISOString() });
    rows.push({ type: 'last-prompt' }, { type: 'ai-title' }, { type: 'file-history-snapshot' });
    h.write(rows);
  }
  expect(h.read().settled).toBe(`claude-interrupted:${SESSION}:${INTERRUPT}`);
  expect(h.read()).toEqual(h.read());
  expect(h.reader.read(h.payload, 3000, 10000).settled).toBeNull();
});

it.each([
  'old', 'future', 'wrong-session', 'sidechain', 'bad-uuid', 'missing-message-id',
  'quoted', 'string-content', 'multiple-blocks', 'wrong-prompt', 'missing-prompt',
  'raw-prompt-source', 'raw-origin', 'raw-permission-mode', 'meta', 'summary',
  'later-user', 'later-assistant', 'unrelated-duration', 'truncated', 'malformed',
])('rejects %s as evidence of the current turn ending', (mode) => {
  const h = nativeFixture();
  const marker: Record<string, unknown> = structuredClone(h.marker);
  const rows: unknown[] = [marker];
  if (mode === 'old') marker.timestamp = new Date(1000).toISOString();
  if (mode === 'future') marker.timestamp = new Date(10001).toISOString();
  if (mode === 'wrong-session') marker.sessionId = PROMPT;
  if (mode === 'sidechain') marker.isSidechain = true;
  if (mode === 'bad-uuid') marker.uuid = 'arbitrary';
  if (mode === 'missing-message-id') delete marker.interruptedMessageId;
  if (mode === 'quoted') marker.message = { role: 'user', content: [{ type: 'text', text: 'Example: [Request interrupted by user]' }] };
  if (mode === 'string-content') marker.message = { role: 'user', content: '[Request interrupted by user]' };
  if (mode === 'multiple-blocks') marker.message = { role: 'user', content: [...h.marker.message.content, { type: 'text', text: 'quoted' }] };
  if (mode === 'wrong-prompt') marker.promptId = INTERRUPT;
  if (mode === 'missing-prompt') delete marker.promptId;
  if (mode.startsWith('raw-')) {
    marker.message = { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] };
    marker[mode === 'raw-prompt-source' ? 'promptSource' : mode === 'raw-origin' ? 'origin' : 'permissionMode'] = 'native-user-input';
  }
  if (mode === 'meta') marker.isMeta = true;
  if (mode === 'summary') marker.isCompactSummary = true;
  if (mode.startsWith('later-')) rows.push({ ...h.marker, type: mode.slice(6), uuid: PROMPT,
    timestamp: new Date(3000).toISOString(), message: { role: mode.slice(6), content: 'new work' } });
  if (mode === 'unrelated-duration') rows.push({ type: 'system', subtype: 'turn_duration', sessionId: SESSION,
    isSidechain: false, uuid: PROMPT, parentUuid: PROMPT, timestamp: new Date(2003).toISOString() });
  h.write(rows, mode === 'truncated' ? '' : '\n');
  if (mode === 'malformed') fs.appendFileSync(h.transcript, '{malformed}\n');
  expect(h.read().settled).toBeFalsy();
});

it('caches parsed tails and invalidates replacement, truncation, and explicit session release', () => {
  const h = nativeFixture();
  const read = vi.spyOn(fs, 'readSync');
  const parse = vi.spyOn(JSON, 'parse');
  h.read();
  expect(read).toHaveBeenCalledTimes(1);
  const parses = parse.mock.calls.length;
  for (let i = 0; i < 10; i++) h.read();
  expect(read).toHaveBeenCalledTimes(1);
  expect(parse).toHaveBeenCalledTimes(parses);
  fs.writeFileSync(`${h.transcript}.replacement`, '');
  fs.renameSync(`${h.transcript}.replacement`, h.transcript);
  expect(h.read()).toMatchObject({ interruption: null, localCommand: null });
  expect(read).toHaveBeenCalledTimes(2);
  h.write([h.marker]);
  expect(h.read().interruption).toBeTruthy();
  fs.truncateSync(h.transcript);
  expect(h.read()).toMatchObject({ interruption: null, localCommand: null });
  fs.unlinkSync(h.transcript);
  expect(h.read()).toMatchObject({ interruption: null, localCommand: null });
  fs.writeFileSync(h.transcript, '');
  expect(h.read()).toMatchObject({ interruption: null, localCommand: null });
  h.reader.release(SESSION);
  h.read();
  expect(read).toHaveBeenCalledTimes(6);
});

it('uses Escape only for the Claude stop path', async () => {
  const commands = { exitCopyModeIfActive: vi.fn(async () => {}), sendKey: vi.fn(async () => {}),
    sendText: vi.fn(async () => {}), sendEnter: vi.fn(async () => {}) };
  await interruptClaudePane(commands, '%1');
  await interruptPane(commands, '%2');
  expect(commands.sendKey.mock.calls).toEqual([['%1', 'Escape'], ['%2', 'C-c']]);
});

it('treats a short native tail read as unknown instead of restoring an older Hook completion', () => {
  const h = nativeFixture();
  vi.spyOn(fs, 'readSync').mockReturnValueOnce(0);
  expect(h.read()).toMatchObject({ interruption: null, localCommand: null });
  expect(h.read().settled).toBe(`claude-interrupted:${SESSION}:${INTERRUPT}`);
});

it.each(['prompt', 'permission', 'gap', 'restart'])('settles external interruption through Queue and Inbox with retained %s edge', async (mode) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-interrupt-'));
  closes.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const transcript = path.join(directory, `${SESSION}.jsonl`);
  const eventDirectory = `${file}.events`;
  fs.mkdirSync(eventDirectory);
  const process = { pid: 101, startedAt: 100, tty: '/dev/ttys001' };
  const payload = { session_id: SESSION, transcript_path: transcript, prompt_id: PROMPT, prompt: 'busy' };
  const src = mode === 'permission' ? 'permreq' : 'prompt';
  fs.writeFileSync(file, JSON.stringify({ '%1': { src, ts: 1000, sequence: 1, process, payload } }));
  fs.writeFileSync(transcript, '');
  const events = createClaudeEvents({ file, now: () => 10000 });
  closes.push(() => events.stop());
  const panes = { list: async () => [{ paneId: '%1', sessionName: 'main', windowId: '@1', windowName: 'claude',
    currentCommand: 'claude', tty: process.tty }], subscribe: () => () => {} };
  const processSource = { inspectForeground: async () => ({ ...process, executable: '/opt/claude' }) };
  const sendPrompt = vi.fn(async () => {});
  const runtimeDirectory = path.join(directory, 'runtime');
  const runtime = createBuiltinAgentRuntime({ panes, process: processSource, stateDirectory: runtimeDirectory,
    authToken: 'interrupt-test-token-at-least-32-bytes', claudeEvents: events,
    claudeConversationControl: { sendPrompt, interrupt: async () => {} }, claudeProjectsRoot: directory });
  closes.push(() => runtime.close());
  const makeConnector = (socketPath = runtime.socketPath) => {
    const created = new ClaudeHookBridgeConnector({ socketPath,
    nativeTail: events.nativeTail,
    credentialFile: path.join(runtimeDirectory, 'bridge-credential.json'),
    stateDirectory: path.join(runtimeDirectory, 'connector'), hookStateFile: file, eventDirectory,
    panes, process: processSource, pollMs: 50, retryDelayMs: 5, maxRetryDelayMs: 10 });
    closes.push(() => created.close());
    return created;
  };
  let connector = makeConnector();
  await runtime.start();
  connector.start();
  await vi.waitFor(() => expect(runtime.inbox.read().records[0]?.state).toBe(mode === 'permission' ? 'waiting' : 'working'));
  const lease = runtime.runs.currentForPane('%1')!;
  expect(await runtime.conversation!.send(lease, { clientRequestId: 'next', text: '/model', delivery: 'prompt' }))
    .toMatchObject({ status: 'queued' });
  const writeSource = () => fs.writeFileSync(path.join(eventDirectory, 'event-0000000000000001-100.json'), JSON.stringify({
    version: 1, type: 'event', eventId: 'claude-hook-1', sequence: 1, paneId: '%1', src,
    sourceOccurredAt: 1000, process, payload,
  }));
  if (mode === 'restart') {
    await connector.close();
    writeSource();
    connector = makeConnector(path.join(directory, 'offline.sock'));
    connector.start();
    await vi.waitFor(() => {
      const disk = fs.readdirSync(path.join(runtimeDirectory, 'connector'))[0]!;
      expect(JSON.parse(fs.readFileSync(path.join(runtimeDirectory, 'connector', disk), 'utf8')).durable).toHaveLength(1);
    });
    await connector.close();
  }
  const persistedStates: string[] = [];
  const save = FileInboxStateStore.prototype.save;
  vi.spyOn(FileInboxStateStore.prototype, 'save').mockImplementation(function (this: FileInboxStateStore, state) {
    for (const run of state.runs) if (run.latest) persistedStates.push(run.latest.state);
    save.call(this, state);
  });
  const marker = { type: 'user', isSidechain: false, sessionId: SESSION,
    uuid: INTERRUPT, promptId: PROMPT, interruptedMessageId: 'msg_011Cd1pN6E1q6VecasqQUVUc', timestamp: new Date(2000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } };
  fs.writeFileSync(transcript, JSON.stringify(marker) + '\n');
  writeSource();
  if (mode === 'gap') fs.writeFileSync(path.join(eventDirectory, 'gap-abcdef.json'), JSON.stringify({
    version: 1, type: 'gap', eventId: 'gap-test', paneId: '%1', process, payload,
  }));
  if (mode === 'restart') { connector = makeConnector(); connector.start(); }
  await connector.reconcile();
  expect(await runtime.conversation!.queueSnapshot(lease)).toMatchObject({ activity: 'idle' });
  await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(runtime.inbox.read().records).toEqual([]));
  await vi.waitFor(() => expect(fs.readdirSync(eventDirectory).filter((name) => name.startsWith('event-'))).toEqual([]));
  expect(runtime.inbox.read().terminalNotifications).toEqual([]);
  expect(persistedStates).toEqual([]);
  await runtime.conversation!.queueSnapshot(lease);
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  if (mode === 'prompt') {
    // /model and its local result also emit no Hook. This must finish after the external interrupt.
    const command = { type: 'user', sessionId: SESSION, uuid: PROMPT, timestamp: new Date(3000).toISOString(),
      message: { role: 'user', content: '<command-name>/model</command-name>' } };
    fs.appendFileSync(transcript, JSON.stringify(command) + '\n');
    expect(await runtime.conversation!.send(lease, { clientRequestId: 'third', text: 'next task', delivery: 'prompt' }))
      .toMatchObject({ status: 'queued' });
    fs.appendFileSync(transcript, JSON.stringify({ type: 'user', sessionId: SESSION,
      uuid: '4442e3d0-8d46-4cce-9822-b86558f69925', parentUuid: PROMPT, timestamp: new Date(4000).toISOString(),
      message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' } }) + '\n');
    await runtime.conversation!.queueSnapshot(lease);
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
    await runtime.conversation!.queueSnapshot(lease);
    expect(sendPrompt).toHaveBeenCalledTimes(2);
  }
});
