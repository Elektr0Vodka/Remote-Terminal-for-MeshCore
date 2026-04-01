// Shared types and pure utility functions for trace-related features.
// Extracted from TracePane.tsx so they can be reused in MapView trace mode and hooks.

export type CustomHopBytes = 1 | 2 | 4;

export type TraceDraftHop =
  | { id: string; kind: 'repeater'; publicKey: string }
  | { id: string; kind: 'custom'; hopHex: string; hopBytes: CustomHopBytes };

export interface TraceHistoryEntry {
  id: string;
  timestamp: number;
  label: string;
  draftHops: TraceDraftHop[];
  result: import('../types').RadioTraceResponse;
  hopHashBytes: CustomHopBytes;
}

export function getHeardTimestamp(contact: import('../types').Contact): number {
  return Math.max(contact.last_seen ?? 0, contact.last_advert ?? 0);
}

export function formatSNR(snr: number | null | undefined): string {
  if (typeof snr !== 'number' || Number.isNaN(snr)) {
    return '—';
  }
  return `${snr >= 0 ? '+' : ''}${snr.toFixed(1)} dB`;
}

export function moveHop(hops: TraceDraftHop[], index: number, direction: -1 | 1): TraceDraftHop[] {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= hops.length) {
    return hops;
  }
  const next = [...hops];
  const [item] = next.splice(index, 1);
  next.splice(nextIndex, 0, item);
  return next;
}

export function normalizeCustomHopHex(value: string): string {
  return value.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

export function nextDraftHopId(prefix: string, currentLength: number): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${currentLength}`;
}
