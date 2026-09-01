import { describe, expect, it } from 'vitest';
import { MINIMUM_NODE_VERSION, nodeVersionSupport } from '../bin/node-version.js';

describe('stable Node launcher gate', () => {
  it('requires the first Node release with the supported sqlite baseline', () => {
    expect(MINIMUM_NODE_VERSION).toBe('22.16.0');
    expect(nodeVersionSupport('20.19.5').ok).toBe(false);
    expect(nodeVersionSupport('22.12.0').ok).toBe(false);
    expect(nodeVersionSupport('22.12.99').ok).toBe(false);
    expect(nodeVersionSupport('22.13.0').ok).toBe(false);
    expect(nodeVersionSupport('22.15.99').ok).toBe(false);
    expect(nodeVersionSupport('22.16.0').ok).toBe(true);
    expect(nodeVersionSupport('24.0.0').ok).toBe(true);
    expect(nodeVersionSupport('invalid').ok).toBe(false);
  });
});
