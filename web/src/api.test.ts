import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getWorkspaceProtectionStatus,
  getWorkspaceRestoreOperation,
  getWorkspaceRestorePlan,
  startWorkspaceRestore,
} from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const jsonRes = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

describe('workspace restore api', () => {
  it('gets the current workspace protection status', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => jsonRes(200, { status: 'protected' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getWorkspaceProtectionStatus()).resolves.toEqual({ status: 'protected' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/workspace/status');
  });

  it('gets the server-authored latest restore plan', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => jsonRes(200, { checkpointId: 'checkpoint-a' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getWorkspaceRestorePlan()).resolves.toEqual({ checkpointId: 'checkpoint-a' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspace/restore-plan?checkpoint=latest',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('encodes an explicit checkpoint id in the restore-plan query', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => jsonRes(200, { checkpointId: 'checkpoint a' }));
    vi.stubGlobal('fetch', fetchMock);
    await getWorkspaceRestorePlan('checkpoint a');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/workspace/restore-plan?checkpoint=checkpoint%20a');
  });

  it('starts a restore with a checkpoint-scoped JSON request', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => jsonRes(202, { operationId: 'operation-a' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(startWorkspaceRestore({ checkpointId: 'checkpoint-a', sessions: ['api'] }))
      .resolves.toEqual({ operationId: 'operation-a' });
    expect(fetchMock).toHaveBeenCalledWith('/api/workspace/restore', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ checkpointId: 'checkpoint-a', sessions: ['api'] }),
    }));
  });

  it('gets an encoded restore operation id', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => jsonRes(200, { id: 'operation a', status: 'running' }));
    vi.stubGlobal('fetch', fetchMock);
    await getWorkspaceRestoreOperation('operation a');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/workspace/restore/operation%20a');
  });
});
