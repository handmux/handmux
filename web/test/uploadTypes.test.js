import { describe, it, expect } from 'vitest';
import { UPLOAD_ACCEPT, isAllowedUploadName, splitUploadable } from '../src/uploadTypes.js';

describe('uploadTypes', () => {
  it('allows text/code, images and documents; rejects executables and extensionless names', () => {
    for (const ok of ['a.txt', 'main.py', 'App.tsx', 'shot.PNG', 'doc.pdf', 'sheet.xlsx']) {
      expect(isAllowedUploadName(ok)).toBe(true);
    }
    for (const bad of ['run', 'tool.exe', 'a.bin', 'lib.so', 'archive.zip', 'clip.mp4', '']) {
      expect(isAllowedUploadName(bad)).toBe(false);
    }
  });

  it('splitUploadable separates allowed files from rejected names', () => {
    const files = [{ name: 'note.md' }, { name: 'a.out' }, { name: 'pic.jpg' }, { name: 'go' }];
    const { allowed, rejected } = splitUploadable(files);
    expect(allowed.map((f) => f.name)).toEqual(['note.md', 'pic.jpg']);
    expect(rejected).toEqual(['a.out', 'go']);
  });

  it('accepts a lone File (not iterable) as well as an array/FileList', () => {
    const { allowed, rejected } = splitUploadable({ name: 'shared.txt' });
    expect(allowed.map((f) => f.name)).toEqual(['shared.txt']);
    expect(rejected).toEqual([]);
  });

  it('accept string carries dot-extensions but NO media wildcard (so the OS opens the file picker, not camera/gallery)', () => {
    expect(UPLOAD_ACCEPT).toContain('.txt');
    expect(UPLOAD_ACCEPT).toContain('.png');
    expect(UPLOAD_ACCEPT).not.toContain('image/*');
    expect(UPLOAD_ACCEPT).not.toContain('video/*');
  });
});
