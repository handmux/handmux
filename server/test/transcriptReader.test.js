import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTranscriptReader } from '../src/transcriptReader.js';

const line = (o) => JSON.stringify(o) + '\n';
const user = (text) => line({ type: 'user', message: { role: 'user', content: text } });

describe('transcriptReader', () => {
  it('parses appended complete lines without losing cross-batch tool results', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handmux-transcript-'));
    const file = path.join(dir, 'session.jsonl');
    const reader = createTranscriptReader();
    try {
      await fs.writeFile(file, line({ type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a' } },
      ] } }));
      const first = await reader.read(file);
      expect(first[0].tool.result).toBeNull();

      await fs.appendFile(file, line({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      ] } }));
      const second = await reader.read(file);
      expect(second).toBe(first);
      expect(second[0].tool.result).toBe('ok');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('waits for a complete JSONL line and resets on truncate/rewrite', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handmux-transcript-'));
    const file = path.join(dir, 'session.jsonl');
    const reader = createTranscriptReader();
    try {
      await fs.writeFile(file, user('one') + user('partial').slice(0, -1));
      expect((await reader.read(file)).map((m) => m.text)).toEqual(['one']);
      await fs.appendFile(file, '\n');
      expect((await reader.read(file)).map((m) => m.text)).toEqual(['one', 'partial']);

      await fs.writeFile(file, user('new'));
      expect((await reader.read(file)).map((m) => m.text)).toEqual(['new']);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('bounds cached sessions with an LRU', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handmux-transcript-'));
    const reader = createTranscriptReader({ maxEntries: 2 });
    try {
      for (let i = 0; i < 3; i++) {
        const file = path.join(dir, `${i}.jsonl`);
        await fs.writeFile(file, user(String(i)));
        await reader.read(file);
      }
      expect(reader.size()).toBe(2);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('uses the parser selected for the transcript agent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handmux-transcript-'));
    const file = path.join(dir, 'rollout.jsonl');
    const reader = createTranscriptReader();
    const createSelectedParser = () => ({
      messages: [],
      push(lines) {
        this.messages.push(...lines.map((text) => ({ text: JSON.parse(text).selected })));
        return this.messages;
      },
    });
    try {
      await fs.writeFile(file, line({ selected: 'custom' }));
      expect((await reader.read(file, createSelectedParser)).map((m) => m.text)).toEqual(['custom']);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
