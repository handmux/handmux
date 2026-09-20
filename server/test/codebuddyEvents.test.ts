import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyCodeBuddy } from '../src/codebuddyEvents.js';
import { acceptsCodeBuddyAgent } from '../connectors/codebuddy/index.js';
import {
  canonicalInboxState,
  hookEventSequence,
  hookEventKind,
  parseHookBridgeEvent,
  readHookStateRows,
} from '../src/agents/hookEvents.js';
import { BUILTIN_AGENT_ADAPTERS } from '../src/agents/index.js';
import { codebuddyStatePath } from '../src/cli/state.js';
import {
  defaultAgentIntegrationContext,
  agentIntegrationStatus,
  agentName,
} from '../src/cli/agentIntegration.js';
import { tmpHome } from './tmphome.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Every fixture below lives in a temp directory. The CodeBuddy chain must never be exercised against the
// real ~/.codebuddy, so nothing here reads or writes the host's own Hook state.
function fixtureRoot(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'handmux-codebuddy-events-'));
  directories.push(value);
  return value;
}

const PROCESS = { pid: 400, startedAt: 1_000, tty: '/dev/ttys001' };
// What the SHARED writer stamps for CodeBuddy: the agent name its notify script exports. The fixtures must
// not "improve" this — a record shape that is not byte-for-byte what the writer produces would hide the
// mismatch that decides whether a completion notifies.
const WRITER_AGENT = 'codebuddy';

function writeStateFile(file: string, rows: Record<string, unknown>): void {
  fs.writeFileSync(file, JSON.stringify(rows));
}

function stateRow(src: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { ts: 10, src, host: 'test-host', payload, agent: WRITER_AGENT, process: PROCESS, sequence: 1, ...extra };
}

function spoolEvent(src: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    version: 1, type: 'event', agent: WRITER_AGENT, eventId: `${WRITER_AGENT}-hook-1`, sequence: 1,
    paneId: '%1', src, sourceOccurredAt: 10, sessionId: 'codebuddy-session-1',
    process: PROCESS, payload, ...extra,
  };
}

describe('classifyCodeBuddy', () => {
  it('maps every lifecycle edge CodeBuddy installs into the shared kind language', () => {
    // The table is the whole contract between CodeBuddy's `src` names and the Runtime's vocabulary: the
    // values are asserted against the shared vocabulary below, so a new kind cannot be invented locally.
    expect(classifyCodeBuddy('stop', { last_assistant_message: 'all done' }))
      .toEqual({ kind: 'done', msg: 'all done' });
    expect(classifyCodeBuddy('prompt', { prompt: 'do the thing' }))
      .toEqual({ kind: 'working', msg: 'do the thing' });
    expect(classifyCodeBuddy('permreq', { tool_name: 'Bash' }))
      .toEqual({ kind: 'permission', msg: '需要你授权：Bash' });
    expect(classifyCodeBuddy('permreq', {})).toEqual({ kind: 'permission', msg: '需要你' });
    expect(classifyCodeBuddy('compacting', {})).toEqual({ kind: 'compacting', msg: '' });
    expect(classifyCodeBuddy('stopfail', { error_type: 'rate_limit' }))
      .toEqual({ kind: 'error', msg: '触发限流' });
    expect(classifyCodeBuddy('stopfail', { error: 'boom' })).toEqual({ kind: 'error', msg: 'boom' });
    expect(classifyCodeBuddy('end', {})).toEqual({ kind: 'end' });
  });

  it('closes a permission gate on PermissionDenied and clears compaction on PostCompact', () => {
    // PermissionDenied is CodeBuddy's only closing edge for 需要你 (there is no PostToolUse src here): the
    // agent continues the turn with the denial, exactly like Claude's deny→tool_result→resume path, and a
    // Stop that follows overrides it with done. PostCompact must clear 压缩中 without fabricating a result.
    expect(classifyCodeBuddy('permdenied', { tool_name: 'Bash' })).toEqual({ kind: 'working', msg: '' });
    expect(classifyCodeBuddy('compact', {})).toBeNull();
    expect(classifyCodeBuddy('start', { source: 'startup' })).toBeNull();
  });

  it('takes permission/idle only from the notifications that mean them', () => {
    expect(classifyCodeBuddy('notify', { notification_type: 'permission_prompt', message: 'needs perm' }))
      .toEqual({ kind: 'permission', msg: 'needs perm' });
    expect(classifyCodeBuddy('notify', { notification_type: 'idle_prompt', message: 'waiting' }))
      .toEqual({ kind: 'idle', msg: 'waiting' });
  });

  it('ignores notification noise and unknown sources instead of inventing a state', () => {
    for (const [src, payload] of [
      ['notify', { notification_type: 'auth_success' }],
      ['notify', { notification_type: 'elicitation_dialog' }],
      ['notify', {}],
      ['', {}],
      ['finished', {}],
      ['unknown-src', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(classifyCodeBuddy(src, payload), `${src}:${String(payload.notification_type)}`).toBeNull();
    }
  });

  it('only ever emits kinds that the shared vocabulary already owns', () => {
    for (const src of ['stop', 'prompt', 'permreq', 'permdenied', 'compacting', 'stopfail', 'end', 'compact', 'start']) {
      const classified = classifyCodeBuddy(src, {});
      if (!classified) continue;
      expect(hookEventKind(classified.kind), src).toBe(classified.kind);
    }
    // The two states that carry no Inbox item must not be translated into one.
    expect(canonicalInboxState('end')).toBeNull();
    expect(canonicalInboxState('idle')).toBeNull();
    expect(canonicalInboxState('permission')).toBe('waiting');
  });
});

describe('CodeBuddy hook record parsing', () => {
  it('reads the state file the shared writer maintains, including an absent marking', () => {
    // The writer is a SHARED script, so the marking is data rather than a contract of this reader: CodeBuddy's
    // own id and an absent marking (a row written before the marking existed) are both valid, and any other
    // provider's id must fail closed.
    const file = path.join(fixtureRoot(), 'codebuddy-state.json');
    writeStateFile(file, {
      '%1': stateRow('prompt', { session_id: 'codebuddy-session-1', prompt: 'hi' }),
      '%2': stateRow('stop', { session_id: 's2' }, { agent: undefined }),
      '%3': stateRow('stop', { session_id: 's3' }, { agent: 'codebuddy' }),
      '%4': stateRow('stop', { session_id: 's4' }, { agent: 'codex' }),
      '%5': stateRow('stop', { session_id: 's5' }, { process: { pid: 0, startedAt: 1, tty: '' } }),
      '%6': { ts: 10, src: 'stop', agent: 'codebuddy' },
    });

    const rows = readHookStateRows(file, acceptsCodeBuddyAgent);
    expect([...rows.keys()]).toEqual(['%1', '%2', '%3']);
    expect(rows.get('%1')).toEqual({
      ts: 10, src: 'prompt', agent: 'codebuddy',
      payload: { session_id: 'codebuddy-session-1', prompt: 'hi' },
      sequence: 1, process: PROCESS,
    });
    expect(rows.get('%3')?.agent).toBe('codebuddy');
  });

  it('clears a pending prompt when the user answers the interaction tool', () => {
    // PostToolUse on AskUserQuestion/ExitPlanMode is the only signal that the user replied; without it the
    // 需要你 state stayed lit until the turn happened to end.
    expect(classifyCodeBuddy('resume', { tool_name: 'AskUserQuestion', tool_response: '· 接下来怎么做？ → 继续' }))
      .toEqual({ kind: 'working', msg: '· 接下来怎么做？ → 继续' });
    expect(classifyCodeBuddy('permreq', { tool_name: 'Bash' })).toMatchObject({ kind: 'permission' });
  });

  it('reads the spool event the writer appends, mapping the shared session/key fields', () => {
    const parse = (value: unknown) => parseHookBridgeEvent(value, acceptsCodeBuddyAgent);
    expect(parse(spoolEvent('stop', { last_assistant_message: 'done' }))).toMatchObject({
      type: 'event', agent: 'codebuddy', eventId: 'codebuddy-hook-1', sequence: 1,
      paneId: '%1', src: 'stop', sessionId: 'codebuddy-session-1', process: PROCESS,
    });
    // A gap marker carries no src/payload but must survive so the snapshot can degrade honestly.
    expect(parse({ version: 1, type: 'gap', agent: 'codebuddy', eventId: 'codebuddy-gap-1', paneId: '%1' }))
      .toMatchObject({ type: 'gap', paneId: '%1' });
  });

  it('rejects malformed and foreign-provider spool events', () => {
    const parse = (value: unknown) => parseHookBridgeEvent(value, acceptsCodeBuddyAgent);
    expect(parse(spoolEvent('stop', {}, { agent: 'codex' }))).toBeNull();
    expect(parse(spoolEvent('stop', {}, { agent: 'pi' }))).toBeNull();
    expect(parse(spoolEvent('stop', {}, { version: 2 }))).toBeNull();
    expect(parse(spoolEvent('stop', {}, { eventId: 'has space' }))).toBeNull();
    expect(parse(spoolEvent('stop', {}, { paneId: '' }))).toBeNull();
    expect(parse(spoolEvent('stop', {}, { process: { pid: 1, startedAt: 1 } }))).toBeNull();
    expect(parse(spoolEvent('stop', {}, { sequence: 0 }))).toBeNull();
    expect(parse(spoolEvent('stop', {}, { payload: [] }))).toBeNull();
  });

  it('interprets the durable source sequence from the id the shared writer stamps', () => {
    expect(hookEventSequence('codebuddy-hook-7')).toBe(7);
    // Only the numeric tail matters to the reader; the agent in front of it is the writer's business.
    expect(hookEventSequence('claude-hook-7')).toBe(7);
    expect(hookEventSequence('codebuddy-hook-0')).toBeNull();
    expect(hookEventSequence('codebuddy-hook-')).toBeNull();
    expect(hookEventSequence('codebuddy-gap-7')).toBeNull();
  });

  it('keeps the CodeBuddy state file on the same stable per-user path as Claude', () => {
    expect(codebuddyStatePath('/home/x')).toBe('/home/x/.handmux/codebuddy-state.json');
  });
});

describe('CodeBuddy capability gating', () => {
  const context = (executableAvailable: (name: string) => boolean) => {
    const home = tmpHome('hm-codebuddy-status-');
    const built = defaultAgentIntegrationContext({
      home,
      piEntryFile: '/unused/pi.js',
      hooksSrcDir: '/unused/hooks',
      claudeStateFile: path.join(home, '.handmux/claude-state.json'),
    });
    built.executableAvailable = executableAvailable;
    return built;
  };

  it('declares exactly the capabilities it implements', () => {
    const adapter = BUILTIN_AGENT_ADAPTERS.find((entry) => entry.id === 'codebuddy');
    expect(adapter?.capabilities.inbox).toEqual({ apiVersion: 1 });
    // Conversation ships with a composer and an interrupt, like Claude's — it is marked experimental there
    // for the same reason (the provider's own UI can change under it).
    expect(adapter?.capabilities.conversation).toEqual({ apiVersion: 1, experimental: true });
    // Interaction is deliberately absent: an approval's wording is unverified per gate. Subscription usage
    // is absent because CodeBuddy exposes no quota source at all.
    expect(Object.keys(adapter?.capabilities ?? {})).toEqual(['inbox', 'conversation']);
    expect(agentName('codebuddy')).toBe('codebuddy');
  });

  it('never reports ready without installed hooks', () => {
    const withExecutable = context(() => true);
    expect(agentIntegrationStatus('codebuddy', withExecutable)).toBe('not-enabled');
    // The installer must not be able to opt a user in by creating ~/.codebuddy; nothing was ever written.
    expect(fs.existsSync(path.join(withExecutable.home, '.codebuddy'))).toBe(false);

    const without = context((name) => name !== 'codebuddy');
    expect(agentIntegrationStatus('codebuddy', without)).toBe('not-installed');
  });
});
