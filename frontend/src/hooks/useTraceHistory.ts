import { useCallback, useState } from 'react';
import type { TraceHistoryEntry, TraceDraftHop, CustomHopBytes } from '../utils/traceUtils';
import type { RadioTraceResponse } from '../types';

export type { TraceHistoryEntry };

const STORAGE_KEY = 'mesh_trace_history';
const MAX_ENTRIES = 20;

function loadFromStorage(): TraceHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as TraceHistoryEntry[];
  } catch {
    return [];
  }
}

function saveToStorage(entries: TraceHistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* ignore storage errors */
  }
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function generateLabel(draftHops: TraceDraftHop[]): string {
  const count = draftHops.length;
  return `${count} hop${count === 1 ? '' : 's'}`;
}

export interface AddEntryParams {
  draftHops: TraceDraftHop[];
  result: RadioTraceResponse;
  hopHashBytes: CustomHopBytes;
  label?: string;
}

export interface UseTraceHistoryResult {
  entries: TraceHistoryEntry[];
  addEntry: (params: AddEntryParams) => void;
  removeEntry: (id: string) => void;
  clearAll: () => void;
}

export function useTraceHistory(): UseTraceHistoryResult {
  const [entries, setEntries] = useState<TraceHistoryEntry[]>(loadFromStorage);

  const addEntry = useCallback((params: AddEntryParams) => {
    const { draftHops, result, hopHashBytes, label } = params;
    const newEntry: TraceHistoryEntry = {
      id: generateId(),
      timestamp: Date.now(),
      label: label ?? generateLabel(draftHops),
      draftHops,
      result,
      hopHashBytes,
    };
    setEntries((current) => {
      const next = [newEntry, ...current].slice(0, MAX_ENTRIES);
      saveToStorage(next);
      return next;
    });
  }, []);

  const removeEntry = useCallback((id: string) => {
    setEntries((current) => {
      const next = current.filter((e) => e.id !== id);
      saveToStorage(next);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setEntries([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore storage errors */
    }
  }, []);

  return { entries, addEntry, removeEntry, clearAll };
}
