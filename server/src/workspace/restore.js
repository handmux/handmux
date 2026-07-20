import fsp from 'node:fs/promises';
import os from 'node:os';
import { AGENTS } from '../agents/index.js';

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function windowMap(checkpoint) {
  return new Map(checkpoint.windows.map((window) => [window.id, window]));
}

function sessionMap(checkpoint) {
  return new Map(checkpoint.sessions.map((session) => [session.id, session]));
}

function emptyMapping() {
  return {
    names: {},
    runtime: { sessions: {}, windows: {}, panes: {} },
    logical: { sessions: {}, windows: {}, panes: {} },
  };
}

function mergeMapping(target, source) {
  Object.assign(target.names, source.names);
  for (const kind of ['sessions', 'windows', 'panes']) {
    Object.assign(target.runtime[kind], source.runtime[kind]);
    Object.assign(target.logical[kind], source.logical[kind]);
  }
  return target;
}

function mapRuntime(mapping, kind, source, logical, actual) {
  if (typeof source === 'string' && source) mapping.runtime[kind][source] = actual;
  if (typeof logical === 'string' && logical) mapping.logical[kind][logical] = actual;
}

async function usableCwd(cwd, { access, home, warnings }) {
  if (typeof cwd === 'string' && cwd) {
    try {
      await access(cwd);
      return cwd;
    } catch { /* fall through */ }
  }
  warnings.push(`cwd ${typeof cwd === 'string' && cwd ? cwd : '(missing)'} is unavailable; restored in ${home}`);
  return home;
}

function sortedPanes(window) {
  return [...window.panes].sort((a, b) => a.index - b.index);
}

function dispositionMap(plan) {
  return new Map((plan.windows || []).map((window) => [window.logicalId, window]));
}

async function notify(onProgress, results, result, total) {
  if (typeof onProgress !== 'function') return;
  await onProgress({ completed: results.length, total, result });
}

async function restoreOneSession({
  item, checkpoint, tmux, agents, access, home, dispositions, restoredWindows,
}) {
  const sessions = sessionMap(checkpoint);
  const windows = windowMap(checkpoint);
  const source = sessions.get(item.logicalId);
  if (!source) throw Object.assign(new Error('checkpoint session is missing'), { stage: 'plan' });

  const warnings = [];
  const mapping = emptyMapping();
  const localWindows = new Map();
  const localPanes = new Map();
  const links = [...item.windowLinks].sort((a, b) => a.index - b.index);
  const seedLink = links.find((link) => {
    if (restoredWindows.has(link.windowId)) return false;
    return dispositions.get(link.windowId)?.action !== 'reuse';
  });
  let temp = null;
  let topologyComplete = false;

  try {
    if (seedLink) {
      const seedWindow = windows.get(seedLink.windowId);
      const seedPane = sortedPanes(seedWindow)[0];
      const cwd = await usableCwd(seedPane.cwd, { access, home, warnings });
      temp = await tmux.createTemporarySession({
        cwd,
        sessionLogicalId: item.logicalId,
        windowLogicalId: seedWindow.id,
        paneLogicalId: seedPane.id,
        windowName: seedWindow.name,
        windowIndex: seedLink.index,
      });
      localWindows.set(seedWindow.id, temp.windowId);
      localPanes.set(seedPane.id, temp.paneId);
      mapRuntime(mapping, 'windows', seedWindow.runtimeId, seedWindow.id, temp.windowId);
      mapRuntime(mapping, 'panes', seedPane.runtimeId, seedPane.id, temp.paneId);
    } else {
      const fallbackWindow = windows.get(links[0]?.windowId);
      const cwd = await usableCwd(sortedPanes(fallbackWindow)[0].cwd, { access, home, warnings });
      temp = await tmux.createTemporarySession({ cwd, sessionLogicalId: item.logicalId });
    }
    mapRuntime(mapping, 'sessions', source.runtimeId, source.id, temp.sessionId);

    for (const link of links) {
      const window = windows.get(link.windowId);
      if (!window) throw new Error(`checkpoint window ${link.windowId} is missing`);
      if (localWindows.has(window.id)) continue;

      const sharedRuntime = restoredWindows.get(window.id);
      const disposition = dispositions.get(window.id);
      if (sharedRuntime || disposition?.action === 'reuse') {
        const windowId = sharedRuntime || disposition.runtimeId;
        await tmux.linkWindow(windowId, temp.sessionId, link.index, { existing: !sharedRuntime });
        if (!sharedRuntime) mapRuntime(mapping, 'windows', window.runtimeId, window.id, windowId);
        continue;
      }

      const firstPane = sortedPanes(window)[0];
      const cwd = await usableCwd(firstPane.cwd, { access, home, warnings });
      const created = await tmux.createWindow(temp.sessionId, {
        name: window.name,
        index: link.index,
        cwd,
        windowLogicalId: window.id,
        paneLogicalId: firstPane.id,
      });
      localWindows.set(window.id, created.windowId);
      localPanes.set(firstPane.id, created.paneId);
      mapRuntime(mapping, 'windows', window.runtimeId, window.id, created.windowId);
      mapRuntime(mapping, 'panes', firstPane.runtimeId, firstPane.id, created.paneId);
    }

    for (const [logicalId, runtimeId] of localWindows) {
      const window = windows.get(logicalId);
      const panes = sortedPanes(window);
      const seedPaneId = localPanes.get(panes[0].id);
      for (const pane of panes.slice(1)) {
        const cwd = await usableCwd(pane.cwd, { access, home, warnings });
        const paneId = await tmux.splitPane(seedPaneId, { cwd, paneLogicalId: pane.id });
        localPanes.set(pane.id, paneId);
        mapRuntime(mapping, 'panes', pane.runtimeId, pane.id, paneId);
      }
      try {
        await tmux.applyLayout(runtimeId, window.layout);
      } catch (error) {
        warnings.push(`layout for ${window.name} was unavailable; kept the default layout (${message(error)})`);
      }
      const activePane = localPanes.get(window.activePaneId);
      if (activePane) await tmux.selectPane(activePane);
    }

    const activeLink = links.find((link) => link.windowId === item.activeWindowId);
    if (activeLink) {
      if (typeof tmux.selectWindowInSession === 'function') await tmux.selectWindowInSession(temp.sessionId, activeLink.index);
      else {
        const activeWindow = localWindows.get(activeLink.windowId) || restoredWindows.get(activeLink.windowId);
        if (activeWindow) await tmux.selectWindow(activeWindow);
      }
    }

    if (!seedLink && temp.windowId) await tmux.killCreatedWindow(temp.windowId);
    await tmux.renameCreatedSession(temp.sessionId, item.targetName);
    topologyComplete = true;
    mapping.names[item.sourceName] = item.targetName;
    for (const [logicalId, runtimeId] of localWindows) restoredWindows.set(logicalId, runtimeId);

    for (const [logicalId, paneId] of localPanes) {
      const pane = [...windows.values()].flatMap((window) => window.panes).find((candidate) => candidate.id === logicalId);
      if (!pane?.agent) continue;
      const driver = agents.find((candidate) => candidate.id === pane.agent.id);
      if (!driver) {
        warnings.push(`agent ${pane.agent.id || '(missing)'} is unsupported; shell was restored`);
        continue;
      }
      if (!driver.sessions.isId(pane.agent.sessionId)) {
        warnings.push(`agent ${driver.id} session id is invalid; shell was restored`);
        continue;
      }
      try {
        await access(pane.agent.transcriptPath);
      } catch {
        warnings.push(`agent ${driver.id} context is unavailable; shell was restored`);
        continue;
      }
      const [cmd, ...args] = driver.sessions.resumeArgs(pane.agent.sessionId);
      try {
        await tmux.startAgent(paneId, cmd, args);
      } catch (error) {
        warnings.push(`agent ${driver.id} resume failed; shell was restored (${message(error)})`);
      }
    }

    return {
      logicalId: item.logicalId,
      sourceName: item.sourceName,
      targetName: item.targetName,
      status: 'restored',
      warnings,
      mapping,
    };
  } catch (error) {
    if (temp && !topologyComplete) {
      try { await tmux.killCreatedSession(temp.sessionId); } catch { /* retain original failure */ }
    }
    error.stage ||= 'topology';
    throw error;
  }
}

export function summarizeRestore(results) {
  const mapping = emptyMapping();
  for (const result of results) if (result.mapping) mergeMapping(mapping, result.mapping);
  const restored = results.filter((result) => result.status === 'restored').length;
  const alreadyPresent = results.filter((result) => result.status === 'already-present').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const status = failed === 0 ? 'succeeded' : restored + alreadyPresent > 0 ? 'partial' : 'failed';
  return { status, restored, alreadyPresent, failed, results, mapping };
}

export async function executeRestore({
  plan,
  checkpoint,
  tmux,
  agents = AGENTS,
  onProgress,
  access = fsp.access,
  home = os.homedir(),
} = {}) {
  const results = [];
  const dispositions = dispositionMap(plan);
  const restoredWindows = new Map();
  for (const item of plan.sessions) {
    let result;
    if (item.action === 'already-present') {
      result = { logicalId: item.logicalId, sourceName: item.sourceName, status: 'already-present' };
    } else if (item.action === 'unsupported') {
      result = { logicalId: item.logicalId, sourceName: item.sourceName, status: 'failed', stage: 'plan', error: item.reason };
    } else {
      try {
        result = await restoreOneSession({ item, checkpoint, tmux, agents, access, home, dispositions, restoredWindows });
      } catch (error) {
        result = {
          logicalId: item.logicalId,
          sourceName: item.sourceName,
          status: 'failed',
          stage: error.stage || 'topology',
          error: message(error),
        };
      }
    }
    results.push(result);
    await notify(onProgress, results, result, plan.sessions.length);
  }
  return summarizeRestore(results);
}
