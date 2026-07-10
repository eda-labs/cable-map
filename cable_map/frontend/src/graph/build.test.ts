import { describe, expect, it } from 'vitest';
import fixture from '../../dev/fixtures/mixed-sros-topology.json';
import type { Topology } from '../domain/topology/contract';
import { buildGraph } from './build';
import type { SwitchData } from './types';

const topology = fixture as unknown as Topology;

describe('mixed SR OS graph', () => {
  it('places dcgw below the spine and channelises the live pod1 link', () => {
    const graph = buildGraph(topology, { compact: false, tiered: false });
    const pod = graph.nodes.find((node) => node.id === 'pod1')!;
    const spine = graph.nodes.find((node) => node.id === 'mix-spine-srl')!;
    expect(pod.position.y).toBeGreaterThan(spine.position.y);

    const edge = graph.edges.find((item) => item.source === 'pod1' && item.target === 'mix-spine-srl')!;
    expect(edge.sourceHandle).toBe('p1-1_1');
    expect(edge.targetHandle).toBe('p25t');
    expect(edge.data).toMatchObject({ a: '1/1/c1/1', b: '1-25' });

    const data = pod.data as SwitchData;
    expect(data.portLabels?.['1-1']).toBe('c1');
    expect(data.connectors?.['1-1']).toMatchObject({ label: 'c1', channels: 1, physical: '1-a-1' });
    expect(data.ports.find((port) => port.port === '1-1')).toMatchObject({
      channel: 1, interfaceLabel: '1/1/c1/1', physicalAlias: '1-a-1-1', side: 'top',
    });
  });

  it('uses connector capacity for persistent c10 channel data and channel handles', () => {
    const graph = buildGraph(topology, { compact: false, tiered: false });
    const node = graph.nodes.find((item) => item.id === 'mix-sros-sr1-iom-me6')!;
    const data = node.data as SwitchData;
    expect(data.breakouts?.['1-1']).toEqual({ channels: 10, speed: '10g' });
    expect(data.connectors?.['1-1']).toMatchObject({ label: 'c1', channels: 10 });

    const edge = graph.edges.find((item) => item.source === node.id && item.sourceHandle === 'p1-1_1');
    expect(edge).toBeDefined();

    const lag = graph.edges.find((item) => item.id.startsWith('isllag|'))!;
    expect(String(lag.sourceHandle)).toMatch(/_1$/);
    expect(String(lag.targetHandle)).toMatch(/_1t$/);
  });

  it('preserves fixed SR Linux cage mapping and explicit breakouts', () => {
    const graph = buildGraph(topology, { compact: false, tiered: false });
    const srl = graph.nodes.find((item) => item.id === 'mix-spine-srl')!;
    const srlData = srl.data as SwitchData;
    expect(srlData.ports.some((port) => port.port === '25' && port.channel == null)).toBe(true);

    const sr1 = graph.nodes.find((item) => item.id === 'mix-leaf-sr1')!;
    expect((sr1.data as SwitchData).breakouts?.['3']).toEqual({ channels: 4, speed: '100G' });

    const mixedMda = graph.nodes.find((item) => item.id === 'mix-sros-sr1-mda-me12-me6')!;
    expect((mixedMda.data as SwitchData).portLabels).toMatchObject({ '1-1': 'c1', '2-1': '1' });
  });
});
