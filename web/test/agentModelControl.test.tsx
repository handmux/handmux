import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AgentModelControl from '../src/components/AgentModelControl.js';
import type { AgentSessionControlController } from '../src/hooks/useAgentSessionControl.js';

afterEach(() => cleanup());

function controller(overrides: Partial<AgentSessionControlController> = {}): AgentSessionControlController {
  return {
    status: 'ready', error: null, saving: false,
    modelControl: {
      canUpdate: true,
      models: [{
        id: 'provider/reasoner', label: 'Reasoner',
        efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low',
        serviceTiers: [{ id: 'priority', label: 'Fast', description: 'Lower latency' }],
      }],
      selected: { model: 'provider/reasoner', effort: 'low', serviceTier: null },
    },
    refresh: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('AgentModelControl', () => {
  it('has one provider-neutral JSX contract and keeps the existing model/effort interaction', async () => {
    const control = controller();
    const { container } = render(<AgentModelControl control={control} busy={false} />);
    expect(container.querySelector('[class*="codex"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '设置模型、服务等级和思考强度' }));
    expect(screen.getByRole('dialog', { name: '模型设置' })).toBeTruthy();
    expect(container.querySelector('.agent-model-menu')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Fast/ })).toBeTruthy();
    expect(container.querySelector('.agent-model-tier-title.fast path')?.getAttribute('d'))
      .toBe('m13 2-9 12h8l-1 8 9-12h-8z');
    fireEvent.click(screen.getByRole('checkbox', { name: /Fast/ }));
    await waitFor(() => expect(control.update).toHaveBeenCalledWith({ serviceTier: 'priority' }));
  });

  it.each(['fast', 'priority'])('restores the Bolt indicator for selected %s tiers', (tierId) => {
    const control = controller({
      modelControl: {
        canUpdate: true,
        models: [{
          id: 'p/m', label: 'A very long provider-neutral model label', efforts: [{ id: 'high' }],
          serviceTiers: [{ id: tierId, label: 'Fast' }],
        }],
        selected: { model: 'p/m', effort: 'high', serviceTier: tierId },
      },
    });
    const { container } = render(<AgentModelControl control={control} busy={false} />);
    const indicator = container.querySelector('.cc-tier-indicator.fast');
    expect(indicator?.querySelector('path')?.getAttribute('d'))
      .toBe('m13 2-9 12h8l-1 8 9-12h-8z');
    expect(container.querySelector('.cc-tier-indicator.standard')).toBeNull();
  });

  it('uses the same trigger and menu for any adapter snapshot because it accepts no provider id', () => {
    const first = render(<AgentModelControl control={controller()} busy />);
    const markup = first.container.innerHTML;
    first.unmount();
    const second = render(<AgentModelControl control={controller()} busy />);
    expect(second.container.innerHTML).toBe(markup);
  });

  it('shows a read-only snapshot while disabling every write control', () => {
    const control = controller({
      modelControl: {
        canUpdate: false,
        models: [{
          id: 'provider/reasoner', label: 'Reasoner',
          efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low',
          serviceTiers: [{ id: 'priority', label: 'Fast' }],
        }],
        selected: { model: 'provider/reasoner', effort: 'low', serviceTier: 'priority' },
      },
    });
    render(<AgentModelControl control={control} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: '设置模型、服务等级和思考强度' }));
    expect(screen.getByRole('button', { name: 'Reasoner' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('slider', { name: '思考强度' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('checkbox', { name: /Fast/ }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reasoner' }));
    expect(control.update).not.toHaveBeenCalled();
  });

  it('uses a single non-fast tier own label and can return to the default tier', async () => {
    const control = controller({
      modelControl: {
        canUpdate: true,
        models: [{ id: 'p/m', label: 'M', efforts: [], serviceTiers: [
          { id: 'economy', label: 'Economy', description: 'Lower cost' },
        ] }],
        selected: { model: 'p/m', effort: null, serviceTier: 'economy' },
      },
    });
    const { container } = render(<AgentModelControl control={control} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: '设置模型、服务等级和思考强度' }));
    const tier = screen.getByRole('checkbox', { name: /Economy/ });
    expect((tier as HTMLInputElement).checked).toBe(true);
    expect(container.querySelector('.agent-model-fast-row')).toBeNull();
    expect(container.querySelector('.agent-model-tier-row')).toBeTruthy();
    expect(container.querySelector('.cc-tier-indicator.standard svg')).toBeTruthy();
    expect(container.querySelectorAll('.cc-tier-indicator.standard path')).toHaveLength(2);
    expect(container.querySelector('.agent-model-tier-title.standard svg')).toBeTruthy();
    expect(container.querySelectorAll('.agent-model-tier-title.standard path')).toHaveLength(2);
    expect(container.querySelector('.agent-model-tier-title')?.textContent).toBe('Economy');
    fireEvent.click(tier);
    await waitFor(() => expect(control.update).toHaveBeenCalledWith({ serviceTier: null }));
  });

  it('renders every tier plus Default when an Adapter offers multiple tiers', async () => {
    const control = controller({
      modelControl: {
        canUpdate: true,
        models: [{ id: 'p/m', label: 'M', efforts: [], serviceTiers: [
          { id: 'economy', label: 'Economy' }, { id: 'burst', label: 'Burst' },
        ] }],
        selected: { model: 'p/m', effort: null, serviceTier: null },
      },
    });
    render(<AgentModelControl control={control} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: '设置模型、服务等级和思考强度' }));
    expect(screen.getByRole('radio', { name: '默认' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Economy' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Burst' }));
    await waitFor(() => expect(control.update).toHaveBeenCalledWith({ serviceTier: 'burst' }));
  });

  it('keeps one stable trigger while loading or failed and hides only explicit unavailable', () => {
    const loading = render(<AgentModelControl control={controller({
      status: 'loading', modelControl: null,
    })} busy={false} />);
    expect(screen.getByRole('button', { name: '设置模型、服务等级和思考强度' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '设置模型、服务等级和思考强度' }));
    expect(screen.getByText('正在获取可用模型…')).toBeTruthy();
    loading.unmount();

    const failed = render(<AgentModelControl control={controller({
      status: 'error', modelControl: null, error: 'temporary failure',
    })} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: '设置模型、服务等级和思考强度' }));
    expect(screen.getByText('模型设置暂时不可用，请重试。')).toBeTruthy();
    failed.unmount();

    const unavailable = render(<AgentModelControl control={controller({
      status: 'unavailable', modelControl: null,
    })} busy={false} />);
    expect(unavailable.container.childElementCount).toBe(0);
  });
});
