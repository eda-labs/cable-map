import { describe, expect, it } from 'vitest';
import { breakoutCellBox, breakoutGrid } from './geometry';

describe('breakout geometry', () => {
  it('lays a ten-channel cage out as two contiguous rows of five', () => {
    expect(breakoutGrid(10)).toEqual({ cols: 5, rows: 2 });
    expect(breakoutCellBox(10, 1, 100, 40)).toEqual({ left: 0, top: 0, width: 20, height: 20 });
    expect(breakoutCellBox(10, 5, 100, 40)).toEqual({ left: 80, top: 0, width: 20, height: 20 });
    expect(breakoutCellBox(10, 6, 100, 40)).toEqual({ left: 0, top: 20, width: 20, height: 20 });
    expect(breakoutCellBox(10, 10, 100, 40)).toEqual({ left: 80, top: 20, width: 20, height: 20 });
  });
});
