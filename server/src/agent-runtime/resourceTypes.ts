import type { AgentSessionRef } from './run.js';

export type AgentResourceSource =
  | { kind: 'file'; path: string; name?: string; mediaType?: string }
  | { kind: 'bytes'; data: Uint8Array; name?: string; mediaType: string };

export interface AgentResourceRegistration {
  resourceId: string;
  expiresAt: number;
}

export interface AgentResourceRegistry {
  register(session: AgentSessionRef, source: AgentResourceSource): Promise<AgentResourceRegistration>;
  revoke(resourceId: string): Promise<void>;
}

export interface AgentResourceContent {
  resourceId: string;
  session: AgentSessionRef;
  data: Uint8Array;
  size: number;
  name?: string;
  mediaType: string;
  expiresAt: number;
}
