/**
 * KmsView.tsx — MC-KMS key generation + key vault
 *
 * Tabs: Generate | Vault
 * Generate: vanity prefix, key count, device metadata prefill, CPU/GPU mode, generate button
 * Vault: embedded KeyVaultView (full key management)
 */

import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Cpu,
  Database,
  Download,
  Eye,
  EyeOff,
  Flame,
  KeyRound,
  Loader2,
  RefreshCw,
  Square,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { cn } from '@/lib/utils';
import type { KeygenWorkerResult } from '../workers/keygenWorker';
import type { GPUKeyGenerator } from '../workers/gpu/gpuKeygen';
import { KeyVaultView } from './KeyVaultView';

// ─── Types ────────────────────────────────────────────────────────────────────

interface GeneratedKey {
  publicKey: string;
  privateKey: string;
  attempts: number;
}

interface TargetState {
  prefix: string;
  label: string;
  status: 'waiting' | 'searching' | 'found';
  result?: GeneratedKey;
  kps: number;
  attempts: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatKps(kps: number): string {
  if (kps >= 1_000_000) return `${(kps / 1_000_000).toFixed(1)}M`;
  if (kps >= 1_000) return `${(kps / 1_000).toFixed(1)}k`;
  return String(kps);
}

function expectedAttempts(len: number): string {
  if (len === 0) return '1';
  const n = Math.pow(16, len);
  if (n >= 1_000_000_000) return `~${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `~${(n / 1_000).toFixed(0)}k`;
  return `~${n}`;
}

function formatAttempts(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} trillion`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} billion`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} million`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} thousand`;
  return Math.round(n).toLocaleString();
}

function formatEta(seconds: number): string {
  if (seconds >= 31_536_000) return `${(seconds / 31_536_000).toFixed(1)} years`;
  if (seconds >= 2_592_000) return `${(seconds / 2_592_000).toFixed(1)} months`;
  if (seconds >= 86_400) return `${(seconds / 86_400).toFixed(1)} days`;
  if (seconds >= 3_600) return `${(seconds / 3_600).toFixed(1)} hours`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)} minutes`;
  return `${Math.round(seconds)} seconds`;
}

interface DifficultyTier {
  label: string;
  className: string;
}

function getDifficultyTier(n: number): DifficultyTier {
  if (n <= 1_000) return { label: 'Very Easy', className: 'text-emerald-500' };
  if (n <= 100_000) return { label: 'Easy', className: 'text-green-500' };
  if (n <= 10_000_000) return { label: 'Moderate', className: 'text-yellow-500' };
  if (n <= 1_000_000_000) return { label: 'Hard', className: 'text-orange-500' };
  if (n <= 100_000_000_000) return { label: 'Very Hard', className: 'text-red-500' };
  return { label: 'Extreme', className: 'text-purple-500' };
}

function downloadBatch(
  keys: Array<{ pub: string; priv: string; label?: string }>,
  filename: string
) {
  const data =
    keys.length === 1
      ? { public_key: keys[0].pub, private_key: keys[0].priv }
      : keys.map((k) => ({ label: k.label, public_key: k.pub, private_key: k.priv }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function buildTargets(prefix: string, count: number): TargetState[] {
  if (count <= 1) {
    return [{ prefix, label: prefix || '(any)', status: 'waiting', kps: 0, attempts: 0 }];
  }
  return Array.from({ length: count }, (_, i) => {
    const p = prefix + String(i + 1);
    return { prefix: p, label: p, status: 'waiting' as const, kps: 0, attempts: 0 };
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function KeyDisplay({
  pub,
  priv,
  showPriv,
  onTogglePriv,
  onCopy,
}: {
  pub: string;
  priv: string;
  showPriv: boolean;
  onTogglePriv: () => void;
  onCopy: (text: string, label: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground uppercase tracking-wide">Public Key</label>
        <div className="flex items-center gap-2">
          <span className="flex-1 font-mono text-xs bg-muted/40 rounded px-2 py-1.5 break-all select-all">
            {pub}
          </span>
          <button
            onClick={() => onCopy(pub, 'Public key')}
            className="p-1.5 rounded hover:bg-accent/50 transition text-muted-foreground hover:text-foreground flex-shrink-0"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground uppercase tracking-wide">
            Private Key
          </label>
          <button
            onClick={onTogglePriv}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition"
          >
            {showPriv ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {showPriv ? 'Hide' : 'Show'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex-1 font-mono text-xs bg-muted/40 rounded px-2 py-1.5 break-all select-all">
            {showPriv ? priv : '•'.repeat(32) + '…'}
          </span>
          <button
            onClick={() => onCopy(priv, 'Private key')}
            className="p-1.5 rounded hover:bg-accent/50 transition text-muted-foreground hover:text-foreground flex-shrink-0"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function SingleKeyResult({
  target,
  showPriv,
  onTogglePriv,
  onCopy,
  onDownload,
  onSave,
  saving,
}: {
  target: TargetState;
  showPriv: boolean;
  onTogglePriv: () => void;
  onCopy: (text: string, label: string) => void;
  onDownload: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  if (target.status === 'searching') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Searching… {target.attempts.toLocaleString()} tried
      </div>
    );
  }
  if (target.status !== 'found' || !target.result) return null;

  const { result } = target;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-success text-sm font-semibold">
        <CheckCircle2 className="h-4 w-4" />
        Key found
        <span className="ml-auto text-xs text-muted-foreground font-normal">
          {result.attempts > 1 ? `after ${result.attempts.toLocaleString()} attempts` : 'instant'}
        </span>
      </div>
      <KeyDisplay
        pub={result.publicKey}
        priv={result.privateKey}
        showPriv={showPriv}
        onTogglePriv={onTogglePriv}
        onCopy={onCopy}
      />
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={onDownload}
          className="flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 transition"
        >
          <Download className="h-3.5 w-3.5" />
          Download JSON
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition disabled:opacity-60"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Database className="h-3.5 w-3.5" />
          )}
          Save to Vault
        </button>
      </div>
    </div>
  );
}

function MultiKeyRow({
  target,
  showPriv,
  onTogglePriv,
  onCopy,
  onDownload,
}: {
  target: TargetState;
  showPriv: boolean;
  onTogglePriv: () => void;
  onCopy: (text: string, label: string) => void;
  onDownload: () => void;
}) {
  const isFound = target.status === 'found' && !!target.result;
  return (
    <div
      className={cn(
        'rounded border p-3 space-y-2',
        isFound ? 'border-success/40 bg-success/5' : 'border-border'
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        {isFound ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-success flex-shrink-0" />
        ) : target.status === 'searching' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary flex-shrink-0" />
        ) : (
          <div className="h-3.5 w-3.5 rounded-full border border-border flex-shrink-0" />
        )}

        <span className="font-mono text-xs font-semibold text-muted-foreground flex-shrink-0">
          {target.label || '(any)'}…
        </span>

        {target.status === 'searching' && target.kps > 0 && (
          <span className="text-[11px] text-muted-foreground ml-auto flex-shrink-0">
            {formatKps(target.kps)}/s · {target.attempts.toLocaleString()} tried
          </span>
        )}

        {isFound && target.result && (
          <>
            <span className="font-mono text-xs text-muted-foreground truncate flex-1 min-w-0 ml-1">
              {target.result.publicKey.slice(0, 20)}…
            </span>
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <button
                onClick={onDownload}
                title="Download JSON"
                className="p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition"
              >
                <Download className="h-3 w-3" />
              </button>
              <button
                onClick={onTogglePriv}
                title={showPriv ? 'Hide keys' : 'Show keys'}
                className="p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition"
              >
                {showPriv ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </button>
              <button
                onClick={() => onCopy(target.result!.publicKey, 'Public key')}
                title="Copy public key"
                className="p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
          </>
        )}
      </div>

      {isFound && showPriv && target.result && (
        <div className="pl-5">
          <KeyDisplay
            pub={target.result.publicKey}
            priv={target.result.privateKey}
            showPriv={showPriv}
            onTogglePriv={onTogglePriv}
            onCopy={onCopy}
          />
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function KmsView() {
  const [tab, setTab] = useState<'generate' | 'vault'>('generate');

  // ── Config ────────────────────────────────────────────────────────────────
  const [prefix, setPrefix] = useState('');
  const [keyCount, setKeyCount] = useState(1);
  const [useParallel, setUseParallel] = useState(false);
  const [gpuAvailable, setGpuAvailable] = useState<boolean | null>(null);
  const [turboMode, setTurboMode] = useState(false);

  // ── Runtime ───────────────────────────────────────────────────────────────
  const [running, setRunning] = useState(false);
  const [targets, setTargets] = useState<TargetState[]>([]);

  // ── Metadata prefill ──────────────────────────────────────────────────────
  const [deviceName, setDeviceName] = useState('');
  const [deviceRole, setDeviceRole] = useState('');
  const [model, setModel] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [placementDate, setPlacementDate] = useState('');
  const [savingAll, setSavingAll] = useState(false);
  const [showPriv, setShowPriv] = useState<Record<string, boolean>>({});

  // ── Refs (stable across renders for worker callbacks) ─────────────────────
  const workersRef = useRef<Map<number, Worker>>(new Map());
  const targetsRef = useRef<TargetState[]>([]);
  const useParallelRef = useRef(false);
  // Mutable ref to spawn function — avoids stale closures in worker callbacks
  const spawnRef = useRef<(idx: number) => void>(() => {});
  // GPU refs
  const gpuGenRef = useRef<GPUKeyGenerator | null>(null);
  const gpuRunningRef = useRef(false);
  const turboModeRef = useRef(false);
  // Per-worker KPS tracking for parallel CPU mode (key = targetIdx * 1000 + workerSubIdx)
  const workerKpsRef = useRef<Map<number, number>>(new Map());
  const spawnParallelForTargetRef = useRef<(idx: number) => void>(() => {});

  // Keep turboModeRef in sync and propagate to a live GPU generator
  useEffect(() => {
    turboModeRef.current = turboMode;
    if (gpuGenRef.current) {
      gpuGenRef.current.turboMode = turboMode;
      // Normal: 100ms target (short bursts, ~60% GPU duty cycle — matches cracker standard mode)
      // Turbo:  1000ms target (sustained load — matches cracker's standard target for fast GPUs)
      gpuGenRef.current.dispatchTargetMs = turboMode ? 1000 : 100;
      gpuGenRef.current.resetBatchTuning();
    }
  }, [turboMode]);

  // GPU detection
  useEffect(() => {
    const nav = navigator as typeof navigator & {
      gpu?: { requestAdapter: () => Promise<unknown> };
    };
    if (nav.gpu) {
      nav.gpu.requestAdapter().then(
        (a) => setGpuAvailable(a !== null),
        () => setGpuAvailable(false)
      );
    } else {
      setGpuAvailable(false);
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      workersRef.current.forEach((w) => w.terminate());
      gpuRunningRef.current = false;
      gpuGenRef.current?.destroy();
    };
  }, []);

  // Assign spawnRef every render so worker callbacks always see current state
  spawnRef.current = (idx: number) => {
    const allTargets = targetsRef.current;
    if (idx >= allTargets.length) return;

    const worker = new Worker(new URL('../workers/keygenWorker.ts', import.meta.url), {
      type: 'module',
    });
    workersRef.current.set(idx, worker);

    worker.onmessage = (e: MessageEvent<KeygenWorkerResult>) => {
      const msg = e.data;

      if (msg.type === 'progress') {
        targetsRef.current = targetsRef.current.map((t, i) =>
          i === idx ? { ...t, kps: msg.keysPerSecond, attempts: msg.attempts } : t
        );
        setTargets([...targetsRef.current]);
      } else if (msg.type === 'found') {
        const result: GeneratedKey = {
          publicKey: msg.publicKey,
          privateKey: msg.privateKey,
          attempts: msg.attempts,
        };
        targetsRef.current = targetsRef.current.map((t, i) =>
          i === idx ? { ...t, status: 'found', result, kps: 0 } : t
        );
        setTargets([...targetsRef.current]);
        worker.terminate();
        workersRef.current.delete(idx);

        if (!useParallelRef.current) {
          // Sequential: start next target
          const nextIdx = idx + 1;
          if (nextIdx < targetsRef.current.length) {
            targetsRef.current = targetsRef.current.map((t, i) =>
              i === nextIdx ? { ...t, status: 'searching' } : t
            );
            setTargets([...targetsRef.current]);
            spawnRef.current(nextIdx);
          } else {
            setRunning(false);
          }
        } else {
          // Parallel: done when all workers finished
          if (workersRef.current.size === 0) setRunning(false);
        }
      } else if (msg.type === 'stopped') {
        worker.terminate();
        workersRef.current.delete(idx);
        if (workersRef.current.size === 0) setRunning(false);
      } else if (msg.type === 'error') {
        toast.error(`Key generation error: ${msg.message}`);
        worker.terminate();
        workersRef.current.delete(idx);
        if (workersRef.current.size === 0) setRunning(false);
      }
    };

    worker.postMessage({ type: 'start', prefix: allTargets[idx].prefix });
  };

  // Assign spawnParallelForTargetRef every render — N workers per target, sequential through targets.
  // First worker to find the key terminates all siblings and advances to the next target.
  spawnParallelForTargetRef.current = (targetIdx: number) => {
    const allTargets = targetsRef.current;
    if (targetIdx >= allTargets.length) return;

    const targetPrefix = allTargets[targetIdx].prefix;
    const N = Math.min(navigator.hardwareConcurrency || 4, 16);
    const localWorkerKeys: number[] = [];
    let found = false; // prevents double-handling if two workers find simultaneously

    // Mark this target as searching
    targetsRef.current = targetsRef.current.map((t, i) =>
      i === targetIdx ? { ...t, status: 'searching' as const } : t
    );
    setTargets([...targetsRef.current]);

    for (let wi = 0; wi < N; wi++) {
      const workerKey = targetIdx * 1000 + wi;
      localWorkerKeys.push(workerKey);

      const worker = new Worker(new URL('../workers/keygenWorker.ts', import.meta.url), {
        type: 'module',
      });
      workersRef.current.set(workerKey, worker);

      worker.onmessage = (e: MessageEvent<KeygenWorkerResult>) => {
        const msg = e.data;

        if (msg.type === 'progress') {
          workerKpsRef.current.set(workerKey, msg.keysPerSecond);
          const totalKps = localWorkerKeys.reduce(
            (sum, k) => sum + (workerKpsRef.current.get(k) ?? 0),
            0
          );
          targetsRef.current = targetsRef.current.map((t, i) =>
            i === targetIdx ? { ...t, kps: totalKps, attempts: msg.attempts } : t
          );
          setTargets([...targetsRef.current]);
        } else if (msg.type === 'found') {
          if (found) return;
          found = true;

          // Terminate all sibling workers for this target
          for (const key of localWorkerKeys) {
            const w = workersRef.current.get(key);
            if (w) {
              w.terminate();
              workersRef.current.delete(key);
              workerKpsRef.current.delete(key);
            }
          }

          const result: GeneratedKey = {
            publicKey: msg.publicKey,
            privateKey: msg.privateKey,
            attempts: msg.attempts,
          };
          targetsRef.current = targetsRef.current.map((t, i) =>
            i === targetIdx ? { ...t, status: 'found', result, kps: 0 } : t
          );
          setTargets([...targetsRef.current]);

          const nextIdx = targetIdx + 1;
          if (nextIdx < targetsRef.current.length && gpuRunningRef.current) {
            spawnParallelForTargetRef.current(nextIdx);
          } else {
            gpuRunningRef.current = false;
            setRunning(false);
          }
        } else if (msg.type === 'stopped') {
          worker.terminate();
          workersRef.current.delete(workerKey);
          workerKpsRef.current.delete(workerKey);
          if (workersRef.current.size === 0) setRunning(false);
        } else if (msg.type === 'error') {
          toast.error(`Key generation error: ${msg.message}`);
          worker.terminate();
          workersRef.current.delete(workerKey);
          workerKpsRef.current.delete(workerKey);
          if (workersRef.current.size === 0) setRunning(false);
        }
      };

      worker.postMessage({ type: 'start', prefix: targetPrefix });
    }
  };

  // ── Validation ────────────────────────────────────────────────────────────
  const cleanPrefix = prefix.toLowerCase().replace(/[^0-9a-f]/g, '');
  const suffixLen = keyCount > 1 ? String(keyCount).length : 0;
  const maxPrefixLen = keyCount > 1 ? 8 - suffixLen : 8;
  const prefixValid =
    prefix === '' || (prefix === cleanPrefix && cleanPrefix.length <= maxPrefixLen);
  const difficulty =
    cleanPrefix.length > 0 ? expectedAttempts(cleanPrefix.length + suffixLen) : null;

  // ── GPU helpers ───────────────────────────────────────────────────────────

  /** Expand a 32-byte seed → 64-byte MeshCore private key (SHA-512 + clamp). */
  async function expandPrivateKeyFromSeed(seed: Uint8Array): Promise<Uint8Array> {
    const ab = seed.buffer.slice(seed.byteOffset, seed.byteOffset + 32) as ArrayBuffer;
    const hashBuf = await crypto.subtle.digest('SHA-512', ab);
    const hash = new Uint8Array(hashBuf);
    hash[0] &= 248;
    hash[31] &= 127;
    hash[31] |= 64;
    return hash;
  }

  function bytesToHex(b: Uint8Array): string {
    return Array.from(b)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
  }

  /** Run the GPU dispatch loop for target at `idx`, then chain to `idx+1`. */
  async function runGpuTarget(idx: number) {
    const gen = gpuGenRef.current!;
    const prefix = targetsRef.current[idx].prefix;
    let totalAttempted = 0;
    let periodStart = performance.now();
    let periodAttempts = 0;

    while (gpuRunningRef.current) {
      const { matches, attempted } = await gen.dispatchBatch(prefix);
      totalAttempted += attempted;
      periodAttempts += attempted;

      const now = performance.now();
      if (now - periodStart >= 500) {
        const kps = Math.round((periodAttempts / (now - periodStart)) * 1000);
        targetsRef.current = targetsRef.current.map((t, i) =>
          i === idx ? { ...t, kps, attempts: totalAttempted } : t
        );
        setTargets([...targetsRef.current]);
        periodStart = now;
        periodAttempts = 0;
      }

      if (matches.length > 0) {
        const match = matches[0];
        const pubHex = bytesToHex(match.pubkey);
        const priv = await expandPrivateKeyFromSeed(match.seed);
        const privHex = bytesToHex(priv);

        const result: GeneratedKey = {
          publicKey: pubHex,
          privateKey: privHex,
          attempts: totalAttempted,
        };
        targetsRef.current = targetsRef.current.map((t, i) =>
          i === idx ? { ...t, status: 'found', result, kps: 0 } : t
        );
        setTargets([...targetsRef.current]);

        const nextIdx = idx + 1;
        if (nextIdx < targetsRef.current.length && gpuRunningRef.current) {
          targetsRef.current = targetsRef.current.map((t, i) =>
            i === nextIdx ? { ...t, status: 'searching' } : t
          );
          setTargets([...targetsRef.current]);
          runGpuTarget(nextIdx);
        } else {
          gpuRunningRef.current = false;
          setRunning(false);
        }
        return;
      }
    }

    // Stopped externally — reset any still-searching targets and clear running state
    targetsRef.current = targetsRef.current.map((t) =>
      t.status === 'searching' ? { ...t, status: 'waiting', kps: 0 } : t
    );
    setTargets([...targetsRef.current]);
    setRunning(false);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  const startGeneration = () => {
    if (running || !prefixValid) return;

    const allTargets = buildTargets(cleanPrefix, keyCount);
    targetsRef.current = allTargets.map((t) => ({ ...t }));
    useParallelRef.current = useParallel;
    workersRef.current.clear();
    workerKpsRef.current.clear();
    setShowPriv({});
    setRunning(true);

    if (useParallel) {
      // GPU mode: WebGPU sequential dispatch loop
      if (!gpuAvailable) {
        toast.error('WebGPU not available on this device');
        setRunning(false);
        return;
      }
      targetsRef.current = targetsRef.current.map((t, i) => ({
        ...t,
        status: i === 0 ? ('searching' as const) : ('waiting' as const),
      }));
      setTargets([...targetsRef.current]);
      gpuRunningRef.current = true;

      const initAndRun = async () => {
        try {
          if (!gpuGenRef.current || !gpuGenRef.current.isReady) {
            const { GPUKeyGenerator } = await import('../workers/gpu/gpuKeygen');
            if (!gpuGenRef.current) {
              gpuGenRef.current = new GPUKeyGenerator();
            }
            await gpuGenRef.current.initialize();
          }
          gpuGenRef.current.turboMode = turboModeRef.current;
          gpuGenRef.current.dispatchTargetMs = turboModeRef.current ? 1000 : 100;
          runGpuTarget(0);
        } catch (e) {
          toast.error(`GPU init failed: ${String(e)}`);
          gpuRunningRef.current = false;
          setRunning(false);
        }
      };
      initAndRun();
    } else if (turboModeRef.current) {
      // CPU + Turbo: parallel workers (N per target, sequential through targets)
      gpuRunningRef.current = true;
      setTargets([...targetsRef.current]);
      spawnParallelForTargetRef.current(0);
    } else {
      // CPU: sequential single worker
      targetsRef.current = targetsRef.current.map((t, i) => ({
        ...t,
        status: i === 0 ? ('searching' as const) : ('waiting' as const),
      }));
      setTargets([...targetsRef.current]);
      spawnRef.current(0);
    }
  };

  const stopGeneration = () => {
    gpuRunningRef.current = false;
    workersRef.current.forEach((w) => w.postMessage({ type: 'stop' }));
  };

  const handleSaveAll = async () => {
    const found = targetsRef.current.filter((t) => t.result);
    if (!found.length) return;
    setSavingAll(true);
    let saved = 0;
    for (const t of found) {
      if (!t.result) continue;
      try {
        await api.kmsCreateKey({
          public_key: t.result.publicKey,
          private_key: t.result.privateKey,
          device_name: deviceName || null,
          device_role: deviceRole || null,
          model: model || null,
          assigned_to: assignedTo || null,
          placement_date: placementDate || null,
        });
        saved++;
      } catch {
        // skip duplicates silently
      }
    }
    toast.success(`${saved} key${saved !== 1 ? 's' : ''} saved to vault`);
    setSavingAll(false);
  };

  const copyToClipboard = (text: string, label: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error('Clipboard not available')
    );

  const togglePriv = (key: string) => setShowPriv((p) => ({ ...p, [key]: !p[key] }));

  // ── Derived ───────────────────────────────────────────────────────────────
  const foundTargets = targets.filter((t) => t.status === 'found' && t.result);
  const allFound = targets.length > 0 && targets.every((t) => t.status === 'found');
  const totalKps = targets.reduce((sum, t) => sum + (t.status === 'searching' ? t.kps : 0), 0);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border">
        <KeyRound className="h-4 w-4 text-primary flex-shrink-0" />
        <h2 className="font-semibold text-base">MC-KMS</h2>
        <span className="text-xs text-muted-foreground">MeshCore Key Management System</span>
        <div className="ml-auto flex gap-1">
          {(['generate', 'vault'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'px-3 py-1 rounded text-xs font-medium transition-colors',
                tab === t
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
              )}
            >
              {t === 'generate' ? 'Generate' : 'Vault'}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {tab === 'generate' ? (
          <>
            {/* ── Vanity Prefix ─────────────────────────────────────────────── */}
            <section className="rounded-lg border border-border bg-card p-4 space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                Vanity Prefix
                <span className="text-xs text-muted-foreground font-normal">(optional)</span>
              </h3>
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value.toLowerCase())}
                  placeholder={`e.g. f8a1 (hex, max ${maxPrefixLen} chars)`}
                  maxLength={maxPrefixLen}
                  disabled={running}
                  className={cn(
                    'flex-1 rounded border bg-background px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring transition',
                    !prefixValid ? 'border-destructive' : 'border-border'
                  )}
                />
                {!prefixValid && <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0" />}
              </div>
              {difficulty &&
                prefixValid &&
                (() => {
                  const prefixLen = cleanPrefix.length + suffixLen;
                  const n = Math.pow(16, prefixLen);
                  const tier = getDifficultyTier(n);
                  const eta = totalKps > 0 ? formatEta(n / totalKps) : null;
                  return (
                    <div className="flex items-center gap-1.5 flex-wrap text-xs">
                      <span className={cn('font-semibold', tier.className)}>{tier.label}</span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground">
                        ~{formatAttempts(n)} attempts for a {prefixLen}-char prefix
                      </span>
                      {eta && (
                        <>
                          <span className="text-muted-foreground">·</span>
                          <span className="text-muted-foreground">~{eta} at current rate</span>
                        </>
                      )}
                    </div>
                  );
                })()}
            </section>

            {/* ── Number of Keys ────────────────────────────────────────────── */}
            <section className="rounded-lg border border-border bg-card p-4 space-y-3">
              <h3 className="text-sm font-semibold">Number of Keys</h3>
              <div className="flex items-center gap-3 flex-wrap">
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={keyCount}
                  onChange={(e) =>
                    setKeyCount(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))
                  }
                  disabled={running}
                  className="w-24 rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
                {keyCount > 1 && cleanPrefix ? (
                  <p className="text-xs text-muted-foreground">
                    Targets: <span className="font-mono">{cleanPrefix}1</span>
                    {keyCount > 2 && (
                      <>
                        {' '}
                        →{' '}
                        <span className="font-mono">
                          {cleanPrefix}
                          {keyCount - 1}
                        </span>
                      </>
                    )}{' '}
                    →{' '}
                    <span className="font-mono">
                      {cleanPrefix}
                      {keyCount}
                    </span>
                  </p>
                ) : keyCount > 1 ? (
                  <p className="text-xs text-muted-foreground">
                    Add a prefix to enable sequential numbering
                  </p>
                ) : null}
              </div>
            </section>

            {/* ── Device Metadata ───────────────────────────────────────────── */}
            <section className="rounded-lg border border-border bg-card p-4 space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                Device Metadata
                <span className="text-xs text-muted-foreground font-normal">
                  pre-filled when saving to vault
                </span>
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(
                  [
                    {
                      label: 'Device Name',
                      value: deviceName,
                      set: setDeviceName,
                      placeholder: 'e.g. Rooftop Repeater',
                    },
                    {
                      label: 'Device Role',
                      value: deviceRole,
                      set: setDeviceRole,
                      placeholder: 'Repeater, Room Server…',
                    },
                    {
                      label: 'Model',
                      value: model,
                      set: setModel,
                      placeholder: 'e.g. HELTEC-V3',
                    },
                    {
                      label: 'Assigned To',
                      value: assignedTo,
                      set: setAssignedTo,
                      placeholder: 'Team or person',
                    },
                  ] as {
                    label: string;
                    value: string;
                    set: (v: string) => void;
                    placeholder: string;
                  }[]
                ).map(({ label, value, set, placeholder }) => (
                  <div key={label} className="space-y-1">
                    <label className="text-xs text-muted-foreground">{label}</label>
                    <input
                      type="text"
                      value={value}
                      onChange={(e) => set(e.target.value)}
                      placeholder={placeholder}
                      className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                ))}
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Placement Date</label>
                  <input
                    type="date"
                    value={placementDate}
                    onChange={(e) => setPlacementDate(e.target.value)}
                    className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
              </div>
            </section>

            {/* ── Generate Controls ─────────────────────────────────────────── */}
            <section className="rounded-lg border border-border bg-card p-4 space-y-3">
              {/* CPU / GPU toggle */}
              <div className="flex items-center gap-3 flex-wrap">
                <Cpu className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div className="flex rounded border border-border overflow-hidden text-xs">
                  <button
                    onClick={() => setUseParallel(false)}
                    disabled={running}
                    className={cn(
                      'px-3 py-1.5 font-medium transition-colors',
                      !useParallel
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-background text-muted-foreground hover:bg-accent/50'
                    )}
                  >
                    CPU
                  </button>
                  <button
                    onClick={() => setUseParallel(true)}
                    disabled={running || !gpuAvailable}
                    title={
                      gpuAvailable === null
                        ? 'Checking WebGPU…'
                        : gpuAvailable
                          ? 'WebGPU hardware acceleration'
                          : 'WebGPU not available on this device'
                    }
                    className={cn(
                      'px-3 py-1.5 font-medium transition-colors border-l border-border',
                      useParallel
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-background text-muted-foreground hover:bg-accent/50',
                      !gpuAvailable && 'opacity-40 cursor-not-allowed'
                    )}
                  >
                    GPU
                  </button>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {useParallel
                    ? turboMode
                      ? 'WebGPU · turbo — 1000ms dispatch, up to 4096 workgroups'
                      : 'WebGPU · 100ms dispatch, up to 1024 workgroups'
                    : turboMode
                      ? `parallel CPU · ${Math.min(navigator.hardwareConcurrency || 4, 16)} workers`
                      : `CPU · sequential · ${navigator.hardwareConcurrency || 4} core${(navigator.hardwareConcurrency || 4) !== 1 ? 's' : ''} available`}
                </span>

                <button
                  onClick={() => setTurboMode((t) => !t)}
                  disabled={running}
                  title={
                    useParallel
                      ? turboMode
                        ? 'Turbo on — WebGPU 1000ms dispatch (click to disable)'
                        : 'Turbo off — click to enable WebGPU 1000ms dispatch'
                      : turboMode
                        ? `Turbo on — ${Math.min(navigator.hardwareConcurrency || 4, 16)} parallel CPU workers (click to disable)`
                        : 'Turbo off — click to use parallel CPU workers'
                  }
                  className={cn(
                    'flex items-center gap-1 px-2.5 py-1.5 rounded border text-xs font-medium transition-colors ml-1',
                    turboMode
                      ? 'bg-orange-500/20 border-orange-500/50 text-orange-400 hover:bg-orange-500/30'
                      : 'bg-background border-border text-muted-foreground hover:bg-accent/50'
                  )}
                >
                  <Flame className="h-3.5 w-3.5" />
                  Turbo
                </button>
              </div>

              {/* Generate button */}
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={running ? stopGeneration : startGeneration}
                  disabled={!prefixValid}
                  className={cn(
                    'flex items-center gap-2 rounded px-4 py-2 text-sm font-medium transition-colors',
                    running
                      ? 'bg-destructive/10 text-destructive hover:bg-destructive/20 border border-destructive/30'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90',
                    !prefixValid && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  {running ? (
                    <>
                      <Square className="h-3.5 w-3.5" /> Stop
                    </>
                  ) : (
                    <>
                      <Zap className="h-3.5 w-3.5" />
                      Generate {keyCount > 1 ? `${keyCount} Keys` : 'Key'}
                    </>
                  )}
                </button>

                {running && totalKps > 0 && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span className="font-mono">{formatKps(totalKps)}/s</span>
                    {targets.length > 1 && (
                      <span>
                        · {foundTargets.length}/{targets.length} found
                      </span>
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* ── Results ───────────────────────────────────────────────────── */}
            {targets.length > 0 && (
              <section className="rounded-lg border border-border bg-card p-4 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <h3 className="text-sm font-semibold">
                    {allFound
                      ? `${targets.length} key${targets.length !== 1 ? 's' : ''} generated`
                      : `${foundTargets.length} / ${targets.length} found`}
                  </h3>
                  {foundTargets.length > 0 && (
                    <div className="flex gap-2 flex-wrap">
                      <button
                        onClick={() =>
                          downloadBatch(
                            foundTargets.map((t) => ({
                              pub: t.result!.publicKey,
                              priv: t.result!.privateKey,
                              label: t.label,
                            })),
                            `meshcore_${cleanPrefix || 'keys'}_${Date.now()}.json`
                          )
                        }
                        className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 transition"
                      >
                        <Download className="h-3 w-3" />
                        Download JSON
                      </button>
                      <button
                        onClick={handleSaveAll}
                        disabled={savingAll}
                        className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition disabled:opacity-60"
                      >
                        {savingAll ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Database className="h-3 w-3" />
                        )}
                        Save to Vault
                      </button>
                    </div>
                  )}
                </div>

                {targets.length === 1 ? (
                  <SingleKeyResult
                    target={targets[0]}
                    showPriv={showPriv[targets[0].prefix] ?? false}
                    onTogglePriv={() => togglePriv(targets[0].prefix)}
                    onCopy={copyToClipboard}
                    onDownload={() =>
                      targets[0].result &&
                      downloadBatch(
                        [
                          {
                            pub: targets[0].result.publicKey,
                            priv: targets[0].result.privateKey,
                          },
                        ],
                        `meshcore_${cleanPrefix || 'key'}_${Date.now()}.json`
                      )
                    }
                    onSave={handleSaveAll}
                    saving={savingAll}
                  />
                ) : (
                  <div className="space-y-2">
                    {targets.map((t, i) => (
                      <MultiKeyRow
                        key={i}
                        target={t}
                        showPriv={showPriv[t.prefix] ?? false}
                        onTogglePriv={() => togglePriv(t.prefix)}
                        onCopy={copyToClipboard}
                        onDownload={() =>
                          t.result &&
                          downloadBatch(
                            [
                              {
                                pub: t.result.publicKey,
                                priv: t.result.privateKey,
                                label: t.label,
                              },
                            ],
                            `meshcore_${t.label}_${Date.now()}.json`
                          )
                        }
                      />
                    ))}
                  </div>
                )}

                {foundTargets.length > 0 && (
                  <p className="text-xs text-amber-600/80 dark:text-amber-400/70 flex items-start gap-1.5 pt-1">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                    Private keys are stored unencrypted. Only use on a trusted, access-controlled
                    server.
                  </p>
                )}

                {allFound && (
                  <button
                    onClick={() => {
                      setTargets([]);
                      targetsRef.current = [];
                    }}
                    className="flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Clear
                  </button>
                )}
              </section>
            )}
          </>
        ) : (
          <KeyVaultView embedded />
        )}
      </div>
    </div>
  );
}
