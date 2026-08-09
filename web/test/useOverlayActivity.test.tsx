import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useEscapeLayer } from '../src/hooks/useEscapeLayer.js';
import { useOverlayActivity } from '../src/hooks/useOverlayActivity.js';

function Harness({ parent = false, child = false }: { parent?: boolean; child?: boolean }) {
  const active = useOverlayActivity();
  useEscapeLayer(parent, vi.fn());
  useEscapeLayer(child, vi.fn());
  return <output>{active ? 'owned' : 'free'}</output>;
}

describe('useOverlayActivity', () => {
  it('stays owned until the last nested Overlay closes', () => {
    const view = render(<Harness />);
    expect(screen.getByText('free')).toBeTruthy();
    view.rerender(<Harness parent />);
    expect(screen.getByText('owned')).toBeTruthy();
    view.rerender(<Harness parent child />);
    expect(screen.getByText('owned')).toBeTruthy();
    view.rerender(<Harness child />);
    expect(screen.getByText('owned')).toBeTruthy();
    view.rerender(<Harness />);
    expect(screen.getByText('free')).toBeTruthy();
  });
});
