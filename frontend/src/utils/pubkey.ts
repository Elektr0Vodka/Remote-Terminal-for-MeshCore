/**
 * Public key utilities for consistent handling of 64-char full keys
 * and 12-char prefixes throughout the application.
 *
 * MeshCore uses 64-character hex strings for public keys, but messages
 * and some radio operations only provide 12-character prefixes. This
 * module provides utilities for working with both formats consistently.
 */

import type { Contact } from '../types';

/** Length of a public key prefix in hex characters */
const PUBKEY_PREFIX_LENGTH = 12;

/**
 * Extract the 12-character prefix from a public key.
 * Works with both full keys and existing prefixes.
 */
function getPubkeyPrefix(key: string): string {
  return key.slice(0, PUBKEY_PREFIX_LENGTH);
}

/**
 * Get a display name for a contact, falling back to pubkey prefix.
 */
export function getContactDisplayName(
  name: string | null | undefined,
  pubkey: string,
  lastAdvert?: number | null
): string {
  if (name) return name;
  if (isUnknownFullKeyContact(pubkey, lastAdvert)) return '[unknown sender]';
  return getPubkeyPrefix(pubkey);
}

export function isPrefixOnlyContact(pubkey: string): boolean {
  return pubkey.length < 64;
}

export function isUnknownFullKeyContact(pubkey: string, lastAdvert?: number | null): boolean {
  return pubkey.length === 64 && !lastAdvert;
}

/**
 * Returns a bracketed short hex ID for a node, e.g. [A1], [A1F2], [A1F2C9].
 *
 * Display length is derived from the node's path hash mode:
 *   0 (1-byte) → 2 hex chars   [XX]
 *   1 (2-byte) → 4 hex chars   [XXYY]
 *   2 (3-byte) → 6 hex chars   [XXYYZZ]
 *   null/unknown → 2 hex chars, auto-expanded on collision
 *
 * When `contacts` is provided, collisions among those contacts at the
 * chosen length are detected and the prefix is automatically expanded
 * (up to 8 chars) so two different nodes never share the same label.
 */
export function getContactShortId(
  pubkey: string,
  hashMode?: number | null,
  contacts?: Contact[]
): string {
  const upper = pubkey.toUpperCase();

  // Base char length from hash mode (each byte = 2 hex chars)
  let baseChars = 2;
  if (hashMode === 1) baseChars = 4;
  else if (hashMode === 2) baseChars = 6;

  const candidates = contacts ?? [];

  // Try from baseChars up to 8, expanding only when there's a collision
  for (let chars = baseChars; chars <= 8; chars += 2) {
    const prefix = upper.slice(0, chars);
    // Collision: another contact shares the same prefix at this length
    const collision = candidates.some(
      (c) => c.public_key.toUpperCase() !== upper && c.public_key.toUpperCase().startsWith(prefix)
    );
    if (!collision) {
      return `[${prefix}]`;
    }
  }

  // Fallback: use 8 chars even if collision persists (extremely rare)
  return `[${upper.slice(0, 8)}]`;
}

/**
 * Resolve the best display label for a discovered or known node.
 * Priority: configured name → short bracketed ID.
 *
 * Intended for discovery lists and hop displays where both the name
 * and the short hash should be visible.
 */
export function resolveNodeLabel(
  pubkey: string,
  name: string | null | undefined,
  hashMode?: number | null,
  contacts?: Contact[]
): { shortId: string; name: string | null } {
  const shortId = getContactShortId(pubkey, hashMode, contacts);
  return { shortId, name: name || null };
}
