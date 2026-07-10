import { describe, expect, it } from 'vitest';
import { portLabelsOf } from './frontPanelMeta';

describe('front-panel cage labels', () => {
  it('uses the SR OS stencil silkscreen instead of internal slotted cage keys', () => {
    expect(portLabelsOf('7750 SR-1s s18-100gb-qsfp28')['1-1']).toBe('c1');
    expect(portLabelsOf('7750 SR-1-48D')['1']).toBe('c1');
  });

  it('supports different label conventions in separate modular bays', () => {
    const labels = portLabelsOf('7750 SR-1 me12-100gb-qsfp28_me6-100gb-qsfp28');
    expect(labels['1-1']).toBe('c1');
    expect(labels['2-1']).toBe('1');
  });

  it('keeps numeric SR Linux labels when no generated SR OS label style exists', () => {
    expect(portLabelsOf('7220 IXR-H4')['1']).toBe('1');
  });
});
