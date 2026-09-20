import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codebuddyProjectsDir, codebuddySessionsDir } from '../src/agents/codebuddy.js';
import { CodeBuddyNativeTailReader } from '../src/agents/codebuddyNativeTail.js';

// Every fixture lives under its own temp home, so nothing here can read the host's real ~/.codebuddy.
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const SESSION = '01a0bf0a-ad3e-7726-adee-f4edc6f0b297';
const PID = 4242;

function fixtureHome({
  cwd = '/private/tmp/cb-sim',
  slug = 'private-tmp-cb-sim',
  registry = true,
  records = [
    { type: 'function_call', timestamp: 1_000, id: 'call-1' },
    { type: 'function_call_result', timestamp: 2_000, id: 'result-1' },
  ],
}: {
  cwd?: string;
  slug?: string;
  registry?: boolean;
  records?: Record<string, unknown>[];
} = {}): { home: string; transcript: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cb-tail-'));
  directories.push(home);
  const transcript = path.join(codebuddyProjectsDir(home), slug, `${SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  if (registry) {
    fs.mkdirSync(codebuddySessionsDir(home), { recursive: true });
    fs.writeFileSync(
      path.join(codebuddySessionsDir(home), `${PID}.json`),
      JSON.stringify({ pid: PID, sessionId: SESSION, cwd, kind: 'interactive' }),
    );
  }
  return { home, transcript };
}

const gateRow = (payload: Record<string, unknown> = {}) => payload;
const process = { pid: PID, startedAt: 1_000 };

describe('CodeBuddy transcript reconciliation for an answered permission gate', () => {
  it('closes a gate once the transcript holds a tool result from after it', () => {
    // The granted tool's result is the ONLY proof the pane moved on: CodeBuddy fires no Hook when the user
    // answers, and its Notification row (the shape a gate is usually latched from) carries neither a session
    // id nor a transcript path — hence the pid → registry → transcript resolution.
    const { home } = fixtureHome();
    const reader = new CodeBuddyNativeTailReader({ home });

    expect(reader.read(gateRow(), 1_500, 5_000, process, 'permreq'))
      .toEqual({ status: 'busy', statusEventId: `codebuddy-native::${PID}:2000` });
    expect(reader.read(gateRow({ notification_type: 'permission_prompt' }), 1_500, 5_000, process, 'notify'))
      .toEqual({ status: 'busy', statusEventId: `codebuddy-native::${PID}:2000` });
    // An explicit transcript path wins over the registry (the Hook carried one), and keeps the session id
    // the event id is built from.
    const { home: explicitHome, transcript } = fixtureHome({ registry: false });
    const explicit = new CodeBuddyNativeTailReader({ home: explicitHome });
    expect(explicit.read(gateRow({ transcript_path: transcript, session_id: SESSION }), 1_500, 5_000, process, 'permreq'))
      .toEqual({ status: 'busy', statusEventId: `codebuddy-native:${SESSION}:${PID}:2000` });
  });

  it('says nothing when the result is not newer than the gate', () => {
    // A result from BEFORE the request cannot close it — that ordering is what makes this one-sided: the
    // reader can only ever close a gate, never open one or fake a completion.
    const { home } = fixtureHome();
    const reader = new CodeBuddyNativeTailReader({ home });
    expect(reader.read(gateRow(), 2_000, 5_000, process, 'permreq')).toEqual({});
    expect(reader.read(gateRow(), 2_500, 5_000, process, 'permreq')).toEqual({});
  });

  it('reads no transcript at all for a row that is not a gate', () => {
    // Same fixture, same result record: only the src filter can explain an empty verdict, so this pins the
    // cost guard — a working pane never pays for a transcript read.
    const { home } = fixtureHome();
    const reader = new CodeBuddyNativeTailReader({ home });
    for (const src of ['prompt', 'stop', 'resume', 'start', 'end', 'stopfail']) {
      expect(reader.read(gateRow(), 1_500, 5_000, process, src)).toEqual({});
    }
    // A Notification that is not a permission prompt is noise, not a gate.
    expect(reader.read(gateRow({ notification_type: 'idle_prompt' }), 1_500, 5_000, process, 'notify')).toEqual({});
  });

  it('says nothing when the transcript is missing, empty, or holds no result', () => {
    const noResult = fixtureHome({ records: [{ type: 'function_call', timestamp: 3_000, id: 'call-1' }] });
    expect(new CodeBuddyNativeTailReader({ home: noResult.home }).read(gateRow(), 1_500, 5_000, process, 'permreq')).toEqual({});

    const noRegistry = fixtureHome({ registry: false });
    expect(new CodeBuddyNativeTailReader({ home: noRegistry.home }).read(gateRow(), 1_500, 5_000, process, 'permreq')).toEqual({});

    const unknownPid = fixtureHome();
    expect(new CodeBuddyNativeTailReader({ home: unknownPid.home })
      .read(gateRow(), 1_500, 5_000, { pid: 999_999 }, 'permreq')).toEqual({});
    expect(new CodeBuddyNativeTailReader({ home: unknownPid.home }).read(gateRow(), 1_500, 5_000, undefined, 'permreq'))
      .toEqual({});
  });

  it('uses the session the Hook named even when the pid registry is stale', () => {
    // Observed live: a resumed session leaves the pid file pointing at an older session id, so a gate row
    // that names its own session must resolve from that instead of the registry.
    const { home } = fixtureHome();
    fs.writeFileSync(
      path.join(codebuddySessionsDir(home), `${PID}.json`),
      JSON.stringify({ pid: PID, sessionId: 'stale-session-id', cwd: '/private/tmp/cb-sim' }),
    );
    const reader = new CodeBuddyNativeTailReader({ home });
    expect(reader.read(gateRow({ session_id: SESSION }), 1_500, 5_000, process, 'permreq'))
      .toEqual({ status: 'busy', statusEventId: `codebuddy-native:${SESSION}:${PID}:2000` });
    // A session that names no transcript file stays unresolved rather than borrowing another session's.
    expect(reader.read(gateRow({ session_id: 'no-such-session' }), 1_500, 5_000, process, 'permreq')).toEqual({});
  });

  it('still finds the transcript when the project directory is not named the way it derives', () => {
    // The directory name is CodeBuddy's own encoding of the cwd; the session UUID identifies the file even
    // when that encoding does not match what this reader computed.
    const { home } = fixtureHome({ cwd: '/private/tmp/cb-sim', slug: 'some-other-encoding' });
    expect(new CodeBuddyNativeTailReader({ home }).read(gateRow(), 1_500, 5_000, process, 'permreq'))
      .toEqual({ status: 'busy', statusEventId: `codebuddy-native::${PID}:2000` });
  });

  it('sees a newer result as soon as the transcript grows, and never one from the future', () => {
    const { home, transcript } = fixtureHome();
    const reader = new CodeBuddyNativeTailReader({ home });
    expect(reader.read(gateRow(), 2_500, 5_000, process, 'permreq')).toEqual({});
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'function_call_result', timestamp: 3_000, id: 'result-2' })}\n`);
    expect(reader.read(gateRow(), 2_500, 5_000, process, 'permreq'))
      .toEqual({ status: 'busy', statusEventId: `codebuddy-native::${PID}:3000` });
    // A timestamp ahead of the reader's own clock is not evidence of anything.
    expect(reader.read(gateRow(), 2_500, 2_900, process, 'permreq')).toEqual({});
  });

  it('drops its cache on clear()', () => {
    const { home, transcript } = fixtureHome();
    const reader = new CodeBuddyNativeTailReader({ home });
    expect(reader.read(gateRow(), 1_500, 5_000, process, 'permreq')).toMatchObject({ status: 'busy' });
    reader.clear();
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'function_call_result', timestamp: 3_000 })}\n`);
    expect(reader.read(gateRow(), 1_500, 5_000, process, 'permreq'))
      .toEqual({ status: 'busy', statusEventId: `codebuddy-native::${PID}:3000` });
  });
});
