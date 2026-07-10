import { describe, expect, it } from 'vitest';
import {
  breakoutChannel,
  cageKey,
  detailedPortLabel,
  edaPhysicalAlias,
  parsePortAddress,
} from './interfaceNames';

describe('SR OS interface names', () => {
  it('parses native and EDA physical forms without confusing SR Linux names', () => {
    expect(parsePortAddress('1/2/c3/4')).toMatchObject({
      kind: 'sros-native', slot: 1, mda: 2, connector: 3, channel: 4,
    });
    expect(parsePortAddress('ethernet-1-b-3-4')).toMatchObject({
      kind: 'eda-physical', slot: 1, mda: 2, connector: 3, channel: 4,
    });
    expect(parsePortAddress('ethernet-1-25')).toMatchObject({ kind: 'ethernet', slot: 1, port: 25 });
  });

  it('keeps native SR OS first while exposing the EDA physical alias', () => {
    expect(edaPhysicalAlias('1/1/c1/1')).toBe('1-a-1-1');
    expect(detailedPortLabel('1/1/c1/1')).toBe('1/1/c1/1 (1-a-1-1)');
    expect(detailedPortLabel('ethernet-1-25')).toBe('ethernet-1-25');
  });

  it('maps fixed, two-bay, and four-bay chassis to their stencil cages', () => {
    expect(cageKey('1/1/c3/4', false, '7750 SR-1-48D')).toBe('3');
    expect(cageKey('1/2/c3/4', true, '7750 SR-1 me12-100gb-qsfp28_me6-100gb-qsfp28')).toBe('2-3');
    expect(cageKey('2/2/c3/4', true, '7750 SR-2s ms16_ms8')).toBe('4-3');
    expect(cageKey('ethernet-1-25', false, '7220 IXR-H4')).toBe('25');
    expect(cageKey('ethernet-1-25', true, 'modular')).toBe('1-25');
  });

  it('extracts breakout channels from both vendors without treating the cage as a channel', () => {
    expect(breakoutChannel('1/1/c3/4')).toBe(4);
    expect(breakoutChannel('ethernet-1-8-4')).toBe(4);
    expect(breakoutChannel('ethernet-1-25')).toBeNull();
  });
});
