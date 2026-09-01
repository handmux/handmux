// server/test/uploadTypes.test.js
import { describe, it, expect } from 'vitest';
import { DEFAULT_UPLOAD_EXTS, loadUploadExts, isAllowedUploadExt } from '../src/uploadTypes.js';

describe('uploadTypes', () => {
  it('default set covers image/text/office/ZIP, not arbitrary binaries', () => {
    expect(isAllowedUploadExt('a.png', DEFAULT_UPLOAD_EXTS)).toBe(true);
    expect(isAllowedUploadExt('a.md', DEFAULT_UPLOAD_EXTS)).toBe(true);
    expect(isAllowedUploadExt('a.docx', DEFAULT_UPLOAD_EXTS)).toBe(true);
    expect(isAllowedUploadExt('archive.zip', DEFAULT_UPLOAD_EXTS)).toBe(true);
    expect(isAllowedUploadExt('a.exe', DEFAULT_UPLOAD_EXTS)).toBe(false);
    expect(isAllowedUploadExt('a.sh.bin', DEFAULT_UPLOAD_EXTS)).toBe(false);
  });
  it('is case-insensitive and needs an extension', () => {
    expect(isAllowedUploadExt('A.PNG', DEFAULT_UPLOAD_EXTS)).toBe(true);
    expect(isAllowedUploadExt('noext', DEFAULT_UPLOAD_EXTS)).toBe(false);
    expect(isAllowedUploadExt('', DEFAULT_UPLOAD_EXTS)).toBe(false);
  });
  it('env override replaces the default set (dots/case/space normalised)', () => {
    const exts = loadUploadExts({ HANDMUX_UPLOAD_EXTS: '.JPG, png ,md' });
    expect([...exts].sort()).toEqual(['jpg', 'md', 'png']);
    expect(isAllowedUploadExt('x.png', exts)).toBe(true);
    expect(isAllowedUploadExt('x.docx', exts)).toBe(false);
  });
  it('blank/absent env falls back to the default set', () => {
    expect(loadUploadExts({})).toBe(DEFAULT_UPLOAD_EXTS);
    expect(loadUploadExts({ HANDMUX_UPLOAD_EXTS: '   ' })).toBe(DEFAULT_UPLOAD_EXTS);
  });
});
