import { useCallback, useMemo, useState } from 'react';
import type { CustomHopBytes, TraceDraftHop } from '../utils/traceUtils';
import { moveHop, nextDraftHopId, normalizeCustomHopHex } from '../utils/traceUtils';

export interface UseTraceBuilderResult {
  draftHops: TraceDraftHop[];
  effectiveHopHashBytes: CustomHopBytes;
  customHopBytesLocked: CustomHopBytes | null;
  addRepeater: (publicKey: string) => void;
  addCustomHop: (hopHex: string, hopBytes: CustomHopBytes) => void;
  removeHop: (id: string) => void;
  moveHopAt: (index: number, dir: -1 | 1) => void;
  setHops: (hops: TraceDraftHop[]) => void;
  clearHops: () => void;
}

export function useTraceBuilder(): UseTraceBuilderResult {
  const [draftHops, setDraftHops] = useState<TraceDraftHop[]>([]);

  const customHopBytesLocked = useMemo(
    () => draftHops.find((hop) => hop.kind === 'custom')?.hopBytes ?? null,
    [draftHops]
  );

  const effectiveHopHashBytes: CustomHopBytes = customHopBytesLocked ?? 4;

  const addRepeater = useCallback((publicKey: string) => {
    setDraftHops((current) => [
      ...current,
      {
        id: nextDraftHopId('repeater', current.length),
        kind: 'repeater',
        publicKey,
      },
    ]);
  }, []);

  const addCustomHop = useCallback((hopHex: string, hopBytes: CustomHopBytes) => {
    const normalized = normalizeCustomHopHex(hopHex);
    setDraftHops((current) => [
      ...current,
      {
        id: nextDraftHopId('custom', current.length),
        kind: 'custom',
        hopHex: normalized,
        hopBytes,
      },
    ]);
  }, []);

  const removeHop = useCallback((id: string) => {
    setDraftHops((current) => current.filter((hop) => hop.id !== id));
  }, []);

  const moveHopAt = useCallback((index: number, dir: -1 | 1) => {
    setDraftHops((current) => moveHop(current, index, dir));
  }, []);

  const setHops = useCallback((hops: TraceDraftHop[]) => {
    setDraftHops(hops);
  }, []);

  const clearHops = useCallback(() => {
    setDraftHops([]);
  }, []);

  return {
    draftHops,
    effectiveHopHashBytes,
    customHopBytesLocked,
    addRepeater,
    addCustomHop,
    removeHop,
    moveHopAt,
    setHops,
    clearHops,
  };
}
