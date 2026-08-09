import path from 'node:path';

export interface WorkspacePaths {
  root: string;
  liveDir: string;
  liveCurrent: string;
  liveMirror: string;
  checkpointsDir: string;
  recoveryDir: string;
  operationsDir: string;
  latest: string;
  lockDir: string;
}

export function workspacePaths(home: string): WorkspacePaths {
  const root = path.join(home, '.handmux', 'workspaces');
  return {
    root,
    liveDir: path.join(root, 'live'),
    liveCurrent: path.join(root, 'live', 'current.json'),
    liveMirror: path.join(root, 'live', 'mirror.json'),
    checkpointsDir: path.join(root, 'checkpoints'),
    recoveryDir: path.join(root, 'recovery'),
    operationsDir: path.join(root, 'operations'),
    latest: path.join(root, 'latest.json'),
    lockDir: path.join(root, 'restore.lock'),
  };
}
