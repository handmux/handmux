const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function changedLines(lines) {
  return lines.filter((line) => /^[+-]/.test(line)
    && !line.startsWith('+++') && !line.startsWith('---'));
}

export function parseUnifiedDiff(value, { created = false } = {}) {
  const lines = String(value || '').split('\n');
  let added = 0;
  let removed = 0;
  const hunks = [];
  let current = null;
  const flush = () => {
    if (current?.lines.length) hunks.push(current);
    current = null;
  };

  for (const line of lines) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      flush();
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    if (current && /^[ +\-]/.test(line) && !line.startsWith('+++') && !line.startsWith('---')) {
      current.lines.push(line);
    }
  }
  flush();
  return {
    added,
    removed,
    hunks: hunks.length ? hunks : null,
    ...(created ? { created: true } : {}),
  };
}

function applyPatchSection(value, path) {
  const lines = String(value || '').split('\n');
  let active = false;
  const section = [];
  for (const line of lines) {
    const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      if (active) break;
      active = header[1].trim() === path;
      continue;
    }
    if (active && line === '*** End Patch') break;
    if (active) section.push(line);
  }
  return section;
}

function diffKey(lines) {
  return changedLines(lines).join('\0');
}

function sameFilePath(left, right) {
  const a = String(left || '').replaceAll('\\', '/').replace(/^\.\//, '');
  const b = String(right || '').replaceAll('\\', '/').replace(/^\.\//, '');
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function candidateDiffs(thread) {
  const candidates = [];
  for (const turn of thread?.turns || []) {
    for (const item of turn?.items || []) {
      if (item?.type !== 'fileChange') continue;
      for (const change of item.changes || []) {
        const diff = parseUnifiedDiff(change?.diff, { created: change?.kind?.type === 'add' });
        if (!diff.hunks) continue;
        candidates.push({
          turnId: turn.id || null,
          path: change?.path || '',
          key: diffKey(String(change?.diff || '').split('\n')),
          diff,
        });
      }
    }
  }
  return candidates;
}

export function enrichCodexFileDiffs(messages, thread) {
  const candidates = candidateDiffs(thread);
  const used = new Set();
  return messages.map((message) => {
    const tool = message?.tool;
    if (tool?.name !== 'apply_patch' || !tool.diff || tool.diff.hunks?.length) return message;
    const path = tool.input?.file_path || '';
    const key = diffKey(applyPatchSection(tool.input?.patch, path));
    const matches = (candidate, index) => !used.has(index)
      && sameFilePath(candidate.path, path)
      && candidate.diff.added === tool.diff.added
      && candidate.diff.removed === tool.diff.removed
      && (!message.turnId || !candidate.turnId || candidate.turnId === message.turnId);
    let index = candidates.findIndex((candidate, candidateIndex) => matches(candidate, candidateIndex)
      && (!key || !candidate.key || candidate.key === key));
    if (index < 0 && !key) index = candidates.findIndex(matches);
    if (index < 0) return message;
    used.add(index);
    return { ...message, tool: { ...tool, diff: candidates[index].diff } };
  });
}
