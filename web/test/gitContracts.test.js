import { describe, expect, it } from 'vitest';
import {
  parseGitBranches,
  parseGitCommit,
  parseGitDiff,
  parseGitLog,
  parseGitRepos,
  parseGitStatus,
} from '../src/gitContracts.js';

describe('git runtime contracts', () => {
  it('parses every Git API response shape', () => {
    expect(parseGitRepos({ repos: [{ name: 'p', path: '/p', branch: 'main', dirty: false }] })[0].path).toBe('/p');
    expect(parseGitStatus({ changes: [{ x: 'M', y: '', path: 'a.ts' }] })[0].x).toBe('M');
    expect(parseGitLog({ commits: [{ hash: 'abc', short: 'abc', subject: 's', author: 'a', relDate: '1d' }] })[0].hash).toBe('abc');
    expect(parseGitBranches({ branches: [{ name: 'main', current: true, upstream: null, ahead: 0, behind: 0 }] })[0].current).toBe(true);
    expect(parseGitDiff({ diff: 'x', truncated: false })).toEqual({ diff: 'x', truncated: false });
    expect(parseGitCommit({ message: 'm', files: [{ x: 'A', y: '', path: 'a.ts' }] }).files[0].path).toBe('a.ts');
    expect(parseGitRepos({ repos: [{ path: '/legacy' }] })[0]).toMatchObject({ branch: 'HEAD', dirty: false });
    expect(parseGitBranches({ branches: [{ name: 'legacy', current: false }] })[0]).toMatchObject({ upstream: null, ahead: 0, behind: 0 });
  });

  it('rejects malformed nested data instead of leaking it into the view', () => {
    expect(() => parseGitRepos({ repos: [{ path: 7 }] })).toThrow('invalid response');
    expect(() => parseGitBranches({ branches: [{ name: 'main', current: 'yes' }] })).toThrow('invalid response');
    expect(() => parseGitCommit({ message: 'm', files: [{ x: 'A', y: '', path: 7 }] })).toThrow('invalid response');
    expect(() => parseGitDiff({ diff: null, truncated: false })).toThrow('invalid response');
  });
});
