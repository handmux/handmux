import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectConversationMessages } from '../src/conversationPresentation.js';
import { ToolSheet } from '../src/components/ConversationTool.js';
import { fetchImageUrl } from '../src/api.js';
import { UnauthorizedError } from '../src/apiErrors.js';
import type { ConversationToolProjection } from '../src/conversationTimelineTypes.js';
vi.mock('../src/api.js', () => ({ fetchImageUrl: vi.fn() }));
const fetchImage = vi.mocked(fetchImageUrl);
const revoke = vi.fn();
const makeTool = (input: Record<string, unknown> = { path: '/tmp/picture.png' }, name = 'view_image') => ({
  name, input, result: 'data:image/png;base64,HIDDEN_IMAGE_DATA', isError: false,
} as ConversationToolProjection);
const props = { running: false, onClose: vi.fn(), copyId: 'image-1' };
beforeEach(() => { fetchImage.mockReset(); revoke.mockReset(); vi.stubGlobal('URL', class extends URL { static revokeObjectURL = revoke; }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('path-based tool image preview', () => {
  it('downloads the original image path through conversation presentation while showing the home label', async () => {
    const [message] = projectConversationMessages([{
      key: 'image', provisional: false,
      item: {
        id: 'image', sessionId: 'session', status: 'complete', kind: 'tool_call', callId: 'image', name: 'view_image',
        input: { path: '~/assets/picture.png' },
        extensions: { 'conversation.tool': {
          name: 'view_image', input: { path: '~/assets/picture.png' }, result: '', isError: false,
          imagePath: '/Users/alice/assets/picture.png',
        } },
      },
    }]);
    fetchImage.mockResolvedValue({ url: 'blob:original', mtimeMs: null });
    render(<ToolSheet {...props} tool={message!.tool!} />);
    await screen.findByRole('img');
    expect(fetchImage).toHaveBeenCalledWith('/Users/alice/assets/picture.png');
    expect(document.body.textContent).toContain('~/assets/picture.png');
    expect(document.body.textContent).not.toContain('/Users/alice');
  });
  it.each([null, '~/assets/picture.png', '/tmp/bad\0.png', 'relative.png'])(
    'does not fall back to display input when explicit image location is unavailable: %j', (imagePath) => {
      render(<ToolSheet {...props} tool={{ ...makeTool(), imagePath }} />);
      expect(fetchImage).not.toHaveBeenCalled();
    },
  );
  it('does not interpret a home display label as a download location', () => {
    render(<ToolSheet {...props} tool={makeTool({ path: '~/assets/picture.png' })} />);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it.each(['view_image', 'functions.view_image'])('loads %s by path and hides encoded output', async (name) => {
    fetchImage.mockResolvedValue({ url: 'blob:picture', mtimeMs: null });
    const view = render(<ToolSheet {...props} tool={makeTool(undefined, name)} />);
    expect((await screen.findByRole('img')).getAttribute('src')).toBe('blob:picture');
    expect(fetchImage).toHaveBeenCalledWith('/tmp/picture.png');
    expect(document.body.textContent).not.toContain('HIDDEN_IMAGE_DATA');
    view.rerender(<ToolSheet {...props} tool={null} />);
    expect(revoke).toHaveBeenCalledWith('blob:picture');
  });
  it.each([{}, {path: 'relative.png'}, {path: 'relative.png', cwd: 'relative'}, {path: '/tmp/a\0.png'}])('does not fetch an unresolved location %j', (input) => {
    render(<ToolSheet {...props} tool={makeTool(input)} />);
    expect(fetchImage).not.toHaveBeenCalled();
  });
  it('resolves relative paths only with explicit absolute cwd', async () => {
    fetchImage.mockResolvedValue({ url: 'blob:relative', mtimeMs: null });
    render(<ToolSheet {...props} tool={makeTool({ path: 'picture.png', cwd: '/tmp/work/' })} />);
    await screen.findByRole('img');
    expect(fetchImage).toHaveBeenCalledWith('/tmp/work/picture.png');
  });
  it('offers manual retry after download or image decode failure', async () => {
    fetchImage.mockRejectedValueOnce(new Error('missing')).mockResolvedValue({ url: 'blob:retry', mtimeMs: null });
    render(<ToolSheet {...props} tool={makeTool()} />);
    fireEvent.click((await screen.findByRole('status')).querySelector('button')!);
    fireEvent.error(await screen.findByRole('img'));
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.click(screen.getByRole('status').querySelector('button')!);
    await screen.findByRole('img');
    expect(fetchImage).toHaveBeenCalledTimes(3);
    expect(revoke).toHaveBeenCalledWith('blob:retry');
  });
  it('propagates authentication failure', async () => {
    const onAuthFail = vi.fn();
    fetchImage.mockRejectedValue(new UnauthorizedError());
    render(<ToolSheet {...props} tool={makeTool()} onAuthFail={onAuthFail} />);
    await waitFor(() => expect(onAuthFail).toHaveBeenCalledOnce());
  });
  it('revokes late old results on switching tools and closing while pending', async () => {
    let oldResolve!: (result: {url:string; mtimeMs:null}) => void;
    let newResolve!: (result: {url:string; mtimeMs:null}) => void;
    fetchImage.mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { newResolve = resolve; }));
    const view = render(<ToolSheet {...props} tool={makeTool()} />);
    view.rerender(<ToolSheet {...props} copyId="image-2" tool={makeTool({path:'/tmp/new.png'})} />);
    await act(async () => oldResolve({ url: 'blob:old', mtimeMs: null }));
    expect(revoke).toHaveBeenCalledWith('blob:old');
    expect(screen.queryByRole('img')).toBeNull();
    view.rerender(<ToolSheet {...props} tool={null} />);
    await act(async () => newResolve({ url: 'blob:new', mtimeMs: null }));
    expect(revoke).toHaveBeenCalledWith('blob:new');
    expect(screen.queryByRole('img')).toBeNull();
  });
  it('keeps ordinary tool output unchanged', () => {
    render(<ToolSheet {...props} tool={makeTool({cmd:'echo hi'}, 'exec_command')} />);
    expect(document.body.textContent).toContain('HIDDEN_IMAGE_DATA');
    expect(fetchImage).not.toHaveBeenCalled();
  });
});
