import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import UploadOverlay from '../src/components/UploadOverlay.jsx';
import { finishUpload, startUpload, updateUpload } from '../src/uploadJob.js';

afterEach(() => {
  cleanup();
  finishUpload();
});

describe('UploadOverlay', () => {
  it('uses the shared host and cancels the active upload', () => {
    const controller = new AbortController();
    render(<UploadOverlay />);
    act(() => {
      startUpload(controller, 'artifact.zip');
      updateUpload({ pct: 0.42 });
    });

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.closest('.overlay-layer')?.parentElement).toBe(document.body);
    expect(dialog.textContent).toContain('artifact.zip');
    expect(dialog.textContent).toContain('42%');
    fireEvent.click(screen.getByRole('button', { name: /取消|Cancel/i }));
    expect(controller.signal.aborted).toBe(true);
  });
});
