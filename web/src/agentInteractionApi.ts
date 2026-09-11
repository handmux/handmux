import { requestJson } from './apiRequest.js';
import { parseSseFrames } from './sse.js';
import { getToken } from './storage.js';
import { UnauthorizedError } from './apiErrors.js';
import type { AgentRunRef } from './agentCatalog.js';
import type {
  AgentInteractionEvent,
  AgentInteractionFormField,
  AgentInteractionDetail,
  AgentInteractionOption,
  AgentInteractionReason,
  AgentInteractionReceipt,
  AgentInteractionValue,
  PendingAgentInteraction,
} from './agentInteractionTypes.js';

const REASONS = new Set<AgentInteractionReason>([
  'invalid_request', 'invalid_value', 'local_only', 'stale_run', 'already_resolved',
  'provider_rejected', 'temporarily_unavailable', 'stream_reset',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function options(value: unknown): AgentInteractionOption[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
  const parsed = value.flatMap((candidate) => {
    const option = record(candidate);
    return option && typeof option.id === 'string' && typeof option.label === 'string'
      && (option.description === undefined || typeof option.description === 'string')
      ? [{
        id: option.id, label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      }] : [];
  });
  return parsed.length === value.length ? parsed as AgentInteractionOption[] : null;
}

function details(value: unknown): AgentInteractionDetail[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null;
  const parsed = value.flatMap((candidate) => {
    const detail = record(candidate);
    return detail && ['text', 'code', 'path'].includes(String(detail.type))
      && typeof detail.text === 'string'
      && (detail.kind === undefined
        || ['reason', 'command', 'working_directory', 'context'].includes(String(detail.kind)))
      ? [{
        type: detail.type as AgentInteractionDetail['type'], text: detail.text,
        ...(detail.kind === undefined ? {} : {
          kind: detail.kind as NonNullable<AgentInteractionDetail['kind']>,
        }),
      }] : [];
  });
  return parsed.length === value.length ? parsed as AgentInteractionDetail[] : null;
}

function fields(value: unknown): AgentInteractionFormField[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
  const parsed = value.flatMap((candidate) => {
    const field = record(candidate);
    if (!field || typeof field.id !== 'string'
      || !['text', 'secret', 'select'].includes(String(field.type))
      || typeof field.prompt !== 'string'
      || (field.label !== undefined && typeof field.label !== 'string')
      || (field.allowOther !== undefined && typeof field.allowOther !== 'boolean')) return [];
    const parsedOptions = options(field.options);
    if (parsedOptions === null || ((field.type === 'select') !== (parsedOptions !== undefined))
      || (field.type !== 'select' && field.allowOther !== undefined)) return [];
    return [{
      id: field.id, type: field.type as AgentInteractionFormField['type'], prompt: field.prompt,
      ...(field.label === undefined ? {} : { label: field.label }),
      ...(parsedOptions === undefined ? {} : { options: parsedOptions }),
      ...(field.allowOther === undefined ? {} : { allowOther: field.allowOther }),
    }];
  });
  return parsed.length === value.length ? parsed as AgentInteractionFormField[] : null;
}

export function parsePendingAgentInteraction(value: unknown): PendingAgentInteraction | null {
  const item = record(value);
  if (!item || typeof item.id !== 'string' || typeof item.runId !== 'string'
    || typeof item.prompt !== 'string' || typeof item.resolutionToken !== 'string'
    || !['approval', 'select', 'multi_select', 'text', 'editor', 'form', 'local_only'].includes(String(item.type))
    || (item.intent !== undefined && ![
      'command_approval', 'file_approval', 'permission_approval', 'input_request',
    ].includes(String(item.intent)))) {
    return null;
  }
  const parsedOptions = options(item.options);
  const parsedDetails = details(item.details);
  const parsedFields = fields(item.fields);
  const requiresOptions = ['approval', 'select', 'multi_select'].includes(String(item.type));
  const requiresFields = item.type === 'form';
  if (parsedOptions === null || parsedDetails === null || parsedFields === null
    || requiresOptions !== (parsedOptions !== undefined)
    || requiresFields !== (parsedFields !== undefined)) return null;
  return {
    id: item.id, runId: item.runId,
    type: item.type as PendingAgentInteraction['type'], prompt: item.prompt,
    resolutionToken: item.resolutionToken,
    ...(item.intent === undefined ? {} : {
      intent: item.intent as NonNullable<PendingAgentInteraction['intent']>,
    }),
    ...(typeof item.correlationId === 'string' ? { correlationId: item.correlationId } : {}),
    ...(parsedOptions === undefined ? {} : { options: parsedOptions }),
    ...(parsedDetails === undefined ? {} : { details: parsedDetails }),
    ...(parsedFields === undefined ? {} : { fields: parsedFields }),
  };
}

function event(value: unknown): AgentInteractionEvent | null {
  const item = record(value);
  if (!item || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0) return null;
  if (item.type === 'opened') {
    const interaction = parsePendingAgentInteraction(item.interaction);
    return interaction ? { type: 'opened', revision: Number(item.revision), interaction } : null;
  }
  if ((item.type === 'resolved' || item.type === 'cancelled')
    && typeof item.interactionId === 'string'
    && (item.reason === undefined || REASONS.has(item.reason as AgentInteractionReason))) {
    return {
      type: item.type, revision: Number(item.revision), interactionId: item.interactionId,
      ...(item.type === 'cancelled' && typeof item.reason === 'string'
        ? { reason: item.reason as AgentInteractionReason } : {}),
    };
  }
  return null;
}

export async function respondAgentInteraction(
  run: AgentRunRef,
  interaction: PendingAgentInteraction,
  value: AgentInteractionValue,
): Promise<AgentInteractionReceipt> {
  const result = await requestJson('/api/agents/interaction/respond', {
    method: 'POST', body: JSON.stringify({
      run,
      request: {
        interactionId: interaction.id,
        resolutionToken: interaction.resolutionToken,
        value,
      },
    }),
  });
  const receipt = record(result);
  if (!receipt || !['accepted', 'already_resolved', 'stale_run', 'rejected', 'unknown']
    .includes(String(receipt.status))
    || (receipt.reason !== undefined && !REASONS.has(receipt.reason as AgentInteractionReason))) {
    throw new Error('Agent Interaction returned an invalid receipt');
  }
  return {
    status: receipt.status as AgentInteractionReceipt['status'],
    ...(typeof receipt.reason === 'string' ? { reason: receipt.reason as AgentInteractionReason } : {}),
  };
}

export async function streamAgentInteractions(
  run: AgentRunRef,
  options: {
    signal: AbortSignal;
    onReady(checkpoint: { revision: number; pending: PendingAgentInteraction[] }): void;
    onEvent(event: AgentInteractionEvent): void;
  },
): Promise<void> {
  const query = new URLSearchParams({
    agentId: run.agentId, paneId: run.paneId, runId: run.runId,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
  });
  const response = await fetch(`/api/agents/interaction/live?${query}`, {
    cache: 'no-store', signal: options.signal,
    headers: { Authorization: `Bearer ${getToken() ?? ''}`, Accept: 'text/event-stream' },
  });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok || !response.body) throw new Error('Agent Interaction stream unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const frames = parseSseFrames(buffer);
      buffer = frames.rest;
      for (const frame of frames.frames) {
        const envelope = record(JSON.parse(frame) as unknown);
        if (envelope?.type === 'ready') {
          const checkpoint = record(envelope.checkpoint);
          const values = Array.isArray(checkpoint?.pending)
            ? checkpoint.pending.map(parsePendingAgentInteraction) : [];
          if (!checkpoint || !Number.isSafeInteger(checkpoint.revision)
            || values.some((item) => item === null)) throw new Error('Invalid Interaction checkpoint');
          options.onReady({
            revision: Number(checkpoint.revision), pending: values as PendingAgentInteraction[],
          });
        } else if (envelope?.type === 'event') {
          const parsed = event(envelope.event);
          if (!parsed) throw new Error('Invalid Interaction event');
          options.onEvent(parsed);
        } else if (envelope?.type === 'error') throw new Error('Agent Interaction stream unavailable');
      }
      if (done) return;
    }
  } finally {
    try { void reader.cancel().catch(() => {}); } catch { /* already closed */ }
    try { reader.releaseLock(); } catch { /* already closed */ }
  }
}
