import { describe, expect, it } from 'vitest';
import { parsePendingAgentInteraction } from './agentInteractionApi.js';

function form() {
  return {
    id: 'interaction-1', runId: 'run-1', resolutionToken: 'resolution-1',
    type: 'form', intent: 'input_request', prompt: 'native prompt',
    details: [{ kind: 'context', type: 'text', text: 'Context' }],
    fields: [{ id: 'field:0', type: 'secret', prompt: 'Password' }, {
      id: 'field:1', type: 'select', prompt: 'Color', allowOther: true,
      options: [{ id: 'blue', label: 'Blue', description: 'Calm' }],
    }],
  };
}

describe('parsePendingAgentInteraction', () => {
  it('accepts normalized semantic details and multi-field forms', () => {
    expect(parsePendingAgentInteraction(form())).toEqual(form());
  });

  it('fails closed when form fields or detail semantics are malformed', () => {
    expect(parsePendingAgentInteraction({ ...form(), fields: undefined })).toBeNull();
    expect(parsePendingAgentInteraction({
      ...form(), details: [{ kind: 'provider-secret', type: 'text', text: 'Context' }],
    })).toBeNull();
    expect(parsePendingAgentInteraction({
      ...form(), fields: [{ id: 'field:0', type: 'select', prompt: 'Color' }],
    })).toBeNull();
  });
});
