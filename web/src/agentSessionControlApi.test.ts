import { describe, expect, it } from 'vitest';
import { parseAgentModelControl } from './agentSessionControlApi.js';

const snapshot = () => ({
  canUpdate: true,
  models: [{
    id: 'model-a', label: 'Model A', defaultEffort: 'medium',
    efforts: [{ id: 'low' }, { id: 'medium' }],
    serviceTiers: [{ id: 'fast' }],
  }],
  selected: { model: 'model-a', effort: 'medium', serviceTier: 'fast' },
});

describe('parseAgentModelControl', () => {
  it('accepts one bounded internally consistent snapshot', () => {
    expect(parseAgentModelControl(snapshot())).toMatchObject(snapshot());
  });

  it('fails closed for duplicate identities and foreign defaults', () => {
    const duplicateModels = snapshot();
    duplicateModels.models.push(structuredClone(duplicateModels.models[0]!));
    expect(parseAgentModelControl(duplicateModels)).toBeNull();

    const duplicateEfforts = snapshot();
    duplicateEfforts.models[0]!.efforts.push({ id: 'low' });
    expect(parseAgentModelControl(duplicateEfforts)).toBeNull();

    const duplicateTiers = snapshot();
    duplicateTiers.models[0]!.serviceTiers.push({ id: 'fast' });
    expect(parseAgentModelControl(duplicateTiers)).toBeNull();

    const foreignDefault = snapshot();
    foreignDefault.models[0]!.defaultEffort = 'high';
    expect(parseAgentModelControl(foreignDefault)).toBeNull();
  });

  it('bounds collection counts and text fields', () => {
    const tooManyModels = snapshot();
    tooManyModels.models = Array.from({ length: 257 }, (_, index) => ({
      ...structuredClone(tooManyModels.models[0]!), id: `model-${index}`,
    }));
    expect(parseAgentModelControl(tooManyModels)).toBeNull();

    const tooManyEfforts = snapshot();
    tooManyEfforts.models[0]!.efforts = Array.from({ length: 33 }, (_, index) => ({
      id: `effort-${index}`,
    }));
    expect(parseAgentModelControl(tooManyEfforts)).toBeNull();

    const oversized = snapshot();
    oversized.models[0]!.label = 'x'.repeat(257);
    expect(parseAgentModelControl(oversized)).toBeNull();
  });
});
