export function settleCodexOutgoing(items, id, { result, error, uncertain = false } = {}) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return items;
  if (error) {
    if (item.source === 'steer' || (item.source === 'queue' && !uncertain)) {
      return items.filter((candidate) => candidate.id !== id);
    }
    if (uncertain) {
      return items.map((candidate) => candidate.id === id
        ? { ...candidate, status: 'sending' }
        : candidate);
    }
    return items.map((candidate) => candidate.id === id
      ? { ...candidate, status: 'failed', error: error?.serverError || error?.message || null }
      : candidate);
  }
  if (result?.queued) {
    return items.map((candidate) => candidate.id === id
      ? { ...candidate, status: 'queued', queueId: result.item?.id || null }
      : candidate);
  }
  const status = item.source === 'steer' ? 'steered' : 'accepted';
  return items.map((candidate) => candidate.id === id
    ? { ...candidate, status, ...(candidate.source === 'queue' ? { source: 'send' } : {}) }
    : candidate);
}
