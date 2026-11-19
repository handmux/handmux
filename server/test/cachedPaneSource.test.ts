import { describe, expect, it } from 'vitest';
import type { LivePane, ReadonlyPaneSource } from '../src/agent-runtime/adapter.js';
import { cachedPaneSource } from '../src/agent-runtime/cachedPaneSource.js';

function pane(paneId: string): LivePane {
  return { paneId, sessionName: 's', windowId: '@1', windowName: 'w', currentCommand: 'claude', tty: '/dev/pts/1' };
}

function fakeSource(): ReadonlyPaneSource & {
  calls: number;
  panes: LivePane[];
  fail: Error | null;
  gate: Promise<void> | null;
} {
  const source = {
    calls: 0,
    panes: [pane('%1')],
    fail: null as Error | null,
    gate: null as Promise<void> | null,
    async list() {
      source.calls += 1;
      if (source.gate) await source.gate;
      if (source.fail) throw source.fail;
      return source.panes.map((value) => ({ ...value }));
    },
    subscribe: () => () => {},
  };
  return source;
}

describe('cachedPaneSource', () => {
  it('reuses one read within the max age and reads again after it', async () => {
    const source = fakeSource();
    let clock = 1_000;
    const cached = cachedPaneSource(source, 1_000, () => clock);
    expect((await cached.list()).map((value) => value.paneId)).toEqual(['%1']);
    source.panes = [pane('%1'), pane('%2')];
    clock += 999;
    expect((await cached.list()).map((value) => value.paneId)).toEqual(['%1']);
    expect(source.calls).toBe(1);
    clock += 1;
    expect((await cached.list()).map((value) => value.paneId)).toEqual(['%1', '%2']);
    expect(source.calls).toBe(2);
  });

  it('shares one in-flight read between concurrent callers', async () => {
    const source = fakeSource();
    let release!: () => void;
    source.gate = new Promise<void>((resolve) => { release = resolve; });
    const cached = cachedPaneSource(source, 1_000, () => 0);
    const reads = Promise.all([cached.list(), cached.list(), cached.list()]);
    release();
    expect((await reads).map((list) => list.length)).toEqual([1, 1, 1]);
    expect(source.calls).toBe(1);
  });

  it('never caches a failed read', async () => {
    const source = fakeSource();
    const cached = cachedPaneSource(source, 1_000, () => 0);
    source.fail = new Error('no server running');
    await expect(cached.list()).rejects.toThrow('no server running');
    source.fail = null;
    expect((await cached.list()).map((value) => value.paneId)).toEqual(['%1']);
    expect(source.calls).toBe(2);
  });

  it('does not serve an expired list when the refresh fails', async () => {
    const source = fakeSource();
    let clock = 0;
    const cached = cachedPaneSource(source, 1_000, () => clock);
    await cached.list();
    clock = 1_000;
    source.fail = new Error('no server running');
    await expect(cached.list()).rejects.toThrow('no server running');
  });

  it('reads again when the clock steps back instead of serving the old list', async () => {
    const source = fakeSource();
    let clock = 10_000;
    const cached = cachedPaneSource(source, 1_000, () => clock);
    await cached.list();
    source.panes = [pane('%1'), pane('%2')];
    clock = 0;
    expect((await cached.list()).map((value) => value.paneId)).toEqual(['%1', '%2']);
    expect(source.calls).toBe(2);
  });

  it('gives every caller an independent copy', async () => {
    const source = fakeSource();
    const cached = cachedPaneSource(source, 1_000, () => 0);
    const first = await cached.list() as LivePane[];
    first[0]!.currentCommand = 'bash';
    first.push(pane('%9'));
    const second = await cached.list();
    expect(second).toEqual([pane('%1')]);
    expect(source.calls).toBe(1);
  });

  it('delegates subscriptions to the underlying source', () => {
    let subscribed = 0;
    const source: ReadonlyPaneSource = {
      list: async () => [],
      subscribe: () => { subscribed += 1; return () => {}; },
    };
    cachedPaneSource(source, 1_000).subscribe(() => {});
    expect(subscribed).toBe(1);
  });
});
