import { requestJson } from './apiRequest.js';
import type { AgentRunRef } from './agentCatalog.js';
export interface ScheduledScope { tmuxSession: string; paneId: string }
export type ScheduledRule = { frequency: 'once' | 'hourly' | 'daily' | 'weekly'; slots: Array<{ date?: string; time?: string; minute?: number; weekday?: number }>; endsAt?: string };
export interface ScheduledTask { id: string; revision: number; target: { agentId: string; sessionId: string; paneId: string; tmuxSession: string }; text: string; rule: ScheduledRule; timeZone: string; enabled: boolean; state: 'active' | 'ended' | 'exception'; nextAt: number | null; endedAt?: number; endedReason?: 'terminated'; lastAt?: number; lastResult?: string; blocked?: boolean; claim?: { at: number } }
export interface ScheduledException { id: string; revision: number; taskId: string; text: string; timeZone: string; scheduledAt: number; reason: string; unknown: boolean; count?: number; missedThroughAt?: number; target: ScheduledTask['target'] }
export interface ScheduledSnapshot { serverNow: number; timeZone: string; tasks: ScheduledTask[]; exceptions: ScheduledException[] }
export async function scheduledRequest<T>(scope: ScheduledScope, run: AgentRunRef | null, action: string, fields: Record<string, unknown> = {}): Promise<T> {
  return await requestJson<T>('/api/agents/scheduled-messages', { method: 'POST', body: JSON.stringify({ ...fields, ...scope, run, action }), timeoutMs: action === 'trigger' ? 35_000 : 12_000 }) as T;
}
