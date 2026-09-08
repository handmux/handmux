import type {
  ConversationContentBlock,
  ConversationTruncation,
} from './agentConversationTypes.js';

export interface ConversationDiffHunk {
  oldStart: number | null;
  newStart: number | null;
  lines: string[];
}

export interface ConversationDiff {
  added: number;
  removed: number;
  hunks: ConversationDiffHunk[] | null;
  created?: true;
}

export interface ConversationToolProjection {
  name: string;
  input: Record<string, unknown> | unknown[];
  result: string | null;
  isError: boolean;
  outcome?: 'running' | 'success' | 'failed' | 'declined' | 'completed';
  diff?: ConversationDiff;
  inputTruncation?: ConversationTruncation;
  outputTruncation?: ConversationTruncation;
  diffTruncation?: ConversationTruncation;
}

export interface ConversationPlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export interface ConversationPlan {
  steps?: ConversationPlanStep[];
  plan?: ConversationPlanStep[];
  explanation?: string;
}

export interface ConversationGoal {
  objective: string;
  status?: string;
  tokensUsed?: number;
  tokenBudget?: number | null;
  timeUsedSeconds?: number;
}

export interface ConversationTimelineMessage extends ConversationPlan {
  [key: string]: unknown;
  id?: string;
  k?: number | string;
  i?: number | string;
  turnId?: string | null;
  itemId?: string | null;
  role?: string;
  type: string;
  text?: string;
  ts?: string;
  streaming?: boolean;
  completed?: boolean;
  tool?: ConversationToolProjection;
  goal?: ConversationGoal;
  event?: string;
  name?: string;
  args?: string;
  result?: string;
  summary?: string;
  summaryTruncated?: boolean;
  summaryOriginalBytes?: number;
  conversationResources?: ConversationContentBlock[];
  conversationStatus?: string;
  conversationStatusMessage?: string;
}

export function conversationMessageIdentity(message: ConversationTimelineMessage): string {
  if (message.id != null) return String(message.id);
  if (message.k != null) return `k:${message.k}`;
  return `i:${message.i ?? ''}`;
}
