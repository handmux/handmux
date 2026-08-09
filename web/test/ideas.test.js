import { describe, it, expect } from 'vitest';
import { newIdea, moveItem, parseIdeas } from '../src/ideas.js';

describe('parseIdeas', () => {
  it('drops malformed persisted ideas', () => {
    expect(parseIdeas([{ id: 'a', text: 'keep' }, { id: 7, text: 'drop' }, null]))
      .toEqual([{ id: 'a', text: 'keep' }]);
    expect(parseIdeas({})).toEqual([]);
  });
});

describe('newIdea', () => {
  it('trims and builds an idea with a stable id + text', () => {
    const idea = newIdea('  写测试  ');
    expect(idea).toMatchObject({ text: '写测试' });
    expect(typeof idea.id).toBe('string');
    expect(idea.id.length).toBeGreaterThan(0);
  });
  it('returns null for empty / whitespace-only text', () => {
    expect(newIdea('')).toBeNull();
    expect(newIdea('   ')).toBeNull();
    expect(newIdea(null)).toBeNull();
    expect(newIdea(undefined)).toBeNull();
  });
  it('gives distinct ids to two ideas', () => {
    expect(newIdea('a').id).not.toBe(newIdea('b').id);
  });
});

describe('moveItem', () => {
  const base = ['a', 'b', 'c', 'd'];
  it('moves an item earlier', () => {
    expect(moveItem(base, 2, 0)).toEqual(['c', 'a', 'b', 'd']);
  });
  it('moves an item later', () => {
    expect(moveItem(base, 0, 3)).toEqual(['b', 'c', 'd', 'a']);
  });
  it('returns a copy (no mutation) on a no-op move', () => {
    const out = moveItem(base, 1, 1);
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
  });
  it('returns an unchanged copy when indices are out of range', () => {
    expect(moveItem(base, -1, 2)).toEqual(base);
    expect(moveItem(base, 1, 9)).toEqual(base);
  });
});
