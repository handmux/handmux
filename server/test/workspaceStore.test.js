import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceStore, selectRetainedCheckpoints } from '../src/workspace/store.js';
import { ensurePrivateDir, writeJsonAtomic } from '../src/workspace/atomicJson.js';
import { sealPayload } from '../src/workspace/schema.js';

const NOW = Date.parse('2026-07-20T12:00:00.000Z');
const homes = [];

const pane = (id = 'p-a') => ({ id, runtimeId: '%1', index: 0, cwd: '/work', agent: null });
function snapshot(environmentId, capturedAt = '2026-07-20T10:00:00.000Z') {
  const suffix = environmentId.replace(/[^a-zA-Z0-9]/g, '') || 'a';
  return {
    schemaVersion: 1,
    capturedAt,
    environment: { id: environmentId, bootIdentity: `boot-${suffix}`, tmuxServerId: `server-${suffix}` },
    tmuxVersion: '3.6a',
    active: { sessionId: `s-${suffix}`, windowId: `w-${suffix}`, paneId: `p-${suffix}` },
    sessions: [{ id: `s-${suffix}`, runtimeId: '$1', name: suffix, windowIds: [`w-${suffix}`], activeWindowId: `w-${suffix}` }],
    windows: [{ id: `w-${suffix}`, runtimeId: '@1', name: suffix, index: 0, layout: 'layout', activePaneId: `p-${suffix}`, panes: [pane(`p-${suffix}`)] }],
  };
}

function emptySnapshot(environmentId) {
  return {
    ...snapshot(environmentId),
    environment: { id: environmentId, bootIdentity: `boot-${environmentId}`, tmuxServerId: null },
    active: null,
    sessions: [],
    windows: [],
  };
}

function checkpointTimes({ recent, old, corrupt = 0 }) {
  const rows = [];
  for (let index = 0; index < recent; index += 1) {
    rows.push({ status: 'ok', id: `recent-${index}`, value: { archivedAt: new Date(NOW - index * 60_000).toISOString() } });
  }
  for (let index = 0; index < old; index += 1) {
    rows.push({ status: 'ok', id: `old-${index}`, value: { archivedAt: new Date(NOW - 86_400_000 - (index + 1) * 60_000).toISOString() } });
  }
  for (let index = 0; index < corrupt; index += 1) rows.push({ status: 'corrupt', id: `bad-${index}`, error: 'bad json' });
  return rows;
}

async function makeHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'handmux-workspace-'));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe('atomic workspace json', () => {
  it('uses private directory/file permissions and removes only its exact temp after failure', async () => {
    const home = await makeHome();
    const dir = path.join(home, '.handmux', 'workspaces', 'live');
    await ensurePrivateDir(dir);
    const unrelated = path.join(dir, 'unrelated.tmp');
    await fs.writeFile(unrelated, 'keep');
    const target = path.join(dir, 'current.json');
    const failingFs = new Proxy(fs, {
      get(object, property) {
        if (property === 'rename') return async () => { throw new Error('rename denied'); };
        return Reflect.get(object, property);
      },
    });

    await expect(writeJsonAtomic(target, { secret: 'bounded' }, { fs: failingFs })).rejects.toThrow(/rename denied/);
    expect(await fs.readFile(unrelated, 'utf8')).toBe('keep');
    expect((await fs.readdir(dir)).sort()).toEqual(['unrelated.tmp']);

    await writeJsonAtomic(target, { ok: true });
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });
});

describe('workspace live store', () => {
  it('projects snapshots to the persistence allowlist at every level', async () => {
    const home = await makeHome();
    const store = createWorkspaceStore({ home, now: () => NOW });
    const base = snapshot('env-a');
    const dirty = {
      ...base,
      paneOutput: 'secret output',
      token: 'top-secret',
      environment: { ...base.environment, token: 'environment-secret' },
      active: { ...base.active, command: 'active-secret' },
      sessions: [{ ...base.sessions[0], token: 'session-secret' }],
      windows: [{
        ...base.windows[0],
        command: 'window-secret',
        panes: [{
          ...base.windows[0].panes[0],
          output: 'pane-secret',
          agent: {
            id: 'agent-a',
            sessionId: 'agent-session-a',
            transcriptPath: '/private/transcript.jsonl',
            command: 'agent --unsafe',
            argv: ['--token', 'secret'],
            transcript: 'full transcript body',
          },
        }],
      }],
    };

    await store.writeLive(dirty);
    const live = JSON.parse(await fs.readFile(store.paths.liveCurrent, 'utf8'));

    expect(live).not.toHaveProperty('paneOutput');
    expect(live).not.toHaveProperty('token');
    expect(live.environment).toEqual(base.environment);
    expect(live.active).toEqual(base.active);
    expect(live.sessions[0]).toEqual(base.sessions[0]);
    expect(live.windows[0]).not.toHaveProperty('command');
    expect(live.windows[0].panes[0]).not.toHaveProperty('output');
    expect(live.windows[0].panes[0].agent).toEqual({
      id: 'agent-a',
      sessionId: 'agent-session-a',
      transcriptPath: '/private/transcript.jsonl',
    });

    await store.archiveEnvironment({ endedReason: 'boot-changed', detectedAt: new Date(NOW).toISOString() });
    const checkpoint = JSON.parse(await fs.readFile(path.join(store.paths.checkpointsDir, 'env-a.json'), 'utf8'));
    expect(checkpoint).not.toHaveProperty('paneOutput');
    expect(checkpoint).not.toHaveProperty('revision');
    expect(checkpoint.environment).toEqual({ ...base.environment, endedReason: 'boot-changed' });
    expect(checkpoint.windows[0].panes[0].agent).toEqual(live.windows[0].panes[0].agent);
  });

  it('writes current and mirror at the same revision/hash and repairs one corrupt copy', async () => {
    const home = await makeHome();
    const store = createWorkspaceStore({ home, now: () => NOW });
    await store.writeLive(snapshot('env-a'));
    const before = await Promise.all([store.paths.liveCurrent, store.paths.liveMirror].map((file) => fs.readFile(file, 'utf8').then(JSON.parse)));
    expect(before[0]).toMatchObject({ revision: 1, payloadHash: before[1].payloadHash });
    await fs.writeFile(store.paths.liveCurrent, '{broken');

    const live = await store.readLive();

    expect(live.status).toBe('ok');
    expect(live.repaired).toBe(true);
    expect(JSON.parse(await fs.readFile(store.paths.liveCurrent, 'utf8')).payloadHash).toBe(live.value.payloadHash);
  });

  it('selects the highest valid revision and repairs a missing or older copy', async () => {
    const home = await makeHome();
    const store = createWorkspaceStore({ home, now: () => NOW });
    const first = await store.writeLive(snapshot('env-a'));
    const old = JSON.parse(await fs.readFile(store.paths.liveCurrent, 'utf8'));
    const second = await store.writeLive({ ...snapshot('env-a'), tmuxVersion: '3.6b' });
    expect(second.revision).toBe(first.revision + 1);
    await fs.writeFile(store.paths.liveMirror, `${JSON.stringify(old)}\n`);

    const live = await store.readLive();

    expect(live.value.revision).toBe(second.revision);
    expect(JSON.parse(await fs.readFile(store.paths.liveMirror, 'utf8')).revision).toBe(second.revision);
    await fs.unlink(store.paths.liveCurrent);
    expect((await store.readLive()).status).toBe('ok');
    expect(JSON.parse(await fs.readFile(store.paths.liveCurrent, 'utf8')).revision).toBe(second.revision);
  });

  it('fails closed when both live copies are corrupt', async () => {
    const home = await makeHome();
    const store = createWorkspaceStore({ home, now: () => NOW });
    await store.writeLive(snapshot('env-a'));
    await Promise.all([store.paths.liveCurrent, store.paths.liveMirror].map((file) => fs.writeFile(file, '{}')));
    expect((await store.readLive()).status).toBe('corrupt');
  });

  it('returns empty only when neither live copy exists', async () => {
    const store = createWorkspaceStore({ home: await makeHome(), now: () => NOW });
    expect(await store.readLive()).toEqual({ status: 'empty' });
  });
});

describe('workspace checkpoints', () => {
  it('archives the same environment once and does not archive an explicit empty live state', async () => {
    const home = await makeHome();
    const store = createWorkspaceStore({ home, now: () => NOW });
    await store.writeLive(snapshot('env-a'));
    const first = await store.archiveEnvironment({ endedReason: 'boot-changed', detectedAt: new Date(NOW).toISOString() });
    const second = await store.archiveEnvironment({ endedReason: 'server-changed', detectedAt: new Date(NOW + 1000).toISOString() });

    expect(first.status).toBe('ok');
    expect(second.value).toEqual(first.value);
    expect((await store.listCheckpoints()).filter((row) => row.status === 'ok')).toHaveLength(1);
    expect(await store.readLatestCheckpoint()).toMatchObject({ status: 'ok', value: { id: 'env-a' } });

    await store.writeLive(emptySnapshot('env-empty'));
    expect(await store.archiveEnvironment({ endedReason: 'server-changed', detectedAt: new Date(NOW).toISOString() })).toEqual({ status: 'empty' });
    expect((await store.listCheckpoints()).filter((row) => row.status === 'ok')).toHaveLength(1);
  });

  it('lists corrupt checkpoints and falls back when latest or its body is corrupt', async () => {
    const home = await makeHome();
    let clock = NOW;
    const store = createWorkspaceStore({ home, now: () => clock });
    await store.writeLive(snapshot('env-old'));
    await store.archiveEnvironment({ endedReason: 'boot-changed', detectedAt: new Date(clock).toISOString() });
    clock += 1000;
    await store.writeLive(snapshot('env-new'));
    await store.archiveEnvironment({ endedReason: 'server-changed', detectedAt: new Date(clock).toISOString() });
    await fs.writeFile(path.join(store.paths.checkpointsDir, 'env-new.json'), '{}');

    const bodyFallback = await store.readLatestCheckpoint();
    expect(bodyFallback).toMatchObject({ status: 'ok', value: { id: 'env-old' } });
    expect(bodyFallback.warning).toMatch(/latest|corrupt/i);
    expect((await store.listCheckpoints()).some((row) => row.status === 'corrupt' && row.id === 'env-new')).toBe(true);

    await fs.writeFile(path.join(store.paths.checkpointsDir, 'unsafe name.json'), '{}');
    expect((await store.listCheckpoints()).some((row) => row.status === 'corrupt' && row.id === 'unsafe name')).toBe(true);

    await fs.writeFile(store.paths.latest, '{broken');
    const pointerFallback = await store.readLatestCheckpoint();
    expect(pointerFallback).toMatchObject({ status: 'ok', value: { id: 'env-old' } });
    expect(pointerFallback.warning).toMatch(/latest|corrupt/i);
    expect(await store.readCheckpoint('missing')).toEqual({ status: 'missing' });
  });

  it('rejects unsafe ids instead of writing outside workspace directories', async () => {
    const home = await makeHome();
    const store = createWorkspaceStore({ home, now: () => NOW });
    await store.writeLive(snapshot('../escape'));
    await expect(store.archiveEnvironment({ endedReason: 'boot-changed', detectedAt: new Date(NOW).toISOString() })).rejects.toThrow(/safe|id/i);
    await expect(store.writeOperation({ id: '../escape', status: 'pending' })).rejects.toThrow(/safe|id/i);
  });

  it('rejects a self-consistent checkpoint whose environment does not match its id and replaces it on archive', async () => {
    const home = await makeHome();
    const store = createWorkspaceStore({ home, now: () => NOW });
    await ensurePrivateDir(store.paths.checkpointsDir);
    const mismatched = sealPayload({
      ...snapshot('env-other'),
      id: 'env-a',
      archivedAt: new Date(NOW).toISOString(),
      environment: { ...snapshot('env-other').environment, endedReason: 'boot-changed' },
    });
    await writeJsonAtomic(path.join(store.paths.checkpointsDir, 'env-a.json'), mismatched);

    expect(await store.readCheckpoint('env-a')).toMatchObject({ status: 'corrupt', error: expect.stringMatching(/environment/i) });
    await store.writeLive(snapshot('env-a'));
    const archived = await store.archiveEnvironment({ endedReason: 'server-changed', detectedAt: new Date(NOW).toISOString() });
    expect(archived).toMatchObject({ status: 'ok', value: { id: 'env-a', environment: { id: 'env-a' } } });
    expect(await store.readCheckpoint('env-a')).toMatchObject({ status: 'ok', value: { environment: { id: 'env-a' } } });
  });
});

describe('workspace recovery and operations', () => {
  it('only removes recovery pending ids and never reopens a resolved recovery', async () => {
    const home = await makeHome();
    let clock = NOW;
    const store = createWorkspaceStore({ home, now: () => clock });
    await store.writeLive(snapshot('env-a'));
    const archived = await store.archiveEnvironment({ endedReason: 'boot-changed', detectedAt: new Date(NOW).toISOString() });
    const sessionId = archived.value.sessions[0].id;
    expect(await store.readRecovery('env-a')).toMatchObject({
      status: 'ok',
      value: {
        checkpointId: 'env-a',
        detectedAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 3_600_000).toISOString(),
        initialSessionIds: [sessionId],
        pendingSessionIds: [sessionId],
        resolvedAt: null,
        mapping: null,
      },
    });

    await store.resolveSessions('env-a', ['not-in-checkpoint']);
    expect((await store.readRecovery('env-a')).value.pendingSessionIds).toEqual([sessionId]);
    clock += 2000;
    await store.resolveSessions('env-a', [sessionId]);
    const resolved = (await store.readRecovery('env-a')).value;
    expect(resolved.pendingSessionIds).toEqual([]);
    expect(resolved.resolvedAt).toBe(new Date(clock).toISOString());
    clock += 2000;
    await store.createRecovery('env-a', new Date(clock).toISOString());
    await store.resolveSessions('env-a', []);
    expect((await store.readRecovery('env-a')).value).toEqual(resolved);
  });

  it('round-trips operation json with private permissions', async () => {
    const store = createWorkspaceStore({ home: await makeHome(), now: () => NOW });
    const operation = { id: crypto.randomUUID(), status: 'running', results: [] };
    await store.writeOperation(operation);
    expect(await store.readOperation(operation.id)).toEqual({ status: 'ok', value: operation });
    const file = path.join(store.paths.operationsDir, `${operation.id}.json`);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('treats a resolved recovery with pending sessions as corrupt', async () => {
    const store = createWorkspaceStore({ home: await makeHome(), now: () => NOW });
    await store.writeLive(snapshot('env-a'));
    await store.archiveEnvironment({ endedReason: 'boot-changed', detectedAt: new Date(NOW).toISOString() });
    const recoveryFile = path.join(store.paths.recoveryDir, 'env-a.json');
    const recovery = JSON.parse(await fs.readFile(recoveryFile, 'utf8'));
    await writeJsonAtomic(recoveryFile, { ...recovery, resolvedAt: new Date(NOW).toISOString() });

    expect(await store.readRecovery('env-a')).toMatchObject({ status: 'corrupt', error: expect.stringMatching(/resolved|pending/i) });
  });
});

describe('checkpoint retention', () => {
  it('keeps every checkpoint from 24h and only enough older ones to reach ten', () => {
    expect(selectRetainedCheckpoints(checkpointTimes({ recent: 12, old: 9 }), NOW, 'latest-id')).toHaveLength(12);
    expect(selectRetainedCheckpoints(checkpointTimes({ recent: 2, old: 20 }), NOW, 'latest-id')).toHaveLength(10);
  });

  it('never prunes latest and corrupt checkpoints do not count toward ten valid copies', () => {
    const rows = checkpointTimes({ recent: 0, old: 12, corrupt: 4 });
    const retained = selectRetainedCheckpoints(rows, NOW, 'old-11');
    expect(retained.filter((row) => row.status === 'ok')).toHaveLength(11);
    expect(retained.some((row) => row.id === 'old-11')).toBe(true);
    expect(retained.filter((row) => row.status === 'corrupt')).toHaveLength(0);
  });

  it('prunes old and corrupt files but preserves the latest pointer target', async () => {
    const home = await makeHome();
    const store = createWorkspaceStore({ home, now: () => NOW });
    await ensurePrivateDir(store.paths.checkpointsDir);
    const rows = checkpointTimes({ recent: 0, old: 12 });
    for (const row of rows) {
      const checkpoint = sealPayload({
        ...snapshot(row.id, row.value.archivedAt),
        id: row.id,
        archivedAt: row.value.archivedAt,
        environment: { ...snapshot(row.id).environment, endedReason: 'boot-changed' },
      });
      await writeJsonAtomic(path.join(store.paths.checkpointsDir, `${row.id}.json`), checkpoint);
    }
    await fs.writeFile(path.join(store.paths.checkpointsDir, 'bad.json'), '{}');
    const latest = await store.readCheckpoint('old-11');
    await writeJsonAtomic(store.paths.latest, { checkpointId: 'old-11', payloadHash: latest.value.payloadHash });

    await store.prune();

    expect((await store.readCheckpoint('old-11')).status).toBe('ok');
    expect((await store.listCheckpoints()).filter((row) => row.status === 'ok')).toHaveLength(11);
    expect((await store.readCheckpoint('bad')).status).toBe('missing');
  });
});
