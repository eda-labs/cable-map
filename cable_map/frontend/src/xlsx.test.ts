import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell } from 'write-excel-file/browser';
import type { Topology } from './domain/topology/contract';
import { exportXlsx } from './xlsx';

const mocks = vi.hoisted(() => ({
  toFile: vi.fn(),
  writeXlsxFile: vi.fn(),
}));

vi.mock('write-excel-file/browser', () => ({ default: mocks.writeXlsxFile }));

describe('exportXlsx', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T14:35:22.000Z'));
    mocks.toFile.mockReset().mockResolvedValue(undefined);
    mocks.writeXlsxFile.mockReset().mockResolvedValue({ toFile: mocks.toFile });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('includes member operational state and a UTC timestamp in the filename', async () => {
    const topo: Topology = {
      nodes: [{
        name: 'leaf1',
        platform: '7220 IXR-D3L',
        os: 'srl',
        role: 'leaf',
        table: [{
          label: 'ethernet-1-1',
          desc: 'uplink',
          remoteNode: 'spine1',
          remotePort: 'ethernet-1-1',
          type: 'interSwitch',
          operationalState: 'Down',
          lldpStatus: 'ok',
          lldpPeer: 'spine1 ethernet-1-1',
        }],
      }],
      links: [],
      lags: {},
      labels: {},
    };

    await exportXlsx(topo, ['leaf1']);

    const sheets = mocks.writeXlsxFile.mock.calls[0]?.[0] as Array<{ data: Cell[][] }>;
    const header = sheets[0]?.data[0] as Array<{ value: string }>;
    expect(header.map((cell) => cell.value)).toEqual([
      'Port', 'Type', 'LAG', 'Remote node', 'Remote port', 'Description',
      'Operational state', 'LLDP neighbor', 'LLDP',
    ]);
    expect(sheets[0]?.data[1]?.[6]).toBe('Down');
    expect(mocks.toFile).toHaveBeenCalledWith('cable-map_2026-07-28_14-35-22Z.xlsx');
  });
});
