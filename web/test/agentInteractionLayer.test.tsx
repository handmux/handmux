import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AgentInteractionLayer from '../src/components/AgentInteractionLayer.js';
import type { AgentInteractionController } from '../src/hooks/useAgentInteraction.js';
import type { PendingAgentInteraction } from '../src/agentInteractionTypes.js';

afterEach(cleanup);

function controller(
  pending: PendingAgentInteraction[],
  overrides: Partial<AgentInteractionController> = {},
): AgentInteractionController {
  return {
    pending, status: 'ready', error: null, respondingId: null,
    respond: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('AgentInteractionLayer', () => {
  it('renders normalized approval reason, command, and cwd together without provider branches', () => {
    render(<AgentInteractionLayer controller={controller([{
      id: 'interaction-1', runId: 'run-1', resolutionToken: 'resolution-1',
      type: 'approval', intent: 'command_approval', prompt: 'native fallback',
      details: [
        { kind: 'reason', type: 'text', text: 'Tests must pass.' },
        { kind: 'command', type: 'code', text: 'npm test' },
        { kind: 'working_directory', type: 'path', text: '/work/project' },
      ],
      options: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }],
    }])} />);

    expect(screen.getByRole('dialog').textContent).toContain('允许执行这个命令吗？');
    expect(screen.getByRole('dialog').textContent).toContain('Tests must pass.');
    expect(screen.getByRole('dialog').textContent).toContain('npm test');
    expect(screen.getByRole('dialog').textContent).toContain('/work/project');
    expect(screen.getByRole('dialog').textContent).not.toContain('native fallback');
  });

  it('submits multi-field secret and allow-other answers through one normalized response', async () => {
    const interaction: PendingAgentInteraction = {
      id: 'interaction-2', runId: 'run-1', resolutionToken: 'resolution-2',
      type: 'form', intent: 'input_request', prompt: 'native fallback',
      fields: [{
        id: 'field:0', type: 'secret', label: 'Secret', prompt: 'Password',
      }, {
        id: 'field:1', type: 'select', label: 'Color', prompt: 'Choose or enter',
        allowOther: true,
        options: [{ id: 'blue', label: 'Blue', description: 'Calm' }],
      }],
    };
    const value = controller([interaction]);
    const { container } = render(<AgentInteractionLayer controller={value} />);
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    const other = screen.getByLabelText('Choose or enter') as HTMLInputElement;
    expect(password.type).toBe('password');

    fireEvent.change(password, { target: { value: ' correct horse battery staple ' } });
    fireEvent.change(other, { target: { value: 'Mauve' } });
    expect(container.textContent).not.toContain('correct horse battery staple');
    fireEvent.click(screen.getByRole('button', { name: '确认' }));

    await waitFor(() => expect(value.respond).toHaveBeenCalledWith(interaction, {
      type: 'form', answers: {
        'field:0': ' correct horse battery staple ',
        'field:1': 'Mauve',
      },
    }));
  });

  it('keeps terminal fallback discoverable while a waiting interaction stream is degraded', () => {
    const onOpenTerminal = vi.fn();
    render(<AgentInteractionLayer waiting onOpenTerminal={onOpenTerminal}
      controller={controller([], {
        status: 'reconnecting', error: 'unavailable',
      })} />);
    expect(screen.getByRole('status').textContent).toContain('暂时无法在对话中处理这个请求');
    fireEvent.click(screen.getByRole('button', { name: '打开终端' }));
    expect(onOpenTerminal).toHaveBeenCalledOnce();
  });

  it('shows a stable localized error without leaking rejected response details or codes', async () => {
    const interaction: PendingAgentInteraction = {
      id: 'interaction-3', runId: 'run-1', resolutionToken: 'resolution-3',
      type: 'approval', intent: 'permission_approval', prompt: 'native fallback',
      options: [{ id: 'allow', label: 'Allow' }],
    };
    const value = controller([interaction], {
      respond: vi.fn(async () => {
        throw new Error('provider secret: /private/work interaction_response_failed');
      }),
      error: 'response_failed',
    });
    const { container } = render(<AgentInteractionLayer controller={value} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Allow' }));
    fireEvent.click(screen.getByRole('button', { name: '确认' }));

    await waitFor(() => expect(screen.getByRole('status').textContent)
      .toBe('没有发送成功，请重试或在终端中继续。'));
    expect(container.textContent).not.toContain('/private/work');
    expect(container.textContent).not.toContain('interaction_response_failed');
  });
});
