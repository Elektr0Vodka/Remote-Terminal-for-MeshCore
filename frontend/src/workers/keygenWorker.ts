/**
 * keygenWorker.ts — Ed25519 vanity key generation worker
 *
 * Uses @noble/ed25519 with @noble/hashes/sha512 for synchronous keygen.
 * Output format matches MeshCore firmware expectations:
 *   public_key  = 32-byte Ed25519 public key (64 hex chars)
 *   private_key = SHA-512(seed) with first 32 bytes clamped (128 hex chars)
 */

import { getPublicKey, etc } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Wire up synchronous SHA-512 so getPublicKey (sync) works
etc.sha512Sync = (...msgs: Uint8Array[]) => sha512(etc.concatBytes(...msgs));

// ─── Types ───────────────────────────────────────────────────────────────────

export type KeygenWorkerMessage =
  | { type: 'start'; prefix: string; workerCount?: number }
  | { type: 'stop' };

export type KeygenWorkerResult =
  | { type: 'found'; publicKey: string; privateKey: string; attempts: number }
  | { type: 'progress'; keysPerSecond: number; attempts: number }
  | { type: 'stopped' }
  | { type: 'error'; message: string };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/** Build prefix bytes + mask to support odd-nibble prefixes (e.g. "f8a"). */
function buildPrefixMatcher(hex: string): { bytes: Uint8Array; mask: Uint8Array; len: number } | null {
  if (!hex) return null;
  const padded = hex.length % 2 === 0 ? hex : hex + '0';
  const bytes = new Uint8Array(padded.length / 2);
  const mask = new Uint8Array(padded.length / 2).fill(0xff);
  for (let i = 0; i < padded.length; i += 2) {
    bytes[i / 2] = parseInt(padded.slice(i, i + 2), 16);
  }
  if (hex.length % 2 !== 0) {
    // Last nibble is half-byte — only check the high nibble
    mask[mask.length - 1] = 0xf0;
  }
  return { bytes, mask, len: bytes.length };
}

function matchesPrefix(
  pub: Uint8Array,
  matcher: { bytes: Uint8Array; mask: Uint8Array; len: number },
): boolean {
  for (let i = 0; i < matcher.len; i++) {
    if ((pub[i] & matcher.mask[i]) !== (matcher.bytes[i] & matcher.mask[i])) return false;
  }
  return true;
}

/** Compute the expanded MeshCore private key from a 32-byte seed. */
async function expandPrivateKey(seed: Uint8Array): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer to satisfy subtle.digest's strict typing
  const ab = new ArrayBuffer(32);
  new Uint8Array(ab).set(seed);
  const hashBuf = await crypto.subtle.digest('SHA-512', ab);
  const hash = new Uint8Array(hashBuf);
  hash[0] &= 248;
  hash[31] &= 127;
  hash[31] |= 64;
  return hash;
}

// ─── Main loop ───────────────────────────────────────────────────────────────

let running = false;

self.onmessage = async (event: MessageEvent<KeygenWorkerMessage>) => {
  const msg = event.data;

  if (msg.type === 'stop') {
    running = false;
    return;
  }

  if (msg.type === 'start') {
    running = true;
    const prefix = (msg.prefix ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
    const matcher = buildPrefixMatcher(prefix);

    let attempts = 0;
    let periodStart = performance.now();
    let periodAttempts = 0;

    const PROGRESS_INTERVAL_MS = 500;
    const BATCH = 500; // keys per yield

    try {
      while (running) {
        // Process a batch synchronously before yielding
        for (let b = 0; b < BATCH && running; b++) {
          const seed = crypto.getRandomValues(new Uint8Array(32));
          // Reserved: first byte must not be 0x00 or 0xFF
          if (seed[0] === 0x00 || seed[0] === 0xff) continue;

          const pub = getPublicKey(seed);
          attempts++;
          periodAttempts++;

          if (!matcher || matchesPrefix(pub, matcher)) {
            const priv = await expandPrivateKey(seed);
            self.postMessage({
              type: 'found',
              publicKey: bytesToHex(pub),
              privateKey: bytesToHex(priv),
              attempts,
            } satisfies KeygenWorkerResult);
            running = false;
            return;
          }
        }

        // Progress + yield
        const now = performance.now();
        const elapsed = now - periodStart;
        if (elapsed >= PROGRESS_INTERVAL_MS) {
          const kps = Math.round((periodAttempts / elapsed) * 1000);
          self.postMessage({ type: 'progress', keysPerSecond: kps, attempts } satisfies KeygenWorkerResult);
          periodStart = now;
          periodAttempts = 0;
        }

        // Yield to allow stop messages through
        await new Promise<void>((r) => setTimeout(r, 0));
      }

      self.postMessage({ type: 'stopped' } satisfies KeygenWorkerResult);
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err) } satisfies KeygenWorkerResult);
      running = false;
    }
  }
};
