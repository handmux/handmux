export type ProjectTaskStoreState = 'ready' | 'recovering' | 'unavailable';
export type TaskStatus = 'draft' | 'ready' | 'canceled';
export type TaskPriority = 'none' | 'high' | 'medium' | 'low';

export interface ProjectTaskStatus {
  status: ProjectTaskStoreState;
  schemaVersion: number;
  recoveryNotice?: string;
  error?: { code: string; message: string };
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  repositoryRoot: string | null;
  defaultAgent: 'codex' | 'claude' | null;
  executionMode: 'project-root' | 'worktree';
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskReference {
  kind: 'url' | 'path';
  value: string;
  label: string | null;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  scope: string | null;
  constraints: string | null;
  references: TaskReference[];
  status: TaskStatus;
  priority: TaskPriority;
  briefVersion: number;
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDraftInput {
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  scope: string | null;
  constraints: string | null;
  references: TaskReference[];
  priority: TaskPriority;
}
