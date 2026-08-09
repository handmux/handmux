import { describe, it, expect, vi } from 'vitest';
import { runSplitPane, runClosePane } from '../src/paneActions.js';

const pickId = (items, prefer) =>
  (prefer && items.some((x) => x.id === prefer) ? prefer : items[0].id);

describe('runSplitPane', () => {
  it('splits h, refetches, and selects the NEW pane id', async () => {
    const api = { splitPane: vi.fn().mockResolvedValue({ id: '%2' }) };
    const panes = [{ id: '%1', command: 'zsh' }, { id: '%2', command: 'zsh' }];
    const getPanes = vi.fn().mockResolvedValue(panes);

    const result = await runSplitPane({ paneId: '%1', dir: 'h', windowId: '@1', api, getPanes });

    expect(api.splitPane).toHaveBeenCalledWith('%1', 'h');
    expect(getPanes).toHaveBeenCalledWith('@1');
    expect(result).toEqual({ panes, selectPaneId: '%2' });
  });

  it('splits v', async () => {
    const api = { splitPane: vi.fn().mockResolvedValue({ id: '%3' }) };
    const getPanes = vi.fn().mockResolvedValue([{ id: '%1' }, { id: '%3' }]);

    await runSplitPane({ paneId: '%1', dir: 'v', windowId: '@1', api, getPanes });

    expect(api.splitPane).toHaveBeenCalledWith('%1', 'v');
  });

  it('propagates a split failure without refetching', async () => {
    const api = { splitPane: vi.fn().mockRejectedValue(new Error('boom')) };
    const getPanes = vi.fn();

    await expect(runSplitPane({ paneId: '%1', dir: 'h', windowId: '@1', api, getPanes }))
      .rejects.toThrow('boom');
    expect(getPanes).not.toHaveBeenCalled();
  });

  it('rejects a malformed split response before refetching panes', async () => {
    const api = { splitPane: vi.fn().mockResolvedValue({ id: 7 }) };
    const getPanes = vi.fn();

    await expect(runSplitPane({ paneId: '%1', dir: 'h', windowId: '@1', api, getPanes }))
      .rejects.toThrow('invalid response');
    expect(getPanes).not.toHaveBeenCalled();
  });
});

describe('runClosePane', () => {
  it('closes, refetches, and re-targets when the closed pane was the viewed one', async () => {
    const api = { closePane: vi.fn().mockResolvedValue(undefined) };
    const survivor = [{ id: '%1', command: 'zsh' }];
    const getPanes = vi.fn().mockResolvedValue(survivor);

    const result = await runClosePane({
      paneId: '%2', windowId: '@1', viewedPaneId: '%2', api, getPanes, pickId,
    });

    expect(api.closePane).toHaveBeenCalledWith('%2');
    expect(result).toEqual({ panes: survivor, selectPaneId: '%1' });
  });

  it('does NOT re-target when the closed pane was not the viewed one', async () => {
    const api = { closePane: vi.fn().mockResolvedValue(undefined) };
    const remaining = [{ id: '%1' }, { id: '%2' }];
    const getPanes = vi.fn().mockResolvedValue(remaining);

    const result = await runClosePane({
      paneId: '%3', windowId: '@1', viewedPaneId: '%1', api, getPanes, pickId,
    });

    expect(result).toEqual({ panes: remaining, selectPaneId: null });
  });

  it('propagates a close failure without refetching', async () => {
    const api = { closePane: vi.fn().mockRejectedValue(new Error('nope')) };
    const getPanes = vi.fn();

    await expect(runClosePane({
      paneId: '%1', windowId: '@1', viewedPaneId: '%1', api, getPanes, pickId,
    })).rejects.toThrow('nope');
    expect(getPanes).not.toHaveBeenCalled();
  });
});
