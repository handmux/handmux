export function settleCodexOutgoing(items, id, { result, error } = {}) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return items;
  if (error) {
    // A rejected request is no longer "sending". Delivery can still be ambiguous after a transport
    // failure, so the composer reports that uncertainty separately without inventing a durable message.
    return items.filter((candidate) => candidate.id !== id);
  }
  if (result?.queued) {
    return items.map((candidate) => candidate.id === id
      ? { ...candidate, source: 'queue', status: 'queued', queueId: result.item?.id || null }
      : candidate);
  }
  const status = item.source === 'steer' ? 'steered' : 'accepted';
  return items.map((candidate) => candidate.id === id
    ? { ...candidate, status, ...(candidate.source === 'queue' ? { source: 'send' } : {}) }
    : candidate);
}
