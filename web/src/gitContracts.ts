export interface GitRepo {
  name: string;
  path: string;
  branch: string;
  dirty: boolean;
}

export interface GitChange {
  x: string;
  y: string;
  path: string;
}

export interface GitCommitSummary {
  hash: string;
  short: string;
  subject: string;
  author: string;
  relDate: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GitDiffResponse {
  diff: string;
  truncated: boolean;
}

export interface GitCommitDetail {
  message: string;
  files: GitChange[];
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const invalid = (endpoint: string): never => {
  throw new Error(`${endpoint} returned an invalid response`);
};

const parseArray = <T>(
  response: unknown,
  key: string,
  endpoint: string,
  parseItem: (value: unknown) => T,
): T[] => {
  const record = recordOf(response);
  const values = record?.[key];
  if (!Array.isArray(values)) return invalid(endpoint);
  return values.map(parseItem);
};

const parseRepo = (value: unknown): GitRepo => {
  const repo = recordOf(value);
  if (!repo
    || typeof repo.path !== 'string'
    || !(repo.name === undefined || typeof repo.name === 'string')
    || !(repo.branch === undefined || typeof repo.branch === 'string')
    || !(repo.dirty === undefined || typeof repo.dirty === 'boolean')) return invalid('git/repos');
  return {
    name: repo.name ?? repo.path.split('/').filter(Boolean).at(-1) ?? repo.path,
    path: repo.path,
    branch: repo.branch ?? 'HEAD',
    dirty: repo.dirty ?? false,
  };
};

const parseChange = (value: unknown): GitChange => {
  const change = recordOf(value);
  if (!change
    || typeof change.x !== 'string'
    || typeof change.y !== 'string'
    || typeof change.path !== 'string') return invalid('git change');
  return { x: change.x, y: change.y, path: change.path };
};

const parseCommitSummary = (value: unknown): GitCommitSummary => {
  const commit = recordOf(value);
  if (!commit
    || typeof commit.hash !== 'string'
    || typeof commit.short !== 'string'
    || typeof commit.subject !== 'string'
    || typeof commit.author !== 'string'
    || typeof commit.relDate !== 'string') return invalid('git/log');
  return {
    hash: commit.hash,
    short: commit.short,
    subject: commit.subject,
    author: commit.author,
    relDate: commit.relDate,
  };
};

const parseBranch = (value: unknown): GitBranch => {
  const branch = recordOf(value);
  if (!branch
    || typeof branch.name !== 'string'
    || typeof branch.current !== 'boolean'
    || !(branch.upstream === undefined || branch.upstream === null || typeof branch.upstream === 'string')
    || !(branch.ahead === undefined || (typeof branch.ahead === 'number' && Number.isFinite(branch.ahead)))
    || !(branch.behind === undefined || (typeof branch.behind === 'number' && Number.isFinite(branch.behind)))) {
    return invalid('git/branches');
  }
  return {
    name: branch.name,
    current: branch.current,
    upstream: branch.upstream ?? null,
    ahead: branch.ahead ?? 0,
    behind: branch.behind ?? 0,
  };
};

export const parseGitRepos = (response: unknown): GitRepo[] => (
  parseArray(response, 'repos', 'git/repos', parseRepo)
);

export const parseGitStatus = (response: unknown): GitChange[] => (
  parseArray(response, 'changes', 'git/status', parseChange)
);

export const parseGitLog = (response: unknown): GitCommitSummary[] => (
  parseArray(response, 'commits', 'git/log', parseCommitSummary)
);

export const parseGitBranches = (response: unknown): GitBranch[] => (
  parseArray(response, 'branches', 'git/branches', parseBranch)
);

export function parseGitDiff(response: unknown): GitDiffResponse {
  const diff = recordOf(response);
  if (!diff || typeof diff.diff !== 'string' || typeof diff.truncated !== 'boolean') {
    return invalid('git/diff');
  }
  return { diff: diff.diff, truncated: diff.truncated };
}

export function parseGitCommit(response: unknown): GitCommitDetail {
  const commit = recordOf(response);
  if (!commit || typeof commit.message !== 'string' || !Array.isArray(commit.files)) {
    return invalid('git/commit');
  }
  return { message: commit.message, files: commit.files.map(parseChange) };
}
