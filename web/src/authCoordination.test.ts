import { afterEach, expect, it, vi } from 'vitest';
import { withAuthLock } from './authCoordination.js';

afterEach(() => { vi.restoreAllMocks(); });
it('serializes this tab\'s auth requests even without Web Locks or writable storage', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
  let release!: () => void;
  const first = withAuthLock(() => new Promise<void>((resolve) => { release = resolve; }));
  const secondOperation = vi.fn(async () => 'second');
  const second = withAuthLock(secondOperation);
  await Promise.resolve();
  expect(secondOperation).not.toHaveBeenCalled();
  release(); await first;
  await expect(second).resolves.toBe('second');
});

it('continues after a failed request', async () => {
  await expect(withAuthLock(async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  await expect(withAuthLock(async () => 'ready')).resolves.toBe('ready');
});
