import { promises as fsp } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executablePath } from '../src/agents/processIdentity.js';

afterEach(() => vi.restoreAllMocks());

describe('executablePath', () => {
  it('uses Linux proc before a slow lsof lookup', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const readlink = vi.spyOn(fsp, 'readlink').mockResolvedValue('/opt/claude');
    const run = vi.fn(async () => { throw new Error('lsof timed out'); });
    expect(await executablePath(run, 101)).toBe('/opt/claude');
    expect(readlink).toHaveBeenCalledWith('/proc/101/exe');
    expect(run).not.toHaveBeenCalled();
  });
  it('retains macOS lsof identity lookup without reading proc', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const readlink = vi.spyOn(fsp, 'readlink');
    const run = vi.fn(async () => 'p101\nftxt\nn/opt/claude\n');
    expect(await executablePath(run, 101)).toBe('/opt/claude');
    expect(readlink).not.toHaveBeenCalled();
  });

  it('falls back to lsof when Linux proc is inaccessible and fails closed when both fail', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const readlink = vi.spyOn(fsp, 'readlink').mockRejectedValue(new Error('EACCES'));
    const run = vi.fn(async () => 'p101\nftxt\nn/opt/claude\n');
    expect(await executablePath(run, 101)).toBe('/opt/claude');
    run.mockRejectedValueOnce(new Error('lsof unavailable'));
    expect(await executablePath(run, 101)).toBe('');
    expect(readlink).toHaveBeenCalledTimes(2);
  });

});
