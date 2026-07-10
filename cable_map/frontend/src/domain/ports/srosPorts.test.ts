import { describe, expect, it } from 'vitest';
import type { Node } from '../topology/contract';
import { mergeBreakouts, srosPortModel } from './srosPorts';

const node = (components: unknown[]): Node => ({
  name: 'sr1', platform: '7750 SR-1', os: 'sros', role: 'leaf', table: [],
  raw: { spec: { component: components } },
});

describe('SR OS connector inventory', () => {
  it('derives c1 and c10 capacity and ignores malformed connector types', () => {
    const model = srosPortModel(node([
      { kind: 'connector', slot: '1-a-1', type: 'c10-10g' },
      { kind: 'connector', slot: '1-a-2', type: 'c1-100g' },
      { kind: 'connector', slot: '1-a-3', type: 'invalid' },
    ]), '7750 SR-1 me6-100gb-qsfp28_blank');

    expect(model.connectors['1-1']).toMatchObject({ label: 'c1', channels: 10, speed: '10g', physical: '1-a-1' });
    expect(model.breakouts['1-1']).toEqual({ channels: 10, speed: '10g' });
    expect(model.connectors['1-2']).toMatchObject({ label: 'c2', channels: 1, speed: '100g' });
    expect(model.breakouts['1-2']).toBeUndefined();
    expect(model.connectors['1-3']).toBeUndefined();
  });

  it('maps an SR-2 second-XCM second-bay connector to panel slot four', () => {
    const model = srosPortModel({ ...node([
      { kind: 'connector', slot: '2-b-7', type: 'c4-100g' },
    ]), platform: '7750 SR-2s' }, '7750 SR-2s ms16-100gb-sfpdd-4-100gb-qsfp28_ms8-100gb-sfpdd-2-100gb-qsfp28');
    expect(model.connectors['4-7']).toMatchObject({ label: 'c7', channels: 4 });
  });

  it('does not derive connector capacity for SR Linux nodes', () => {
    const model = srosPortModel({ ...node([{ kind: 'connector', slot: '1-a-1', type: 'c10-10g' }]), os: 'srl' }, '7750 SR-1 me6-100gb-qsfp28_blank');
    expect(model).toEqual({ connectors: {}, breakouts: {} });
  });

  it('lets SR OS connector capacity override explicit or inferred data for the same cage', () => {
    expect(mergeBreakouts(
      { '1-1': { channels: 4, speed: '25G' }, '1-2': { channels: 2, speed: '50G' } },
      { '1-1': { channels: 10, speed: '10g' } },
      { '1-1': { channels: 3, speed: '' } },
    )).toEqual({
      '1-1': { channels: 10, speed: '10g' },
      '1-2': { channels: 2, speed: '50G' },
    });
  });
});
