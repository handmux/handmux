import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

// Voice is stubbed idle — these tests cover the add/edit/delete/send paths, not dictation.
const voice = vi.hoisted(() => ({ state: 'idle', partial: '', level: 0, error: null, start: vi.fn(), stop: vi.fn(), onText: null }));
vi.mock('../src/voice/usePushToTalk.js', () => ({
  usePushToTalk: ({ onText }) => { voice.onText = onText; return voice; },
}));

import IdeaPanel from '../src/components/IdeaPanel.jsx';
import { getIdeas } from '../src/storage.js';

let container;
let root;

beforeEach(() => {
  localStorage.clear();
  voice.state = 'idle'; voice.partial = ''; voice.level = 0; voice.error = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const base = { open: true, session: 's', window: 'w', micAvailable: true, onClose: vi.fn(), onSend: vi.fn() };
const render = (props = {}) => act(() => root.render(<IdeaPanel {...base} {...props} />));
const $ = (sel) => container.querySelector(sel);
const $$ = (sel) => [...container.querySelectorAll(sel)];
const click = (node) => act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const tap = (node) => act(() => {
  node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  node.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
});
const typeInto = (node, text) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(node, text);
  node.dispatchEvent(new Event('input', { bubbles: true }));
});

describe('IdeaPanel', () => {
  it('renders nothing when closed', () => {
    render({ open: false });
    expect($('.idea-panel')).toBeNull();
  });

  it('shows the window name in the title and an empty state', () => {
    render();
    expect($('.cmd-title').textContent).toContain('w');
    expect($('.cmd-empty')).not.toBeNull();
  });

  it('shows an actionable voice error', () => {
    voice.error = '请给腾讯云授权';
    render();
    expect($('.voice-error').textContent).toBe('请给腾讯云授权');
  });

  it('一句话定稿补入已有内容，并且实时模式也显示音量波形', () => {
    render({ voiceMode: 'sentence' });
    const input = $('.idea-input');
    typeInto(input, '前后');
    act(() => { input.selectionStart = input.selectionEnd = 1; });
    tap($('.input-mic'));
    act(() => { voice.onText('语音'); });
    expect($('.idea-input').value).toBe('前语音后');

    voice.state = 'recording'; voice.level = 0.41;
    render({ voiceMode: 'streaming' });
    expect($('.input-mic-wave')?.dataset.level).toBe('0.41');
  });

  it('adds an idea (persists per session+window) and clears the box', () => {
    render();
    typeInto($('.idea-input'), '写测试');
    click($('.idea-act'));
    expect($$('.idea-row').map((r) => r.querySelector('.idea-text').textContent)).toEqual(['写测试']);
    expect(getIdeas('s', 'w').map((i) => i.text)).toEqual(['写测试']);
    expect($('.idea-input').value).toBe('');
  });

  it('ignores a blank add (button disabled / no row)', () => {
    render();
    typeInto($('.idea-input'), '   ');
    expect($('.idea-act').disabled).toBe(true);
    click($('.idea-act'));
    expect($$('.idea-row')).toHaveLength(0);
  });

  it('seeds from storage on open and 发送 fills via onSend', () => {
    const onSend = vi.fn();
    render({ onSend });
    typeInto($('.idea-input'), 'deploy');
    click($('.idea-act'));
    click($('.idea-send'));
    expect(onSend).toHaveBeenCalledWith('deploy');
  });

  it('edits a row in place (tap text → save) keeping its id', () => {
    render();
    typeInto($('.idea-input'), 'old');
    click($('.idea-act'));
    const id = getIdeas('s', 'w')[0].id;
    click($('.idea-text'));            // load into compose, switch to edit mode
    expect($('.idea-act').getAttribute('aria-label')).toBe('保存');
    expect($('.idea-cancel')).not.toBeNull();
    typeInto($('.idea-input'), 'new');
    click($('.idea-act'));
    const ideas = getIdeas('s', 'w');
    expect(ideas).toEqual([{ id, text: 'new' }]);
    expect($$('.idea-row')).toHaveLength(1);
  });

  it('deletes a row', () => {
    render();
    typeInto($('.idea-input'), 'gone');
    click($('.idea-act'));
    click($('.idea-del'));
    expect($$('.idea-row')).toHaveLength(0);
    expect(getIdeas('s', 'w')).toEqual([]);
  });
});
