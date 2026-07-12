import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PushScriptSheet from '../src/components/PushScriptSheet.jsx';

describe('PushScriptSheet', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<PushScriptSheet open={false} pushKey="k" notifyOn onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
  it('shows the command, this device key, and the reliability note', () => {
    render(<PushScriptSheet open pushKey="DEVKEY1" notifyOn onClose={() => {}} />);
    expect(screen.getByText(/handmux push "构建完成"/)).toBeTruthy();
    expect(screen.getByText(/DEVKEY1/)).toBeTruthy();
    expect(screen.getByText(/FCM|APNs|IM|微信|Telegram/)).toBeTruthy();
  });
  // Regression: the sheet must use the real, existing settings-card shell (visible + interactive),
  // NOT the non-existent `.file-sheet-*` classes that left it rendered offscreen (translateY(100%)).
  it('renders on the real settings-card shell with a backdrop', () => {
    const { container } = render(<PushScriptSheet open pushKey="k" notifyOn onClose={() => {}} />);
    expect(container.querySelector('.settings-card')).toBeTruthy();
    expect(container.querySelector('.settings-backdrop')).toBeTruthy();
    expect(container.querySelector('.file-sheet')).toBeNull();
  });
  it('shows an enable hint and no key when notifications are off', () => {
    render(<PushScriptSheet open pushKey={null} notifyOn={false} onClose={() => {}} />);
    expect(screen.getByText(/开启|enable/i)).toBeTruthy();
  });
});
