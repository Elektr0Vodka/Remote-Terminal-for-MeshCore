// Channel registry for discovered MeshCore channels.
// Stores enriched metadata in localStorage, separate from the radio channel list.
// Schema is compatible with meshcore-nl-discovered-channels/docs/data/channels.json
// and extends it with automation metadata (firstSeen, lastHeard, packets, source).

export interface RegistryChannel {
  // Core fields — compatible with meshcore-nl-discovered-channels schema
  channel: string; // Always starts with #, e.g. "#amsterdam"
  category: string;
  subcategory: string;
  region: string;
  language: string[];
  status: 'active' | 'inactive' | 'dormant' | 'experimental';
  verified: boolean;
  recommended: boolean;
  alias_of: string | null;
  notes: string;
  tags: string[];
  scopes: string[];
  country: string;
  // Extended metadata added by Project B (not in the base Project A schema)
  firstSeen: string | null; // ISO datetime — when first discovered by the channel finder
  lastHeard: string | null; // ISO datetime — most recent activity from finder
  added: string | null; // ISO date — when this entry was added to the registry
  packets: number; // Cumulative packet count from finder observations
  source: 'finder' | 'manual' | 'imported' | 'radio'; // 'radio' = seeded from existing DB channel
}

const STORAGE_KEY = 'meshcore-channel-registry';

function normalizeChannelName(name: string): string {
  const n = name.trim();
  return n.startsWith('#') ? n : `#${n}`;
}

function emptyEntry(
  name: string,
  source: RegistryChannel['source'],
  now: string
): RegistryChannel {
  const isLive = source === 'finder';
  return {
    channel: name,
    category: '',
    subcategory: '',
    region: '',
    language: [],
    status: 'active',
    verified: false,
    recommended: false,
    alias_of: null,
    notes: '',
    tags: [],
    scopes: [],
    country: '',
    firstSeen: isLive ? now : null,
    lastHeard: isLive ? now : null,
    added: now.slice(0, 10),
    packets: isLive ? 1 : 0,
    source,
  };
}

export function loadRegistry(): RegistryChannel[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RegistryChannel[]) : [];
  } catch {
    return [];
  }
}

export function saveRegistry(entries: RegistryChannel[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/**
 * Called when the channel finder discovers a channel.
 * If new: creates entry with firstSeen = lastHeard = now, packets = 1.
 * If existing: updates lastHeard = now, increments packets.
 * Returns the updated registry (caller must persist with saveRegistry).
 */
export function recordFinderDiscovery(
  channelName: string,
  existing: RegistryChannel[]
): RegistryChannel[] {
  const name = normalizeChannelName(channelName);
  const now = new Date().toISOString();
  const idx = existing.findIndex((e) => e.channel.toLowerCase() === name.toLowerCase());

  if (idx === -1) {
    return [...existing, emptyEntry(name, 'finder', now)];
  }

  return existing.map((e, i) =>
    i !== idx ? e : { ...e, lastHeard: now, packets: (e.packets ?? 0) + 1 }
  );
}

/**
 * Add a channel manually (e.g. from the Add Channel form).
 * If the channel already exists, merges the provided metadata.
 * Returns the updated registry (caller must persist with saveRegistry).
 */
export function addManualChannel(
  channelName: string,
  meta: Partial<
    Omit<RegistryChannel, 'channel' | 'firstSeen' | 'lastHeard' | 'packets' | 'source'>
  >,
  existing: RegistryChannel[]
): RegistryChannel[] {
  const name = normalizeChannelName(channelName);
  const now = new Date().toISOString();
  const idx = existing.findIndex((e) => e.channel.toLowerCase() === name.toLowerCase());

  if (idx !== -1) {
    return existing.map((e, i) => (i === idx ? { ...e, ...meta } : e));
  }

  return [
    ...existing,
    {
      ...emptyEntry(name, 'manual', now),
      ...meta,
      channel: name,
      firstSeen: null,
      lastHeard: null,
      added: meta.added ?? now.slice(0, 10),
      packets: 0,
      source: 'manual' as const,
    },
  ];
}

interface MergeResult {
  result: RegistryChannel[];
  added: number;
  updated: number;
}

/**
 * Merge imported channels into the existing registry.
 * Import rules:
 *   - Do NOT overwrite existing firstSeen
 *   - Use the newest lastHeard between existing and incoming
 *   - Accumulate packets (sum them)
 *   - Fill in missing metadata fields from the import without clobbering existing data
 *   - New entries get source = 'imported'
 *
 * Accepts partial entries so it can handle both the full Project B schema and
 * the base Project A schema (which has last_seen instead of lastHeard).
 */
export function mergeImport(
  incoming: (Partial<RegistryChannel> & { last_seen?: string })[],
  existing: RegistryChannel[]
): MergeResult {
  const byName = new Map(existing.map((e) => [e.channel.toLowerCase(), { ...e }]));
  let added = 0;
  let updated = 0;

  for (const raw of incoming) {
    if (!raw.channel) continue;
    const name = normalizeChannelName(raw.channel);
    const key = name.toLowerCase();
    // Accept lastHeard from the full schema or last_seen from the Project A schema
    const incomingLastHeard = raw.lastHeard ?? raw.last_seen ?? null;
    const now = new Date().toISOString();
    const current = byName.get(key);

    if (!current) {
      byName.set(key, {
        channel: name,
        category: raw.category ?? '',
        subcategory: raw.subcategory ?? '',
        region: raw.region ?? '',
        language: raw.language ?? [],
        status: raw.status ?? 'active',
        verified: raw.verified ?? false,
        recommended: raw.recommended ?? false,
        alias_of: raw.alias_of ?? null,
        notes: raw.notes ?? '',
        tags: raw.tags ?? [],
        scopes: raw.scopes ?? [],
        country: raw.country ?? '',
        firstSeen: raw.firstSeen ?? incomingLastHeard,
        lastHeard: incomingLastHeard,
        added: raw.added ?? now.slice(0, 10),
        packets: raw.packets ?? 0,
        source: 'imported',
      });
      added++;
    } else {
      // Preserve firstSeen, use newest lastHeard, sum packets
      const newerLastHeard = pickNewer(current.lastHeard, incomingLastHeard);
      byName.set(key, {
        ...current,
        // Fill gaps with imported data without overwriting existing non-empty values
        category: current.category || raw.category || '',
        subcategory: current.subcategory || raw.subcategory || '',
        region: current.region || raw.region || '',
        language: current.language.length > 0 ? current.language : (raw.language ?? []),
        verified: current.verified || (raw.verified ?? false),
        recommended: current.recommended || (raw.recommended ?? false),
        notes: current.notes || raw.notes || '',
        tags: dedupeArray([...current.tags, ...(raw.tags ?? [])]),
        scopes: dedupeArray([...current.scopes, ...(raw.scopes ?? [])]),
        country: current.country || raw.country || '',
        // Preserve firstSeen; use newest lastHeard; accumulate packets
        lastHeard: newerLastHeard,
        packets: (current.packets ?? 0) + (raw.packets ?? 0),
      });
      updated++;
    }
  }

  return { result: Array.from(byName.values()), added, updated };
}

/**
 * Minimal shape of a Project B radio Channel needed for seeding.
 * Matches the Channel interface in types.ts without importing it (avoids a
 * circular dep between lib/ and types.ts).
 */
export interface RadioChannelSeed {
  name: string;
  key: string;
  created_at?: number; // Unix timestamp (seconds) — optional, falls back to today
}

/**
 * One-way seed: adds any radio channel that is not already in the registry.
 * Never overwrites an existing registry entry.
 * New entries get source = 'radio' and added = the channel's created_at date.
 * Returns { result, added } — caller must persist with saveRegistry if added > 0.
 */
export function seedFromRadioChannels(
  radioChannels: RadioChannelSeed[],
  existing: RegistryChannel[]
): { result: RegistryChannel[]; added: number } {
  const byName = new Map(existing.map((e) => [e.channel.toLowerCase(), e]));
  let added = 0;

  for (const rc of radioChannels) {
    const name = normalizeChannelName(rc.name);
    const key = name.toLowerCase();
    if (byName.has(key)) continue;

    const createdDate = rc.created_at
      ? new Date(rc.created_at * 1000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    byName.set(key, {
      channel: name,
      category: '',
      subcategory: '',
      region: '',
      language: [],
      status: 'active',
      verified: false,
      recommended: false,
      alias_of: null,
      notes: '',
      tags: [],
      scopes: [],
      country: '',
      firstSeen: null,
      lastHeard: null,
      added: createdDate,
      packets: 0,
      source: 'radio',
    });
    added++;
  }

  return { result: Array.from(byName.values()), added };
}

/**
 * Update an existing registry entry by merging a patch into it.
 * If the channel is not found the registry is returned unchanged.
 */
export function updateChannel(
  channelName: string,
  patch: Partial<Omit<RegistryChannel, 'channel'>>,
  existing: RegistryChannel[]
): RegistryChannel[] {
  const key = channelName.toLowerCase();
  return existing.map((e) => (e.channel.toLowerCase() === key ? { ...e, ...patch } : e));
}

/**
 * Convert registry entries to the Project A channels.json schema.
 * Maps lastHeard → last_seen and drops Project B-only fields (firstSeen, packets, source).
 */
export function toProjectAFormat(
  entries: RegistryChannel[]
): Array<{
  channel: string;
  category: string;
  subcategory: string;
  region: string;
  language: string[];
  status: string;
  verified: boolean;
  recommended: boolean;
  alias_of: string | null;
  notes: string;
  tags: string[];
  scopes: string[];
  country: string;
  last_seen: string | null;
  added: string | null;
}> {
  return entries.map((e) => ({
    channel: e.channel,
    category: e.category,
    subcategory: e.subcategory,
    region: e.region,
    language: e.language,
    status: e.status,
    verified: e.verified,
    recommended: e.recommended,
    alias_of: e.alias_of,
    notes: e.notes,
    tags: e.tags,
    scopes: e.scopes,
    country: e.country,
    last_seen: e.lastHeard ?? e.firstSeen ?? null,
    added: e.added,
  }));
}

function pickNewer(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function dedupeArray<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
