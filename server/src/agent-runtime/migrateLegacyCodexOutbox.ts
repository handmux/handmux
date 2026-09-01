import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseCodexOutboxSnapshot } from '../codexQueueProtocol.js';
import { PrivateStateStore } from '../privateStateStore.js';
import { parseConversationState } from './conversationStore.js';
import type {
  PersistedConversationDeliveryReceipt,
  PersistedConversationSubmission,
} from './conversationStore.js';

const DELIVERY_RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;

function payloadHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function migrationId(threadId: string, itemId: string, text: string): string {
  return `codex-legacy:${crypto.createHash('sha256').update(`${threadId}\0${itemId}\0${text}`)
    .digest('hex').slice(0, 40)}`;
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try { descriptor = fs.openSync(directory, 'r'); fs.fsyncSync(descriptor); } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function verifyBackup(file: string, fingerprint: string): void {
  if (!fs.existsSync(file)) {
    throw new Error('Conversation migration marker exists but the Codex outbox backup is missing');
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== fingerprint) {
    throw new Error('Codex outbox migration backup does not match its marker');
  }
}

function verifyMarkerSubmissions(
  state: ReturnType<typeof parseConversationState>,
  marker: NonNullable<NonNullable<ReturnType<typeof parseConversationState>['migrations']>['legacyCodexOutboxImported']>,
): void {
  if (!marker.submissionKeys) {
    throw new Error('Conversation migration marker has no scoped submission keys');
  }
  for (const key of marker.submissionKeys) {
    const [agentId, sessionId, clientRequestId] = key.split('\0');
    if (!agentId || !sessionId || !clientRequestId || !(state.submissions.some((submission) => (
      submission.agentId === agentId && submission.sessionId === sessionId
      && submission.clientRequestId === clientRequestId
    )) || state.deliveryReceipts?.some((receipt) => receipt.agentId === agentId
      && receipt.sessionId === sessionId && receipt.clientRequestId === clientRequestId))) {
      throw new Error('Conversation migration marker is missing a referenced delivery');
    }
  }
}

function requiredKeysFromBackup(file: string): string[] | null {
  if (!fs.existsSync(file)) return null;
  const legacy = parseCodexOutboxSnapshot(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!legacy) throw new Error('Legacy Codex outbox backup is corrupt');
  const keys = legacy.queues.flatMap((queue) => queue.items.map((item) => (
    `codex\0${queue.threadId}\0${item.requestId ?? migrationId(queue.threadId, item.id, item.text)}`
  )));
  for (const receipt of legacy.receipts) {
    if (receipt.status === 'pending' || receipt.status === 'accepted') {
      keys.push(`codex\0${receipt.threadId}\0${receipt.requestId}`);
    }
  }
  return [...new Set(keys)];
}

function verifyRequiredDeliveries(
  state: ReturnType<typeof parseConversationState>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const [agentId, sessionId, clientRequestId] = key.split('\0');
    if (!(state.submissions.some((submission) => submission.agentId === agentId
      && submission.sessionId === sessionId && submission.clientRequestId === clientRequestId)
      || state.deliveryReceipts?.some((receipt) => receipt.agentId === agentId
        && receipt.sessionId === sessionId && receipt.clientRequestId === clientRequestId))) {
      throw new Error('Conversation migration is missing a queued or uncertain delivery');
    }
  }
}

function finalizeMigration(
  legacyFile: string,
  conversationFile: string,
  state: ReturnType<typeof parseConversationState>,
  fingerprint: string,
): void {
  const marker = state.migrations?.legacyCodexOutboxImported;
  if (marker) verifyMarkerSubmissions(state, marker);
  const backup = `${legacyFile}.imported.${fingerprint}.json`;
  const required = requiredKeysFromBackup(backup);
  if (required) verifyRequiredDeliveries(state, required);
  for (const file of [legacyFile, backup]) {
    try { fs.unlinkSync(file); } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
  fsyncDirectory(path.dirname(legacyFile));
  if (state.migrations?.legacyCodexOutboxImported) {
    delete state.migrations.legacyCodexOutboxImported;
    if (Object.keys(state.migrations).length === 0) delete state.migrations;
    new PrivateStateStore<unknown>(conversationFile).write(state);
    fsyncDirectory(path.dirname(conversationFile));
  }
}

function exactMarkerSet(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const values = new Set(actual);
  return values.size === actual.length && expected.every((value) => values.has(value));
}

function acquireLock(file: string): () => void {
  const lock = `${file}.migration.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lock, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      fs.fsyncSync(descriptor); fs.closeSync(descriptor);
      return () => { try { fs.unlinkSync(lock); } catch { /* already released */ } };
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      let owner = 0;
      try { owner = Number(JSON.parse(fs.readFileSync(lock, 'utf8')).pid); } catch { /* stale */ }
      try { if (owner > 0) process.kill(owner, 0); throw new Error('Codex outbox migration is already running'); }
      catch (probe) {
        if (probe instanceof Error && !('code' in probe && probe.code === 'ESRCH')) throw probe;
        fs.unlinkSync(lock);
      }
    }
  }
  throw new Error('Could not acquire Codex outbox migration lock');
}

export function migrateLegacyCodexOutbox(
  legacyFile: string,
  conversationFile: string,
  now: number = Date.now(),
): { imported: number; fingerprint?: string } {
  if (!fs.existsSync(legacyFile)) {
    if (!fs.existsSync(conversationFile)) return { imported: 0 };
    fsyncDirectory(path.dirname(conversationFile));
    const stateStore = new PrivateStateStore<unknown>(conversationFile);
    const state = parseConversationState(stateStore.readStrict());
    const marker = state.migrations?.legacyCodexOutboxImported;
    if (!marker) return { imported: 0 };
    const backup = `${legacyFile}.imported.${marker.fingerprint}.json`;
    if (fs.existsSync(backup)) verifyBackup(backup, marker.fingerprint);
    finalizeMigration(legacyFile, conversationFile, state, marker.fingerprint);
    return { imported: 0, fingerprint: marker.fingerprint };
  }
  const release = acquireLock(legacyFile);
  try {
    const bytes = fs.readFileSync(legacyFile);
    const fingerprint = crypto.createHash('sha256').update(bytes).digest('hex');
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString('utf8')); } catch {
      throw new Error('Legacy Codex outbox is truncated or invalid JSON');
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)
      && (raw as Record<string, unknown>).migratedToConversationCore === true) {
      const state = parseConversationState(new PrivateStateStore<unknown>(conversationFile).readStrict());
      const marker = state.migrations?.legacyCodexOutboxImported;
      if (!marker || marker.fingerprint !== (raw as Record<string, unknown>).fingerprint) {
        throw new Error('Codex outbox tombstone does not match Conversation migration marker');
      }
      const backup = `${legacyFile}.imported.${marker.fingerprint}.json`;
      if (fs.existsSync(backup)) verifyBackup(backup, marker.fingerprint);
      finalizeMigration(legacyFile, conversationFile, state, marker.fingerprint);
      return { imported: 0, fingerprint: marker.fingerprint };
    }
    const legacy = parseCodexOutboxSnapshot(raw);
    if (!legacy) throw new Error('Unsupported or corrupt legacy Codex outbox schema');
    const store = new PrivateStateStore<unknown>(conversationFile);
    const state = parseConversationState(store.readStrict());
    const existingMarker = state.migrations?.legacyCodexOutboxImported;
    const expectedIds: string[] = [];
    const expectedKeys: string[] = [];
    const byKey = new Map<string, PersistedConversationSubmission>(state.submissions.map((item) => (
      [`${item.agentId}\0${item.sessionId}\0${item.clientRequestId}`, item] as const
    )));
    const receiptsByKey = new Map<string, PersistedConversationDeliveryReceipt>(
      (state.deliveryReceipts ?? []).map((item) => (
        [`${item.agentId}\0${item.sessionId}\0${item.clientRequestId}`, item] as const
      )),
    );
    const queuedByNativeId = new Map<string, PersistedConversationSubmission>();
    let imported = 0;
    for (const queue of legacy.queues) {
      for (const item of queue.items) {
        const id = item.requestId ?? migrationId(queue.threadId, item.id, item.text);
        const key = `codex\0${queue.threadId}\0${id}`;
        expectedIds.push(id);
        expectedKeys.push(key);
        const existing = byKey.get(key);
        if (existing) {
          if (existing.text !== item.text) throw new Error('Legacy Codex queue conflicts with Conversation ledger');
          queuedByNativeId.set(`${queue.pane}\0${queue.threadId}\0${item.id}`, existing);
          continue;
        }
        const revision = ++state.ledgerRevision;
        const submission: PersistedConversationSubmission = {
          agentId: 'codex', sessionId: queue.threadId, clientRequestId: id,
          text: item.text, payloadHash: payloadHash(item.text), state: 'queued', revision,
          queueOrderKey: `${String(Math.floor(item.createdAt)).padStart(16, '0')}:${String(revision).padStart(16, '0')}`,
          lastRunId: queue.pane, createdAt: item.createdAt, updatedAt: item.createdAt,
        };
        state.submissions.push(submission); byKey.set(key, submission);
        queuedByNativeId.set(`${queue.pane}\0${queue.threadId}\0${item.id}`, submission);
        imported += 1;
      }
    }
    for (const receipt of legacy.receipts) {
      const key = `codex\0${receipt.threadId}\0${receipt.requestId}`;
      const existing = byKey.get(key);
      const existingReceipt = receiptsByKey.get(key);
      if (receipt.status === 'queued') {
        const queued = queuedByNativeId.get(`${receipt.pane}\0${receipt.threadId}\0${receipt.queueItemId}`);
        if (!queued || queued.clientRequestId !== receipt.requestId || queued.text !== receipt.text) {
          throw new Error('Legacy Codex queued receipt has no matching queue item');
        }
        continue;
      }
      if (receipt.status === 'pending' || receipt.status === 'accepted') {
        expectedIds.push(receipt.requestId);
        expectedKeys.push(key);
      }
      if (existingReceipt) {
        if (existingReceipt.payloadHash !== payloadHash(receipt.text)) {
          throw new Error('Legacy Codex receipt conflicts with Conversation delivery receipt');
        }
        continue;
      }
      if (existing) {
        if (existing.text !== receipt.text) throw new Error('Legacy Codex receipt conflicts with Conversation ledger');
        if (receipt.status !== 'accepted') continue;
      }
      if (receipt.status === 'accepted') {
        const settled: PersistedConversationDeliveryReceipt = {
          agentId: 'codex', sessionId: receipt.threadId,
          clientRequestId: receipt.requestId,
          payloadHash: existing?.payloadHash ?? payloadHash(receipt.text),
          ...(existing?.baseline === undefined ? {} : { baseline: structuredClone(existing.baseline) }),
          ...(receipt.turnId ?? existing?.nativeId
            ? { nativeId: (receipt.turnId ?? existing?.nativeId)! } : {}),
          ...(existing?.steerActionId === undefined ? {} : { steerActionId: existing.steerActionId }),
          ...(existing?.steerBaseRevision === undefined
            ? {} : { steerBaseRevision: existing.steerBaseRevision }),
          ...(existing?.steerAnchor === undefined
            ? {} : { steerAnchor: structuredClone(existing.steerAnchor) }),
          ...(existing?.steerAttempts === undefined
            ? {} : { steerAttempts: structuredClone(existing.steerAttempts) }),
          acceptedAt: receipt.updatedAt,
          expiresAt: receipt.updatedAt + DELIVERY_RECEIPT_TTL_MS,
        };
        if (existing) {
          state.submissions = state.submissions.filter((candidate) => candidate !== existing);
          byKey.delete(key);
        }
        state.deliveryReceipts ??= [];
        state.deliveryReceipts.push(settled);
        receiptsByKey.set(key, settled);
        imported += 1;
        continue;
      }
      const revision = ++state.ledgerRevision;
      const submission: PersistedConversationSubmission = {
        agentId: 'codex', sessionId: receipt.threadId, clientRequestId: receipt.requestId,
        text: receipt.text, payloadHash: payloadHash(receipt.text),
        state: 'unknown', revision,
        dispatchOrigin: 'direct' as const,
        ...(receipt.turnId ? { nativeId: receipt.turnId } : {}),
        lastRunId: receipt.pane, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt,
      };
      state.submissions.push(submission); byKey.set(key, submission); imported += 1;
    }
    const uniqueIds = [...new Set(expectedIds)].sort();
    const uniqueKeys = [...new Set(expectedKeys)].sort();
    if (existingMarker) {
      if (existingMarker.fingerprint !== fingerprint
        || (existingMarker.submissionKeys
          ? !exactMarkerSet(existingMarker.submissionKeys, uniqueKeys)
          : !exactMarkerSet(existingMarker.submissionIds, uniqueIds))) {
        throw new Error('Legacy Codex outbox migration marker conflicts with its source');
      }
      const needsMarkerUpgrade = !existingMarker.submissionKeys;
      if (needsMarkerUpgrade) existingMarker.submissionKeys = uniqueKeys;
      if (imported > 0 || needsMarkerUpgrade) store.write(state);
    } else {
      state.migrations ??= {};
      state.migrations.legacyCodexOutboxImported = {
        fingerprint, submissionIds: uniqueIds, submissionKeys: uniqueKeys, importedAt: now,
      };
      store.write(state);
    }
    // PrivateStateStore makes the file contents durable before rename. Persist the directory entry too,
    // then re-read the committed ledger before the only recoverable legacy source is moved aside.
    fsyncDirectory(path.dirname(conversationFile));
    const verified = parseConversationState(store.readStrict());
    for (const key of uniqueKeys) {
      const [agentId, sessionId, clientRequestId] = key.split('\0');
      if (!(verified.submissions.some((submission) => submission.agentId === agentId
        && submission.sessionId === sessionId && submission.clientRequestId === clientRequestId)
        || verified.deliveryReceipts?.some((receipt) => receipt.agentId === agentId
          && receipt.sessionId === sessionId && receipt.clientRequestId === clientRequestId))) {
        throw new Error('Conversation migration marker is missing a referenced delivery');
      }
    }
    const backup = `${legacyFile}.imported.${fingerprint}.json`;
    if (!fs.existsSync(backup)) fs.renameSync(legacyFile, backup);
    else {
      verifyBackup(backup, fingerprint);
      if (fs.existsSync(legacyFile)) fs.unlinkSync(legacyFile);
    }
    fsyncDirectory(path.dirname(legacyFile));
    finalizeMigration(legacyFile, conversationFile, verified, fingerprint);
    return { imported, fingerprint };
  } finally { release(); }
}
