import { startTransition, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { getViewportForBounds, type Node as RFNode, type ReactFlowInstance, type Viewport } from '@xyflow/react';
import {
  LARGE_DEFAULT_VIEWPORT, LARGE_MAX_ZOOM, LARGE_MIN_ZOOM, nodeCenter, nodesBounds, type CenterNodeOptions, type FitNodesOptions,
} from '../lib/viewport';

const VIEWPORT_IDLE_COMMIT_MS = 90;
const VIEWPORT_MAX_STALE_MS = 520;

// Single owner of the large-topology viewport. `fitNodes` animates to a node set and writes the
// resulting viewport back into `largeViewport`, which feeds culling + the WebGL decision flags.
// Both the label-filter and search fit effects route through this one instance.
export function useViewportController(
  flow: ReactFlowInstance | null,
  largeTopology: boolean,
  flowHostRef: RefObject<HTMLDivElement | null>,
  namespace: string,
) {
  const [largeViewport, setLargeViewportState] = useState<Viewport>(LARGE_DEFAULT_VIEWPORT);
  const viewportRef = useRef<Viewport>(LARGE_DEFAULT_VIEWPORT);
  const timerRef = useRef<number | null>(null);
  const maxTimerRef = useRef<number | null>(null);

  const commitLargeViewport = useCallback((viewport: Viewport) => {
    viewportRef.current = viewport;
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (maxTimerRef.current != null) {
      window.clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    startTransition(() => setLargeViewportState(viewport));
  }, []);

  const scheduleLargeViewportCommit = useCallback((delay: number) => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      commitLargeViewport(viewportRef.current);
    }, delay);
  }, [commitLargeViewport]);

  const setLargeViewport = useCallback((viewport: Viewport) => {
    viewportRef.current = viewport;
    if (maxTimerRef.current == null) {
      maxTimerRef.current = window.setTimeout(() => {
        maxTimerRef.current = null;
        if (timerRef.current != null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        commitLargeViewport(viewportRef.current);
      }, VIEWPORT_MAX_STALE_MS);
    }
    scheduleLargeViewportCommit(VIEWPORT_IDLE_COMMIT_MS);
  }, [commitLargeViewport, scheduleLargeViewportCommit]);

  const settleLargeViewport = useCallback((viewport: Viewport) => {
    viewportRef.current = viewport;
    scheduleLargeViewportCommit(VIEWPORT_IDLE_COMMIT_MS);
  }, [scheduleLargeViewportCommit]);

  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    if (maxTimerRef.current != null) window.clearTimeout(maxTimerRef.current);
  }, []);

  useEffect(() => {
    if (largeTopology) commitLargeViewport(LARGE_DEFAULT_VIEWPORT);
  }, [commitLargeViewport, largeTopology, namespace]);

  useEffect(() => {
    if (!largeTopology) return;
    const onBlur = () => {
      if (timerRef.current == null && maxTimerRef.current == null) return;
      commitLargeViewport(viewportRef.current);
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [commitLargeViewport, largeTopology]);

  const fitNodes = useCallback((targetNodes: RFNode[], options: FitNodesOptions) => {
    if (!flow || targetNodes.length === 0) return;
    if (!largeTopology) {
      void flow.fitView({ nodes: targetNodes, ...options });
      return;
    }

    const bounds = nodesBounds(targetNodes);
    const rect = flowHostRef.current?.getBoundingClientRect();
    if (!bounds || !rect?.width || !rect.height) return;

    const viewport = getViewportForBounds(
      bounds,
      rect.width,
      rect.height,
      LARGE_MIN_ZOOM,
      options.maxZoom ?? LARGE_MAX_ZOOM,
      options.padding,
    );
    void flow.setViewport(viewport, { duration: options.duration }).then((ok) => {
      if (ok) commitLargeViewport(flow.getViewport());
    });
  }, [commitLargeViewport, flow, largeTopology, flowHostRef]);

  const centerNode = useCallback((node: RFNode, options: CenterNodeOptions): Promise<boolean> => {
    if (!flow) return Promise.resolve(false);
    const center = nodeCenter(node);
    const currentZoom = flow.getViewport().zoom;
    const zoom = options.zoom ?? Math.max(currentZoom, options.minZoom ?? currentZoom);
    if (options.bottomInset) {
      const rect = flowHostRef.current?.getBoundingClientRect();
      if (rect?.width && rect.height) {
        const bottomInset = Math.max(0, Math.min(options.bottomInset, rect.height - 1));
        const visibleHeight = rect.height - bottomInset;
        const viewport: Viewport = {
          x: rect.width / 2 - center.x * zoom,
          y: visibleHeight / 2 - center.y * zoom,
          zoom,
        };
        return flow.setViewport(viewport, { duration: options.duration }).then((ok) => {
          if (ok && largeTopology) commitLargeViewport(flow.getViewport());
          return ok;
        });
      }
    }
    return flow.setCenter(center.x, center.y, { zoom, duration: options.duration }).then((ok) => {
      if (ok && largeTopology) commitLargeViewport(flow.getViewport());
      return ok;
    });
  }, [commitLargeViewport, flow, flowHostRef, largeTopology]);

  return { fitNodes, centerNode, largeViewport, setLargeViewport, commitLargeViewport, settleLargeViewport };
}
