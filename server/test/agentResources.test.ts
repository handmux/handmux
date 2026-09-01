import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentResourceError, AgentResourceService } from '../src/agent-runtime/resources.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'handmux-agent-resource-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('AgentResourceService', () => {
  it('binds byte resources to an adapter and session and never exposes mutable storage', async () => {
    const service = new AgentResourceService({ newResourceId: () => 'opaque-resource-id-0001' });
    const registry = service.forAdapter('pi');
    const source = new Uint8Array([1, 2, 3]);
    const registered = await registry.register(
      { agentId: 'pi', sessionId: 'session-1' },
      { kind: 'bytes', data: source, name: 'image.png', mediaType: 'image/png' },
    );
    source[0] = 9;

    expect(await service.read(
      { agentId: 'pi', sessionId: 'session-2' }, registered.resourceId,
    )).toBeNull();
    expect(await service.read(
      { agentId: 'codex', sessionId: 'session-1' }, registered.resourceId,
    )).toBeNull();
    const first = await service.read(
      { agentId: 'pi', sessionId: 'session-1' }, registered.resourceId,
    );
    expect(first).toMatchObject({
      resourceId: 'opaque-resource-id-0001',
      session: { agentId: 'pi', sessionId: 'session-1' },
      name: 'image.png', mediaType: 'image/png', size: 3,
    });
    expect([...first!.data]).toEqual([1, 2, 3]);
    first!.data[1] = 9;
    expect([...(await service.read(
      { agentId: 'pi', sessionId: 'session-1' }, registered.resourceId,
    ))!.data]).toEqual([1, 2, 3]);

    await service.forAdapter('codex').revoke(registered.resourceId);
    expect(await service.read(
      { agentId: 'pi', sessionId: 'session-1' }, registered.resourceId,
    )).not.toBeNull();
    await registry.revoke(registered.resourceId);
    expect(await service.read(
      { agentId: 'pi', sessionId: 'session-1' }, registered.resourceId,
    )).toBeNull();
  });

  it('expires resources and releases bounded byte capacity', async () => {
    let now = 1_000;
    let id = 0;
    const service = new AgentResourceService({
      now: () => now,
      ttlMs: 100,
      maxByteStorage: 3,
      newResourceId: () => `opaque-resource-id-${String(++id).padStart(4, '0')}`,
    });
    const registry = service.forAdapter('pi');
    const first = await registry.register(
      { agentId: 'pi', sessionId: 'session-1' },
      { kind: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'application/octet-stream' },
    );
    await expect(registry.register(
      { agentId: 'pi', sessionId: 'session-1' },
      { kind: 'bytes', data: new Uint8Array([4]), mediaType: 'application/octet-stream' },
    )).rejects.toMatchObject({ code: 'capacity-exceeded' });
    now = 1_100;
    expect(await service.read(
      { agentId: 'pi', sessionId: 'session-1' }, first.resourceId,
    )).toBeNull();
    await expect(registry.register(
      { agentId: 'pi', sessionId: 'session-1' },
      { kind: 'bytes', data: new Uint8Array([4]), mediaType: 'application/octet-stream' },
    )).resolves.toBeDefined();
  });

  it('serves only stable regular files within adapter-specific roots', async () => {
    const directory = await temporaryDirectory();
    const allowed = join(directory, 'allowed');
    const outside = join(directory, 'outside');
    await mkdir(allowed);
    await mkdir(outside);
    const allowedFile = join(allowed, 'result.txt');
    const outsideFile = join(outside, 'secret.txt');
    await writeFile(allowedFile, 'result');
    await writeFile(outsideFile, 'secret');
    await symlink(outsideFile, join(allowed, 'escape.txt'));
    let id = 0;
    const service = new AgentResourceService({
      allowedFileRoots: { pi: [allowed] },
      newResourceId: () => `opaque-resource-id-${String(++id).padStart(4, '0')}`,
    });
    const registry = service.forAdapter('pi');

    await expect(registry.register(
      { agentId: 'pi', sessionId: 'session-1' },
      { kind: 'file', path: outsideFile },
    )).rejects.toMatchObject({ code: 'path-denied' });
    await expect(registry.register(
      { agentId: 'pi', sessionId: 'session-1' },
      { kind: 'file', path: join(allowed, 'escape.txt') },
    )).rejects.toMatchObject({ code: 'path-denied' });

    const registered = await registry.register(
      { agentId: 'pi', sessionId: 'session-1' },
      { kind: 'file', path: allowedFile, mediaType: 'text/plain' },
    );
    const content = await service.read(
      { agentId: 'pi', sessionId: 'session-1' }, registered.resourceId,
    );
    expect(Buffer.from(content!.data).toString()).toBe('result');
    expect(content).toMatchObject({ name: 'result.txt', mediaType: 'text/plain', size: 6 });
    expect(content).not.toHaveProperty('path');

    const controlFile = join(allowed, 'line\nbreak.txt');
    await writeFile(controlFile, 'safe-name');
    const control = await registry.register(
      { agentId: 'pi', sessionId: 'session-1' },
      { kind: 'file', path: controlFile, mediaType: 'text/plain' },
    );
    expect((await service.read(
      { agentId: 'pi', sessionId: 'session-1' }, control.resourceId,
    ))?.name).toBe('line_break.txt');

    await writeFile(allowedFile, 'changed-size');
    await expect(service.read(
      { agentId: 'pi', sessionId: 'session-1' }, registered.resourceId,
    )).rejects.toBeInstanceOf(AgentResourceError);
    expect(await service.read(
      { agentId: 'pi', sessionId: 'session-1' }, registered.resourceId,
    )).toBeNull();
  });

  it('enforces owner metadata and per-resource limits before registration', async () => {
    const service = new AgentResourceService({
      maxResourceBytes: 2,
      newResourceId: () => 'opaque-resource-id-0001',
    });
    const registry = service.forAdapter('pi');
    await expect(registry.register(
      { agentId: 'codex', sessionId: 'session-1' },
      { kind: 'bytes', data: new Uint8Array([1]), mediaType: 'image/png' },
    )).rejects.toMatchObject({ code: 'invalid-source' });
    await expect(registry.register(
      { agentId: 'pi', sessionId: 'session-1' },
      { kind: 'bytes', data: new Uint8Array([1]), name: '../secret', mediaType: 'image/png' },
    )).rejects.toMatchObject({ code: 'invalid-source' });
    await expect(registry.register(
      { agentId: 'pi', sessionId: 'session-1' },
      { kind: 'bytes', data: new Uint8Array([1]), name: 'unsafe\r\nheader', mediaType: 'image/png' },
    )).rejects.toMatchObject({ code: 'invalid-source' });
    await expect(registry.register(
      { agentId: 'pi', sessionId: 'session-1' },
      { kind: 'bytes', data: new Uint8Array([1]), mediaType: 'not-a-media-type' },
    )).rejects.toMatchObject({ code: 'invalid-source' });
    await expect(registry.register(
      { agentId: 'pi', sessionId: 'session-1' },
      { kind: 'bytes', data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
    )).rejects.toMatchObject({ code: 'resource-too-large' });
  });
});
