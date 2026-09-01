export type AgentInteractionType =
  | 'approval' | 'select' | 'multi_select' | 'text' | 'editor' | 'form' | 'local_only';

export interface AgentInteractionOption { id: string; label: string; description?: string }

export interface AgentInteractionDetail {
  kind?: 'reason' | 'command' | 'working_directory' | 'context';
  type: 'text' | 'code' | 'path';
  text: string;
}

export type AgentInteractionIntent =
  | 'command_approval' | 'file_approval' | 'permission_approval' | 'input_request';

export interface AgentInteractionFormField {
  id: string;
  type: 'text' | 'secret' | 'select';
  prompt: string;
  label?: string;
  options?: AgentInteractionOption[];
  allowOther?: boolean;
}

export interface PendingAgentInteraction {
  id: string;
  runId: string;
  correlationId?: string;
  intent?: AgentInteractionIntent;
  type: AgentInteractionType;
  prompt: string;
  options?: AgentInteractionOption[];
  details?: AgentInteractionDetail[];
  fields?: AgentInteractionFormField[];
  resolutionToken: string;
}

export type AgentInteractionValue =
  | { type: 'approval'; optionId: string }
  | { type: 'selection'; optionIds: string[] }
  | { type: 'text'; text: string }
  | { type: 'form'; answers: Record<string, string> };

export interface AgentInteractionReceipt {
  status: 'accepted' | 'already_resolved' | 'stale_run' | 'rejected' | 'unknown';
  reason?: AgentInteractionReason;
}

export type AgentInteractionReason =
  | 'invalid_request' | 'invalid_value' | 'local_only' | 'stale_run' | 'already_resolved'
  | 'provider_rejected' | 'temporarily_unavailable' | 'stream_reset';

export type AgentInteractionEvent =
  | { type: 'opened'; revision: number; interaction: PendingAgentInteraction }
  | { type: 'resolved'; revision: number; interactionId: string }
  | { type: 'cancelled'; revision: number; interactionId: string; reason?: AgentInteractionReason };
