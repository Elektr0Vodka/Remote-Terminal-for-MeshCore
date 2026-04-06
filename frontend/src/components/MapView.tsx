import { useEffect, useState, useMemo, useRef, useCallback, memo } from 'react';
import { Cable, Info, Search, X } from 'lucide-react';
import { iso1A2Code, emojiFlag, feature as ccFeature } from '@rapideditor/country-coder';
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import type { LatLngBoundsExpression } from 'leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';
import type {
  Contact,
  PathDiscoveryResponse,
  RadioConfig,
  RadioTraceHopRequest,
  RadioTraceResponse,
  RawPacket,
  TraceResponse,
} from '../types';
import { formatTime } from '../utils/messageParser';
import { isValidLocation, parsePathHops, findContactsByPrefix } from '../utils/pathUtils';
import { getContactShortId } from '../utils/pubkey';
import { api } from '../api';
import { CONTACT_TYPE_REPEATER, CONTACT_TYPE_ROOM } from '../types';
import { useTraceBuilder } from '../hooks/useTraceBuilder';
import { useTraceHistory } from '../hooks/useTraceHistory';
import { formatSNR } from '../utils/traceUtils';
import {
  parsePacket,
  getPacketLabel,
  PARTICLE_COLOR_MAP,
  dedupeConsecutive,
} from '../utils/visualizerUtils';
import { getRawPacketObservationKey } from '../utils/rawPacketIdentity';
import { FlagEmoji } from '../utils/flagEmoji';

interface MapViewProps {
  contacts: Contact[];
  focusedKey?: string | null;
  onSelectConversation?: (conversation: import('../types').Conversation) => void;
  connectedPublicKey?: string | null;
  onPathDiscovery?: (publicKey: string) => Promise<PathDiscoveryResponse>;
  onRunTracePath?: (
    hopHashBytes: 1 | 2 | 4,
    hops: RadioTraceHopRequest[]
  ) => Promise<RadioTraceResponse>;
  rawPackets?: RawPacket[];
  config?: RadioConfig | null;
}

// ─── Contact type constants ──────────────────────────────────────────────────

const CONTACT_TYPE_UNKNOWN = 0;
const CONTACT_TYPE_CLIENT = 1;
const CONTACT_TYPE_SENSOR = 4;

type ContactTypeKey = 'unknown' | 'client' | 'repeater' | 'room' | 'sensor';

const CONTACT_TYPE_CONFIG: Record<
  ContactTypeKey,
  { label: string; value: number; emoji: string; small?: boolean }
> = {
  unknown: { label: 'Unknown', value: CONTACT_TYPE_UNKNOWN, emoji: '❓' },
  client: { label: 'Client', value: CONTACT_TYPE_CLIENT, emoji: '📟', small: true },
  repeater: { label: 'Repeater', value: CONTACT_TYPE_REPEATER, emoji: '🗼', small: true },
  room: { label: 'Room', value: CONTACT_TYPE_ROOM, emoji: '🏠', small: true },
  sensor: { label: 'Sensor', value: CONTACT_TYPE_SENSOR, emoji: '📡' },
};

const ALL_TYPE_KEYS = Object.keys(CONTACT_TYPE_CONFIG) as ContactTypeKey[];

function getTypeKey(type: number | null | undefined): ContactTypeKey {
  return ALL_TYPE_KEYS.find((k) => CONTACT_TYPE_CONFIG[k].value === type) ?? 'unknown';
}

// ─── Hash mode constants (path address width) ────────────────────────────────

type HashModeKey = '1B' | '2B' | '3B';

const HASH_MODE_CONFIG: Record<HashModeKey, { label: string; value: number }> = {
  '1B': { label: '1-B', value: 0 },
  '2B': { label: '2-B', value: 1 },
  '3B': { label: '3-B', value: 2 },
};
const ALL_HASH_MODE_KEYS = Object.keys(HASH_MODE_CONFIG) as HashModeKey[];

function getHashModeKey(hashMode: number | null | undefined): HashModeKey | null {
  if (hashMode == null) return null;
  return ALL_HASH_MODE_KEYS.find((k) => HASH_MODE_CONFIG[k].value === hashMode) ?? null;
}

/**
 * Returns the best available hash mode key from all evidence sources.
 * Priority: direct path > max(advert, observed packet evidence)
 */
function getContactHashModeKey(c: Contact): HashModeKey | null {
  const direct = c.direct_path_hash_mode;
  if (direct != null && direct >= 0) return getHashModeKey(direct);
  const a = c.advert_hash_mode ?? -1;
  const o = c.observed_hash_mode ?? -1;
  const best = Math.max(a, o);
  return best >= 0 ? getHashModeKey(best) : null;
}

/** True if hash mode is known only from packet evidence (no advert or direct path). */
function isHashModeObservedOnly(c: Contact): boolean {
  const direct = c.direct_path_hash_mode;
  if (direct != null && direct >= 0) return false;
  if (c.advert_hash_mode != null) return false;
  return (c.observed_hash_mode ?? -1) >= 0;
}

/**
 * Returns the hash mode key to use for map filtering.
 * Defaults to '1B' when no evidence exists — MeshCore's default mode — so that
 * contacts without attribution are not hidden when the 1B filter is active.
 */
function getContactHashModeKeyForFilter(c: Contact): HashModeKey {
  return getContactHashModeKey(c) ?? '1B';
}

// ─── Country lookup (pure local, no network) ─────────────────────────────────

interface CountryInfo {
  code: string; // ISO 3166-1 alpha-2
  name: string; // English short name
  flag: string; // emoji flag
}

function getCountryFromCoords(lat: number, lon: number): CountryInfo | null {
  // country-coder uses GeoJSON [lon, lat] order
  const code = iso1A2Code([lon, lat]);
  if (!code) return null;
  const flag = emojiFlag(code) ?? '';
  const feat = ccFeature([lon, lat]);
  const name = feat?.properties?.nameEn ?? code;
  return { code, name, flag };
}

// ─── Recency colors ──────────────────────────────────────────────────────────

const MAP_RECENCY_COLORS = {
  recent: '#06b6d4',
  today: '#2563eb',
  stale: '#f59e0b',
  old: '#64748b',
} as const;

function getMarkerColor(lastSeen: number | null | undefined): string {
  if (lastSeen == null) return MAP_RECENCY_COLORS.old;
  const age = Date.now() / 1000 - lastSeen;
  if (age < 3600) return MAP_RECENCY_COLORS.recent;
  if (age < 86400) return MAP_RECENCY_COLORS.today;
  if (age < 3 * 86400) return MAP_RECENCY_COLORS.stale;
  return MAP_RECENCY_COLORS.old;
}

// ─── Emoji DivIcon ────────────────────────────────────────────────────────────

type HealthLevel = 'HIGH' | 'MEDIUM' | null;

function buildIcon(
  emoji: string,
  color: string,
  focused = false,
  health: HealthLevel = null,
  small = false
): L.DivIcon {
  const w = small ? 20 : 28;
  const h = small ? 22 : 32;
  const fontSize = small ? '14px' : '22px';
  const dotSize = small ? '5px' : '8px';
  const opacity = small ? 'opacity:0.75;' : '';

  const ring = focused
    ? `<div style="position:absolute;inset:-3px;border-radius:50%;border:2px dashed #ffffff;pointer-events:none;"></div>`
    : '';
  const healthRing =
    health === 'HIGH'
      ? `<div style="position:absolute;inset:-5px;border-radius:50%;border:2.5px solid #dc2626;pointer-events:none;"></div>`
      : health === 'MEDIUM'
        ? `<div style="position:absolute;inset:-5px;border-radius:50%;border:2px dashed #d97706;pointer-events:none;"></div>`
        : '';
  const html = `
    <div style="position:relative;width:${w}px;height:${h}px;display:flex;flex-direction:column;align-items:center;gap:1px;${opacity}">
      ${healthRing}
      ${ring}
      <span style="font-size:${fontSize};line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5));">${emoji}</span>
      <span style="width:${dotSize};height:${dotSize};border-radius:50%;background:${color};border:1.5px solid #0f172a;flex-shrink:0;"></span>
    </div>`;
  return L.divIcon({
    html,
    className: '',
    iconSize: [w, h],
    iconAnchor: [w / 2, h],
    popupAnchor: [0, -(h + 6)],
  });
}

// ─── Map popup with editable notes and owner ID ───────────────────────────────

// Types that can have an owner (are owned by a companion radio)
const OWNER_CAPABLE_TYPES = new Set([
  CONTACT_TYPE_REPEATER,
  CONTACT_TYPE_ROOM,
  CONTACT_TYPE_SENSOR,
]);

const MapPopupContent = memo(function MapPopupContent({
  contact,
  contactsRef,
  cfg,
  displayName,
  lastHeardLabel,
  health,
  onSelectConversation,
  onOpenPopup,
  onShowPathOnMap,
  connectedPublicKey,
  onPathDiscovery,
}: {
  contact: import('../types').Contact;
  contactsRef: React.MutableRefObject<import('../types').Contact[]>;
  cfg: { label: string; emoji: string };
  displayName: string;
  lastHeardLabel: string;
  health: HealthLevel;
  onSelectConversation?: (conversation: import('../types').Conversation) => void;
  onOpenPopup?: (publicKey: string) => void;
  /** Callback to draw a path overlay on the main map */
  onShowPathOnMap?: (contactKey: string, segments: [number, number][][]) => void;
  connectedPublicKey?: string | null;
  onPathDiscovery?: (publicKey: string) => Promise<PathDiscoveryResponse>;
}) {
  const map = useMap();
  const [notes, setNotes] = useState<string>(contact.notes ?? '');
  const [ownerId, setOwnerId] = useState<string>(contact.owner_id ?? '');
  const [editingOwner, setEditingOwner] = useState(!contact.owner_id);
  const [saving, setSaving] = useState(false);
  const [savingOwner, setSavingOwner] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedCoords, setCopiedCoords] = useState(false);

  // ── Live trace state ─────────────────────────────────────────────────────
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceResult, setTraceResult] = useState<TraceResponse | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);

  // ── Path discovery state ─────────────────────────────────────────────────
  const [pathDiscovering, setPathDiscovering] = useState(false);
  const [pathDiscoveryError, setPathDiscoveryError] = useState<string | null>(null);

  const handleLiveTrace = useCallback(async () => {
    setTraceLoading(true);
    setTraceResult(null);
    setTraceError(null);
    try {
      const result = await api.requestTrace(contact.public_key);
      setTraceResult(result);
    } catch (err) {
      setTraceError(err instanceof Error ? err.message : 'Trace failed');
    } finally {
      setTraceLoading(false);
    }
  }, [contact.public_key]);

  // ── Path-on-map: resolve hops to GPS segments and draw ──────────────────
  /** Build and display the polyline for a known path string + hop count. */
  const drawPathFromData = useCallback(
    (pathStr: string, pathLen: number) => {
      if (!onShowPathOnMap) return;
      const contacts = contactsRef.current;
      type Pt = [number, number];

      const radioContact = connectedPublicKey
        ? contacts.find((c) => c.public_key.toLowerCase() === connectedPublicKey.toLowerCase())
        : null;

      const allPts: (Pt | null)[] = [];
      allPts.push(
        radioContact && isValidLocation(radioContact.lat, radioContact.lon)
          ? [radioContact.lat!, radioContact.lon!]
          : null
      );

      const hopPrefixes = parsePathHops(pathStr, pathLen);
      for (const prefix of hopPrefixes) {
        const matches = findContactsByPrefix(prefix, contacts, true);
        if (matches.length === 1 && isValidLocation(matches[0].lat, matches[0].lon)) {
          allPts.push([matches[0].lat!, matches[0].lon!]);
        } else {
          allPts.push(null);
        }
      }

      allPts.push(isValidLocation(contact.lat, contact.lon) ? [contact.lat!, contact.lon!] : null);

      const segments: Pt[][] = [];
      let current: Pt[] = [];
      for (const pt of allPts) {
        if (pt !== null) {
          current.push(pt);
        } else {
          if (current.length >= 2) segments.push(current);
          current = [];
        }
      }
      if (current.length >= 2) segments.push(current);

      onShowPathOnMap(contact.public_key, segments);
      if (segments.length > 0) {
        const flat = segments.flat();
        if (flat.length === 1) map.flyTo(flat[0], Math.max(map.getZoom(), 12));
        else map.fitBounds(flat as L.LatLngBoundsExpression, { padding: [60, 60], maxZoom: 14 });
      }
    },
    [contact, contactsRef, connectedPublicKey, map, onShowPathOnMap]
  );

  const handleShowPathOnMap = useCallback(async () => {
    if (!onShowPathOnMap) return;
    setPathDiscoveryError(null);

    const path = contact.direct_path;
    const pathLen = contact.direct_path_len;

    // If we already have path data, draw it immediately
    if (path && pathLen != null && pathLen > 0) {
      drawPathFromData(path, pathLen);
      return;
    }

    // No cached path — try path discovery if the callback is available
    if (onPathDiscovery) {
      setPathDiscovering(true);
      try {
        const result = await onPathDiscovery(contact.public_key);
        const fwd = result.forward_path;
        if (fwd.path && fwd.path_len > 0) {
          drawPathFromData(fwd.path, fwd.path_len);
          return;
        }
      } catch {
        setPathDiscoveryError('Path discovery failed');
      } finally {
        setPathDiscovering(false);
      }
    }

    // Fallback: draw a direct line if both nodes have GPS
    const contacts = contactsRef.current;
    const radioContact = connectedPublicKey
      ? contacts.find((c) => c.public_key.toLowerCase() === connectedPublicKey.toLowerCase())
      : null;
    if (
      radioContact &&
      isValidLocation(radioContact.lat, radioContact.lon) &&
      isValidLocation(contact.lat, contact.lon)
    ) {
      onShowPathOnMap(contact.public_key, [
        [
          [radioContact.lat!, radioContact.lon!],
          [contact.lat!, contact.lon!],
        ],
      ]);
    }
  }, [
    contact,
    contactsRef,
    connectedPublicKey,
    onShowPathOnMap,
    onPathDiscovery,
    drawPathFromData,
  ]);

  // Short bracketed ID for this contact (used alongside full key display)
  const shortId = useMemo(
    () =>
      getContactShortId(
        contact.public_key,
        contact.advert_hash_mode ?? contact.observed_hash_mode,
        contactsRef.current
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contact.public_key, contact.advert_hash_mode, contact.observed_hash_mode]
  );

  const showOwnerField = OWNER_CAPABLE_TYPES.has(contact.type);
  const isManageable = contact.type === CONTACT_TYPE_REPEATER || contact.type === CONTACT_TYPE_ROOM;

  // Path info derived from the contact's known direct route
  const directPathLen = contact.direct_path_len ?? -1;
  const directHashMode = contact.direct_path_hash_mode ?? -1;
  const hasKnownPath = directPathLen >= 0;
  const pathLabel = hasKnownPath
    ? directPathLen === 0
      ? 'direct'
      : `${directPathLen} hop${directPathLen !== 1 ? 's' : ''}`
    : null;
  const pathModeLabel =
    directHashMode >= 0 && directHashMode <= 2 ? `${directHashMode + 1}-byte IDs` : null;

  const isConnectedRadio =
    !!connectedPublicKey && contact.public_key.toLowerCase() === connectedPublicKey.toLowerCase();

  const copyKey = () => {
    navigator.clipboard.writeText(contact.public_key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const copyCoords = () => {
    const text = `${contact.lat!.toFixed(6)}, ${contact.lon!.toFixed(6)}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedCoords(true);
      setTimeout(() => setCopiedCoords(false), 1500);
    });
  };

  const saveNotes = (value: string) => {
    if (value === (contact.notes ?? '')) return;
    setSaving(true);
    fetch(`/api/contacts/${contact.public_key}/notes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: value || null }),
    }).finally(() => setSaving(false));
  };

  const saveOwnerId = (value: string) => {
    const trimmed = value.trim().toLowerCase() || null;
    if (trimmed === (contact.owner_id ?? null)) return;
    setSavingOwner(true);
    fetch(`/api/contacts/${contact.public_key}/owner-id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_id: trimmed }),
    })
      .then(() => {
        if (trimmed) setEditingOwner(false);
      })
      .finally(() => setSavingOwner(false));
  };

  // The contact that owns this node — read from ref so it doesn't cause re-renders
  const ownerContact = useMemo(() => {
    const id = (contact.owner_id ?? '').toLowerCase();
    if (!id) return null;
    return (
      contactsRef.current.find(
        (c) => c.public_key.toLowerCase() === id || c.public_key.toLowerCase().startsWith(id)
      ) ?? null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact.owner_id]);

  // All nodes this contact owns — read from ref so it doesn't cause re-renders
  const ownedNodes = useMemo(() => {
    const pk = contact.public_key.toLowerCase();
    return contactsRef.current.filter((c) => (c.owner_id ?? '').toLowerCase() === pk);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact.public_key]);

  const navigateTo = (c: import('../types').Contact) => {
    if (c.lat != null && c.lon != null) map.flyTo([c.lat, c.lon], Math.max(map.getZoom(), 14));
    onOpenPopup?.(c.public_key);
  };

  const openManage = () => {
    onSelectConversation?.({
      type: 'contact',
      id: contact.public_key,
      name: contact.name ?? contact.public_key.slice(0, 12),
    });
  };

  return (
    <div className="text-sm min-w-[210px] text-foreground">
      {/* Titlebar — node name styled like a window/taskbar header */}
      <div className="popup-titlebar -mx-3 -mt-3 mb-2 px-3 py-1.5 flex items-center gap-1.5 flex-wrap">
        <span aria-hidden="true">{cfg.emoji}</span>
        <span className="font-semibold truncate flex-1">{displayName}</span>
        {onSelectConversation && (
          <button
            onClick={openManage}
            title="Open contact info"
            className="flex-shrink-0 rounded p-0.5 text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        )}
        {isConnectedRadio && (
          <span className="rounded px-1 py-0.5 text-[9px] font-bold bg-success/20 text-success whitespace-nowrap">
            My Companion
          </span>
        )}
        {health === 'HIGH' && (
          <span className="rounded px-1 py-0.5 text-[9px] font-bold bg-destructive/20 text-destructive">
            HIGH ADVERT
          </span>
        )}
        {health === 'MEDIUM' && (
          <span className="rounded px-1 py-0.5 text-[9px] font-bold bg-warning/20 text-warning">
            MED ADVERT
          </span>
        )}
        {getContactHashModeKey(contact) !== null && (
          <span
            className="rounded px-1 py-0.5 text-[9px] font-bold bg-muted/80 text-muted-foreground whitespace-nowrap font-mono"
            title={
              isHashModeObservedOnly(contact)
                ? 'Hash mode inferred from received packets (no advert)'
                : 'Hash mode declared via advertisement'
            }
          >
            {HASH_MODE_CONFIG[getContactHashModeKey(contact)!].label}
            {isHashModeObservedOnly(contact) && <span className="opacity-60"> obs</span>}
          </span>
        )}
      </div>

      {/* Public key + short ID + copy */}
      <div className="flex items-center gap-1">
        <span className="font-mono text-[10px] font-semibold text-primary/80 flex-shrink-0">
          {shortId}
        </span>
        <span
          className="font-mono text-[10px] text-muted-foreground truncate"
          style={{ maxWidth: '140px' }}
          title={contact.public_key}
        >
          {contact.public_key.slice(shortId.length - 2)}
        </span>
        <button
          onClick={copyKey}
          title="Copy public key"
          className="flex-shrink-0 rounded px-1 py-0.5 text-[9px] text-muted-foreground hover:text-foreground hover:bg-accent transition"
        >
          {copied ? '✓' : '⧉'}
        </button>
      </div>

      {/* Meta */}
      <div className="text-xs text-muted-foreground mt-0.5">{cfg.label}</div>
      <div className="text-xs text-muted-foreground">Last heard: {lastHeardLabel}</div>
      {contact.first_seen != null && (
        <div className="text-xs text-muted-foreground">
          First heard: {formatTime(contact.first_seen)}
        </div>
      )}
      {/* Coordinates + copy */}
      <div className="flex items-center gap-1 mt-0.5">
        <span className="text-xs text-muted-foreground font-mono">
          {contact.lat!.toFixed(5)}, {contact.lon!.toFixed(5)}
        </span>
        <button
          onClick={copyCoords}
          title="Copy coordinates"
          className="flex-shrink-0 rounded px-1 py-0.5 text-[9px] text-muted-foreground hover:text-foreground hover:bg-accent transition"
        >
          {copiedCoords ? '✓' : '⧉'}
        </button>
      </div>
      {/* Signal information */}
      {contact.last_rssi != null && (
        <div className="text-xs text-muted-foreground mt-0.5">
          Signal: {contact.last_rssi} dBm RSSI
          {contact.last_snr != null && <span> / {contact.last_snr} dB SNR</span>}
        </div>
      )}

      {/* Live trace result */}
      {traceResult != null && (
        <div className="mt-1 rounded border border-border bg-muted/40 px-2 py-1 text-xs space-y-0.5">
          <div className="font-medium text-foreground">Live trace</div>
          {traceResult.local_snr != null && (
            <div className="text-muted-foreground">Local heard: {traceResult.local_snr} dB SNR</div>
          )}
          {traceResult.remote_snr != null && (
            <div className="text-muted-foreground">
              Remote heard us: {traceResult.remote_snr} dB SNR
            </div>
          )}
          <div className="text-muted-foreground">
            Path length: {traceResult.path_len} hop{traceResult.path_len !== 1 ? 's' : ''}
          </div>
        </div>
      )}
      {traceError != null && <div className="mt-1 text-xs text-destructive">{traceError}</div>}

      {pathLabel != null && (
        <div className="text-xs text-muted-foreground mt-0.5">
          Path: {pathLabel}
          {pathModeLabel && <span> · {pathModeLabel}</span>}
        </div>
      )}

      {/* Owner link — for contacts that can't have the edit field (clients/unknowns) */}
      {ownerContact && !showOwnerField && (
        <div className="flex items-center gap-1 mt-1 text-xs">
          <span className="text-muted-foreground">Owner:</span>
          <button
            onClick={() => navigateTo(ownerContact)}
            className="font-medium text-primary hover:underline"
          >
            {ownerContact.name ?? ownerContact.public_key.slice(0, 12)}
          </button>
        </div>
      )}

      {/* Owned nodes */}
      {ownedNodes.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs">
          <span className="text-muted-foreground">Owned nodes:</span>
          {ownedNodes.map((n, i) => {
            const label = n.name ?? n.public_key.slice(0, 12);
            const hasLoc = n.lat != null && n.lon != null;
            return (
              <span key={n.public_key} className="flex items-center">
                {i > 0 && <span className="text-muted-foreground mr-1">,</span>}
                {hasLoc ? (
                  <button
                    onClick={() => navigateTo(n)}
                    className="font-medium text-primary hover:underline"
                  >
                    {label}
                  </button>
                ) : (
                  <span className="font-medium text-foreground">{label}</span>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* Contact Owner — repeaters, rooms, sensors: inline display with ↺, or input when editing */}
      {showOwnerField && (
        <div className="mt-1">
          {editingOwner ? (
            <div className="mt-1">
              <div className="text-[10px] text-muted-foreground mb-0.5 font-medium uppercase tracking-wide">
                Contact Owner{' '}
                {savingOwner && (
                  <span className="normal-case font-normal opacity-60">(saving…)</span>
                )}
              </div>
              <input
                type="text"
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
                onBlur={(e) => saveOwnerId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    saveOwnerId(e.currentTarget.value);
                  }
                }}
                placeholder="Public key prefix or full key…"
                className="w-full rounded border border-border bg-background px-1.5 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono"
                style={{ minWidth: '160px' }}
                autoFocus
              />
            </div>
          ) : (
            <div className="text-xs">
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">Owner:</span>
                {ownerContact ? (
                  <button
                    onClick={() => navigateTo(ownerContact)}
                    className="font-medium text-primary hover:underline"
                  >
                    {ownerContact.name ?? ownerContact.public_key.slice(0, 12)}
                  </button>
                ) : (
                  <span className="font-mono text-muted-foreground">
                    {contact.owner_id?.slice(0, 16)}…
                  </span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingOwner(true);
                  }}
                  title="Change Node Owner"
                  className="text-[10px] text-muted-foreground hover:text-foreground transition"
                >
                  ↺
                </button>
              </div>
              {ownerContact && onSelectConversation && (
                <button
                  onClick={() =>
                    onSelectConversation({
                      type: 'contact',
                      id: ownerContact.public_key,
                      name: ownerContact.name ?? ownerContact.public_key.slice(0, 12),
                    })
                  }
                  className="mt-1 w-full rounded border border-border bg-background px-2 py-1 font-medium text-foreground hover:bg-accent transition text-center"
                >
                  Contact Owner
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Action buttons row */}
      <div className="mt-2 flex flex-col gap-1.5">
        {/* Send DM — clients and unknowns */}
        {!showOwnerField && !isManageable && onSelectConversation && (
          <button
            onClick={openManage}
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-accent transition text-center"
          >
            Send DM
          </button>
        )}

        {/* Manage Node button — repeaters and rooms */}
        {isManageable && onSelectConversation && (
          <button
            onClick={openManage}
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-accent transition text-center"
          >
            Manage Node
          </button>
        )}

        {/* Live signal trace — available for all nodes with a route */}
        <div className="flex gap-1.5">
          <button
            onClick={handleLiveTrace}
            disabled={traceLoading}
            title="Send a trace packet and get live SNR readings from this node"
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition text-center disabled:opacity-50"
          >
            {traceLoading ? 'Tracing…' : '📡 Live Signal'}
          </button>

          {/* Show path on main map — only when contact has GPS */}
          {onShowPathOnMap && isValidLocation(contact.lat, contact.lon) && (
            <button
              onClick={handleShowPathOnMap}
              disabled={pathDiscovering}
              title={
                pathDiscovering
                  ? 'Discovering path…'
                  : contact.direct_path && (contact.direct_path_len ?? 0) > 0
                    ? 'Draw the discovered route through repeaters'
                    : 'Discover and draw the route to this node'
              }
              className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition text-center disabled:opacity-50"
            >
              {pathDiscovering ? '⏳ Discovering…' : '🗺 Show Path'}
            </button>
          )}
          {pathDiscoveryError && (
            <span className="text-xs text-destructive">{pathDiscoveryError}</span>
          )}
        </div>
      </div>

      {/* Notes */}
      <div className="mt-2">
        <div className="text-[10px] text-muted-foreground mb-0.5 font-medium uppercase tracking-wide">
          Notes {saving && <span className="normal-case font-normal opacity-60">(saving…)</span>}
        </div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={(e) => saveNotes(e.target.value)}
          placeholder="Add a note…"
          rows={2}
          className="w-full resize-none rounded border border-border bg-background px-1.5 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          style={{ minWidth: '160px' }}
        />
      </div>
    </div>
  );
});

// ─── Custom cluster icon ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildClusterIcon(cluster: any): L.DivIcon {
  const count = cluster.getChildCount();
  const size = count < 10 ? 32 : count < 100 ? 38 : 44;
  const html = `<div style="width:${size}px;height:${size}px;border-radius:50%;background:hsl(220 70% 45% / 0.85);border:2px solid #f8fafc;display:flex;align-items:center;justify-content:center;color:#fff;font-size:${size < 38 ? 11 : 13}px;font-weight:700;font-family:sans-serif;box-shadow:0 2px 6px rgba(0,0,0,0.4);">${count}</div>`;
  return L.divIcon({
    html,
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// ─── Heatmap layer ────────────────────────────────────────────────────────────

interface HeatPoint {
  lat: number;
  lon: number;
  intensity: number;
}

function HeatmapLayer({ points }: { points: HeatPoint[] }) {
  const map = useMap();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const heatRef = useRef<any>(null);

  useEffect(() => {
    if (!points.length) return;

    const data = points.map((p) => [p.lat, p.lon, p.intensity] as [number, number, number]);

    if (!heatRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      heatRef.current = (L as any)
        .heatLayer(data, {
          radius: 35,
          blur: 25,
          maxZoom: 10,
          max: 1.0,
          gradient: {
            0.2: '#0ea5e9',
            0.4: '#22c55e',
            0.6: '#eab308',
            0.8: '#f97316',
            1.0: '#ef4444',
          },
          minOpacity: 0.4,
        })
        .addTo(map);
    } else {
      heatRef.current.setLatLngs(data);
      heatRef.current.redraw();
    }

    return () => {
      if (heatRef.current) {
        heatRef.current.remove();
        heatRef.current = null;
      }
    };
  }, [map, points]);

  return null;
}

// ─── Tile layers ──────────────────────────────────────────────────────────────

type TileLayerKey = 'osm' | 'dark' | 'light' | 'satellite' | 'topo';

const TILE_LAYERS: Record<TileLayerKey, { label: string; url: string; attribution: string }> = {
  osm: {
    label: 'OSM',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
  dark: {
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  },
  light: {
    label: 'Light',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; <a href="https://www.esri.com/">Esri</a>',
  },
  topo: {
    label: 'Topo',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://opentopomap.org/">OpenTopoMap</a>',
  },
};

const TILE_PREF_KEY = 'remoteterm-map-tile';
function loadTilePref(): TileLayerKey {
  try {
    const r = localStorage.getItem(TILE_PREF_KEY);
    return (r as TileLayerKey) ?? 'osm';
  } catch {
    return 'osm';
  }
}
function saveTilePref(v: TileLayerKey): void {
  try {
    localStorage.setItem(TILE_PREF_KEY, v);
  } catch {
    /* ignore storage errors */
  }
}

// ─── localStorage helpers ─────────────────────────────────────────────────────

function loadClusterPref(): boolean {
  try {
    const r = localStorage.getItem('remoteterm-map-cluster');
    return r === null ? true : r === 'true';
  } catch {
    return true;
  }
}
function saveClusterPref(v: boolean): void {
  try {
    localStorage.setItem('remoteterm-map-cluster', String(v));
  } catch {
    /* ignore storage errors */
  }
}

const MAP_VIEW_KEY = 'remoteterm-map-view';
function loadSavedView(): { lat: number; lng: number; zoom: number } | null {
  try {
    const r = localStorage.getItem(MAP_VIEW_KEY);
    if (!r) return null;
    const v = JSON.parse(r);
    if (typeof v.lat === 'number' && typeof v.lng === 'number' && typeof v.zoom === 'number')
      return v;
    return null;
  } catch {
    return null;
  }
}

// Persists the map view to localStorage on every moveend/zoomend
function MapViewPersist() {
  const map = useMap();
  useEffect(() => {
    const save = () => {
      const c = map.getCenter();
      try {
        localStorage.setItem(
          MAP_VIEW_KEY,
          JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() })
        );
      } catch {
        /* ignore storage errors */
      }
    };
    map.on('moveend', save);
    map.on('zoomend', save);
    return () => {
      map.off('moveend', save);
      map.off('zoomend', save);
    };
  }, [map]);
  return null;
}

// ─── Map bounds handler ──────────────────────────────────────────────────────

function MapBoundsHandler({
  contacts,
  focusedContact,
}: {
  contacts: Contact[];
  focusedContact: Contact | null;
}) {
  const map = useMap();
  const [hasInitialized, setHasInitialized] = useState(false);

  useEffect(() => {
    if (focusedContact && focusedContact.lat != null && focusedContact.lon != null) {
      map.setView([focusedContact.lat, focusedContact.lon], 12);
      setHasInitialized(true);
      return;
    }
    if (hasInitialized) return;

    // Restore saved view first if available
    const saved = loadSavedView();
    if (saved) {
      map.setView([saved.lat, saved.lng], saved.zoom);
      setHasInitialized(true);
      return;
    }

    const fitToContacts = () => {
      if (contacts.length === 0) {
        map.setView([20, 0], 2);
        setHasInitialized(true);
        return;
      }
      if (contacts.length === 1) {
        map.setView([contacts[0].lat!, contacts[0].lon!], 10);
        setHasInitialized(true);
        return;
      }
      const bounds: LatLngBoundsExpression = contacts.map(
        (c) => [c.lat!, c.lon!] as [number, number]
      );
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 12 });
      setHasInitialized(true);
    };

    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          map.setView([pos.coords.latitude, pos.coords.longitude], 8);
          setHasInitialized(true);
        },
        () => fitToContacts(),
        { timeout: 5000, maximumAge: 300000 }
      );
    } else {
      fitToContacts();
    }
  }, [map, contacts, hasInitialized, focusedContact]);

  return null;
}

// ─── FlyToHandler — flies to a contact key and opens its popup ───────────────

function FlyToHandler({
  targetKey,
  contacts,
  markerRefs,
  onDone,
}: {
  targetKey: string | null;
  contacts: Contact[];
  markerRefs: React.MutableRefObject<Record<string, L.Marker | null>>;
  onDone: () => void;
}) {
  const map = useMap();
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!targetKey) return;
    const c = contacts.find((x) => x.public_key === targetKey);
    if (c?.lat != null && c?.lon != null) {
      map.flyTo([c.lat, c.lon], Math.max(map.getZoom(), 14));
      setTimeout(() => markerRefs.current[targetKey]?.openPopup(), 600);
    }
    onDoneRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  return null;
}

// ─── Trace segment builder ────────────────────────────────────────────────────

function buildTraceSegments(
  result: RadioTraceResponse,
  contacts: Contact[],
  connectedPublicKey: string | null | undefined
): [number, number][][] {
  type Pt = [number, number];
  const pts: (Pt | null)[] = [];
  // local radio origin
  const local = connectedPublicKey
    ? contacts.find((c) => c.public_key.toLowerCase() === connectedPublicKey.toLowerCase())
    : null;
  pts.push(local && isValidLocation(local.lat, local.lon) ? [local.lat!, local.lon!] : null);
  // intermediate hops (skip the terminal 'local' node)
  for (const node of result.nodes) {
    if (node.role === 'local') continue;
    const c = node.public_key
      ? contacts.find((c2) => c2.public_key.toLowerCase() === node.public_key!.toLowerCase())
      : null;
    pts.push(c && isValidLocation(c.lat, c.lon) ? [c.lat!, c.lon!] : null);
  }
  // terminal = local again, skip (already have it conceptually)
  const segs: Pt[][] = [];
  let cur: Pt[] = [];
  for (const pt of pts) {
    if (pt !== null) {
      cur.push(pt);
    } else {
      if (cur.length >= 2) segs.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) segs.push(cur);
  return segs;
}

// ─── Packet visualization helpers ────────────────────────────────────────────

const THREE_DAYS_SEC = 3 * 24 * 60 * 60;
const PARTICLE_LIFETIME_MS = 3000;
const PARTICLE_TAIL_LENGTH = 0.25; // fraction of progress to trail behind
const PARTICLE_RADIUS = 8;
const PARTICLE_TAIL_WIDTH = 5;
const MAX_MAP_PARTICLES = 200;

interface MapParticle {
  id: number;
  path: [number, number][]; // lat/lon waypoints
  color: string;
  startedAt: number;
}

/** Resolve a hop token to a single contact with GPS, or null. */
function resolveHopToGps(hopToken: string, prefixIndex: Map<string, Contact[]>): Contact | null {
  const matches = prefixIndex.get(hopToken.toLowerCase());
  if (!matches || matches.length !== 1) return null;
  const c = matches[0];
  return isValidLocation(c.lat, c.lon) ? c : null;
}

/** Resolve a contact by display name (for GroupText senders). */
function resolveNameToGps(name: string, nameIndex: Map<string, Contact>): Contact | null {
  const c = nameIndex.get(name);
  if (!c) return null;
  return isValidLocation(c.lat, c.lon) ? c : null;
}

/** Collect public keys of all unambiguously resolved GPS-bearing contacts from a parsed packet. */
function resolvePacketContacts(
  parsed: ReturnType<typeof parsePacket>,
  prefixIndex: Map<string, Contact[]>,
  nameIndex: Map<string, Contact>,
  myLatLon: [number, number] | null,
  config?: RadioConfig | null
): Set<string> {
  const keys = new Set<string>();
  if (!parsed) return keys;

  // Source by pubkey prefix
  const sourcePrefixes = parsed.advertPubkey
    ? [parsed.advertPubkey.slice(0, 12).toLowerCase()]
    : parsed.srcHash
      ? [parsed.srcHash.toLowerCase()]
      : [];
  for (const prefix of sourcePrefixes) {
    const matches = prefixIndex.get(prefix);
    if (matches?.length === 1 && isValidLocation(matches[0].lat, matches[0].lon)) {
      keys.add(matches[0].public_key);
    }
  }

  // Source by name (GroupText sender)
  if (parsed.groupTextSender) {
    const c = resolveNameToGps(parsed.groupTextSender, nameIndex);
    if (c) keys.add(c.public_key);
  }

  // Intermediate hops
  for (const hop of parsed.pathBytes) {
    if (hop.length < 4) continue;
    const matches = prefixIndex.get(hop.toLowerCase());
    if (matches?.length === 1 && isValidLocation(matches[0].lat, matches[0].lon)) {
      keys.add(matches[0].public_key);
    }
  }

  // Self
  if (myLatLon && config?.public_key) {
    keys.add(config.public_key.toLowerCase());
  }

  // Destination
  if (parsed.dstHash) {
    const matches = prefixIndex.get(parsed.dstHash.toLowerCase());
    if (matches?.length === 1 && isValidLocation(matches[0].lat, matches[0].lon)) {
      keys.add(matches[0].public_key);
    }
  }

  return keys;
}

// ─── Canvas particle overlay ─────────────────────────────────────────────────

function ParticleOverlay({ particles }: { particles: MapParticle[] }) {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const container = map.getContainer();
    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '450'; // above tiles, below popups
    container.appendChild(canvas);
    canvasRef.current = canvas;

    const resize = () => {
      const size = map.getSize();
      canvas.width = size.x * window.devicePixelRatio;
      canvas.height = size.y * window.devicePixelRatio;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
    };
    resize();
    map.on('resize', resize);
    map.on('zoom', resize);

    return () => {
      cancelAnimationFrame(animRef.current);
      map.off('resize', resize);
      map.off('zoom', resize);
      container.removeChild(canvas);
      canvasRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const now = Date.now();
      const dpr = window.devicePixelRatio;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);

      for (const particle of particles) {
        const elapsed = now - particle.startedAt;
        if (elapsed < 0 || elapsed > PARTICLE_LIFETIME_MS) continue;
        const progress = elapsed / PARTICLE_LIFETIME_MS;
        const path = particle.path;
        if (path.length < 2) continue;

        // Calculate total path length in pixels for even speed
        const pixelPath = path.map((ll) => map.latLngToContainerPoint(L.latLng(ll[0], ll[1])));
        const segLengths: number[] = [];
        let totalLen = 0;
        for (let i = 1; i < pixelPath.length; i++) {
          const dx = pixelPath[i].x - pixelPath[i - 1].x;
          const dy = pixelPath[i].y - pixelPath[i - 1].y;
          const len = Math.sqrt(dx * dx + dy * dy);
          segLengths.push(len);
          totalLen += len;
        }
        if (totalLen === 0) continue;

        // Interpolate head position
        const headDist = progress * totalLen;
        const tailDist = Math.max(0, headDist - PARTICLE_TAIL_LENGTH * totalLen);

        const pointAtDist = (d: number): { x: number; y: number } => {
          let accum = 0;
          for (let i = 0; i < segLengths.length; i++) {
            if (accum + segLengths[i] >= d) {
              const t = segLengths[i] > 0 ? (d - accum) / segLengths[i] : 0;
              return {
                x: pixelPath[i].x + (pixelPath[i + 1].x - pixelPath[i].x) * t,
                y: pixelPath[i].y + (pixelPath[i + 1].y - pixelPath[i].y) * t,
              };
            }
            accum += segLengths[i];
          }
          const last = pixelPath[pixelPath.length - 1];
          return { x: last.x, y: last.y };
        };

        const head = pointAtDist(headDist);
        const tail = pointAtDist(tailDist);

        // Draw tail as a gradient line from transparent to opaque
        const grad = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
        grad.addColorStop(0, particle.color + '00');
        grad.addColorStop(1, particle.color + 'cc');
        ctx.beginPath();
        ctx.moveTo(tail.x, tail.y);

        // Sample intermediate points along the tail for curved paths
        const steps = 8;
        for (let s = 1; s <= steps; s++) {
          const d = tailDist + ((headDist - tailDist) * s) / steps;
          const pt = pointAtDist(d);
          ctx.lineTo(pt.x, pt.y);
        }
        ctx.strokeStyle = grad;
        ctx.lineWidth = PARTICLE_TAIL_WIDTH;
        ctx.lineCap = 'round';
        ctx.stroke();

        // Draw head blob with glow
        const fade = progress > 0.8 ? 1 - (progress - 0.8) / 0.2 : 1;
        const alpha = Math.round(fade * 230)
          .toString(16)
          .padStart(2, '0');
        // Outer glow
        ctx.beginPath();
        ctx.arc(head.x, head.y, PARTICLE_RADIUS + 4, 0, Math.PI * 2);
        ctx.fillStyle =
          particle.color +
          Math.round(fade * 40)
            .toString(16)
            .padStart(2, '0');
        ctx.fill();
        // Core blob
        ctx.beginPath();
        ctx.arc(head.x, head.y, PARTICLE_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = particle.color + alpha;
        ctx.shadowColor = particle.color;
        ctx.shadowBlur = 12 * fade;
        ctx.fill();
        ctx.shadowBlur = 0;
        // Bright center
        ctx.beginPath();
        ctx.arc(head.x, head.y, PARTICLE_RADIUS * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff' + alpha;
        ctx.fill();
      }

      ctx.restore();
      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [map, particles]);

  // Redraw on map move/zoom
  useEffect(() => {
    const redraw = () => {}; // Animation loop already redraws every frame
    map.on('move', redraw);
    map.on('zoom', redraw);
    return () => {
      map.off('move', redraw);
      map.off('zoom', redraw);
    };
  }, [map]);

  return null;
}

// ─── MapView ─────────────────────────────────────────────────────────────────

export function MapView({
  contacts,
  focusedKey,
  onSelectConversation,
  connectedPublicKey,
  onPathDiscovery,
  onRunTracePath,
  rawPackets,
  config: _config,
}: MapViewProps) {
  const now = useMemo(() => Math.floor(Date.now() / 1000), []);

  // ── Trace mode state ────────────────────────────────────────────────────────
  const [traceModeActive, setTraceModeActive] = useState(false);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [traceResult, setTraceResult] = useState<RadioTraceResponse | null>(null);
  const traceRunTokenRef = useRef(0);

  const { draftHops, effectiveHopHashBytes, addRepeater, removeHop, moveHopAt, clearHops } =
    useTraceBuilder();
  const traceHistory = useTraceHistory();
  // Manual override for trace hash width; null = auto from hop types (defaults to 4 = 4-byte)
  const [traceHashBytesOverride, setTraceHashBytesOverride] = useState<1 | 2 | 4 | null>(null);
  const activeTraceHashBytes: 1 | 2 | 4 = traceHashBytesOverride ?? effectiveHopHashBytes;

  // ── Time window presets ─────────────────────────────────────────────────────
  const TIME_PRESETS = [
    { label: '30m', seconds: 1800 },
    { label: '1h', seconds: 3600 },
    { label: '2h', seconds: 2 * 3600 },
    { label: '6h', seconds: 6 * 3600 },
    { label: '12h', seconds: 12 * 3600 },
    { label: '24h', seconds: 86400 },
    { label: '7d', seconds: 7 * 86400 },
    { label: '30d', seconds: 30 * 86400 },
  ] as const;

  const [activePreset, setActivePreset] = useState<string>('12h');

  // ── Custom time range ───────────────────────────────────────────────────────
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  const isCustomActive = activePreset === 'Custom';
  const customFromSec = useMemo(
    () => (customFrom ? Math.floor(new Date(customFrom).getTime() / 1000) : 0),
    [customFrom]
  );
  const customToSec = useMemo(
    () => (customTo ? Math.floor(new Date(customTo).getTime() / 1000) : now),
    [customTo, now]
  );

  const activeSeconds = isCustomActive
    ? null
    : (TIME_PRESETS.find((p) => p.label === activePreset)?.seconds ?? 7 * 86400);
  const effectiveStart = isCustomActive
    ? customFromSec
    : activeSeconds === null
      ? 0
      : now - activeSeconds;
  const effectiveEnd = isCustomActive ? customToSec : now;

  // ── Search ──────────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingSearchFocus, setPendingSearchFocus] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const searchLower = searchQuery.toLowerCase().trim();
  const searchResults = useMemo(() => {
    if (!searchLower) return [];
    return contacts
      .filter(
        (c) =>
          isValidLocation(c.lat, c.lon) &&
          (c.name?.toLowerCase().includes(searchLower) ||
            c.public_key.toLowerCase().startsWith(searchLower))
      )
      .slice(0, 8);
  }, [contacts, searchLower]);

  // ── Type toggles ────────────────────────────────────────────────────────────
  const [visibleTypes, setVisibleTypes] = useState<Record<ContactTypeKey, boolean>>({
    unknown: true,
    client: true,
    repeater: true,
    room: true,
    sensor: true,
  });
  const toggleType = (k: ContactTypeKey) => setVisibleTypes((p) => ({ ...p, [k]: !p[k] }));

  // ── Hash mode toggles ────────────────────────────────────────────────────────
  const [visibleHashModes, setVisibleHashModes] = useState<Record<HashModeKey, boolean>>({
    '1B': true,
    '2B': true,
    '3B': true,
  });
  const toggleHashMode = (k: HashModeKey) => setVisibleHashModes((p) => ({ ...p, [k]: !p[k] }));

  // ── Country filter ──────────────────────────────────────────────────────────
  const [selectedCountries, setSelectedCountries] = useState<Set<string>>(new Set());
  const toggleCountry = (code: string) =>
    setSelectedCountries((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  // ── Owned-only filter ───────────────────────────────────────────────────────
  const [showOwnedOnly, setShowOwnedOnly] = useState(() => {
    try {
      return localStorage.getItem('remoteterm-map-owned-only') === 'true';
    } catch {
      return false;
    }
  });
  const handleOwnedOnlyToggle = () =>
    setShowOwnedOnly((p) => {
      try {
        localStorage.setItem('remoteterm-map-owned-only', String(!p));
      } catch {
        /* ignore storage errors */
      }
      return !p;
    });

  // ── Cluster toggle ──────────────────────────────────────────────────────────
  const [clustered, setClustered] = useState(loadClusterPref);
  const handleClusterToggle = () =>
    setClustered((p) => {
      saveClusterPref(!p);
      return !p;
    });

  // ── Heatmap toggle ──────────────────────────────────────────────────────────
  const [heatmap, setHeatmap] = useState(false);

  // ── Tile layer ──────────────────────────────────────────────────────────────
  const [tileKey, setTileKey] = useState<TileLayerKey>(loadTilePref);
  const prevNonDarkTileRef = useRef<TileLayerKey>(tileKey !== 'dark' ? tileKey : 'osm');
  const handleTileChange = (key: TileLayerKey) => {
    if (key !== 'dark') prevNonDarkTileRef.current = key;
    setTileKey(key);
    saveTilePref(key);
  };

  // ── Dark map sync with settings (localStorage: remoteterm-dark-map) ────────
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'remoteterm-dark-map') {
        if (e.newValue === 'true') {
          if (tileKey !== 'dark') prevNonDarkTileRef.current = tileKey;
          setTileKey('dark');
          saveTilePref('dark');
        } else {
          const restoreTo = prevNonDarkTileRef.current;
          setTileKey(restoreTo);
          saveTilePref(restoreTo);
        }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [tileKey]);

  // ── Packet visualization state ──────────────────────────────────────────────
  const [showPackets, setShowPackets] = useState(false);
  const [discoveryMode, setDiscoveryMode] = useState(false);
  const [discoveredKeys, setDiscoveredKeys] = useState<Set<string>>(new Set());
  const [particles, setParticles] = useState<MapParticle[]>([]);
  const particleIdRef = useRef(0);
  const seenObservationsRef = useRef(new Set<string>());

  // Build prefix index and name index for hop resolution
  const { prefixIndex, nameIndex } = useMemo(() => {
    const prefix = new Map<string, Contact[]>();
    const name = new Map<string, Contact>();
    for (const c of contacts) {
      const pubkey = c.public_key.toLowerCase();
      for (let len = 1; len <= 12 && len <= pubkey.length; len++) {
        const p = pubkey.slice(0, len);
        const arr = prefix.get(p);
        if (arr) arr.push(c);
        else prefix.set(p, [c]);
      }
      if (c.name && !name.has(c.name)) name.set(c.name, c);
    }
    return { prefixIndex: prefix, nameIndex: name };
  }, [contacts]);

  // ── Country map — public_key → CountryInfo | null ───────────────────────────
  // Computed once from all contacts with valid GPS; instant (no network).
  const contactCountryMap = useMemo(() => {
    const map = new Map<string, CountryInfo | null>();
    for (const c of contacts) {
      if (isValidLocation(c.lat, c.lon)) {
        map.set(c.public_key, getCountryFromCoords(c.lat!, c.lon!));
      }
    }
    return map;
  }, [contacts]);

  // Self GPS
  const myLatLon = useMemo<[number, number] | null>(() => {
    if (!_config || !isValidLocation(_config.lat, _config.lon)) return null;
    return [_config.lat, _config.lon];
  }, [_config]);

  // Determine time window for packet visualization
  const threeDaysAgoSec = useMemo(() => Date.now() / 1000 - THREE_DAYS_SEC, []);

  // ── Contacts ref — kept current without triggering re-renders ────────────
  const contactsRef = useRef<import('../types').Contact[]>(contacts);
  contactsRef.current = contacts;

  // Resolve a path of hop tokens to geographic waypoints.
  // Prefers the source contact's stored direct_path (validated by the server) over
  // re-resolving raw packet hash bytes, which gives a more accurate route and avoids
  // the "crow flies" effect when intermediate nodes lack GPS.
  const resolvePacketPath = useCallback(
    (parsed: ReturnType<typeof parsePacket>): [number, number][] | null => {
      if (!parsed) return null;

      type Pt = [number, number];

      // ── Resolve source contact ──────────────────────────────────────────
      let sourceContact: Contact | null = null;
      if (parsed.advertPubkey) {
        const prefix = parsed.advertPubkey.slice(0, 12).toLowerCase();
        const matches = prefixIndex.get(prefix);
        if (matches?.length === 1) sourceContact = matches[0];
      } else if (parsed.srcHash) {
        const matches = prefixIndex.get(parsed.srcHash.toLowerCase());
        if (matches?.length === 1) sourceContact = matches[0];
      } else if (parsed.groupTextSender) {
        sourceContact = nameIndex.get(parsed.groupTextSender) ?? null;
      }

      // ── Try stored direct_path from source contact first ─────────────────
      if (sourceContact?.direct_path && (sourceContact.direct_path_len ?? 0) > 0) {
        const allPts: (Pt | null)[] = [];

        // Self (our radio) at the near end
        if (myLatLon) allPts.push(myLatLon);

        // Intermediate hops from stored path (stored away-from-us, so reverse)
        const hopPrefixes = parsePathHops(
          sourceContact.direct_path,
          sourceContact.direct_path_len!
        );
        for (const prefix of [...hopPrefixes].reverse()) {
          const matches = findContactsByPrefix(prefix, contactsRef.current, true);
          allPts.push(
            matches.length === 1 && isValidLocation(matches[0].lat, matches[0].lon)
              ? [matches[0].lat!, matches[0].lon!]
              : null
          );
        }

        // Source at the far end
        if (isValidLocation(sourceContact.lat, sourceContact.lon)) {
          allPts.push([sourceContact.lat!, sourceContact.lon!]);
        }

        // Build connected segments from runs of non-null points
        const segments: Pt[][] = [];
        let cur: Pt[] = [];
        for (const pt of allPts) {
          if (pt) cur.push(pt);
          else {
            if (cur.length >= 2) segments.push(cur);
            cur = [];
          }
        }
        if (cur.length >= 2) segments.push(cur);

        if (segments.length > 0) {
          const waypoints = segments.flat();
          const deduped = dedupeConsecutive(waypoints.map((w) => `${w[0]},${w[1]}`));
          if (deduped.length >= 2) {
            return deduped.map((s) => {
              const [lat, lon] = s.split(',').map(Number);
              return [lat, lon] as Pt;
            });
          }
        }
      }

      // ── Fallback: resolve from raw packet path bytes ──────────────────────
      const waypoints: Pt[] = [];

      if (sourceContact && isValidLocation(sourceContact.lat, sourceContact.lon)) {
        waypoints.push([sourceContact.lat!, sourceContact.lon!]);
      }

      // Intermediate hops (path bytes) — skip 1-byte hops to avoid ambiguity
      for (const hop of parsed.pathBytes) {
        if (hop.length < 4) continue;
        const contact = resolveHopToGps(hop, prefixIndex);
        if (contact) waypoints.push([contact.lat!, contact.lon!]);
      }

      // Destination: self (our radio), or dstHash
      if (myLatLon) {
        waypoints.push(myLatLon);
      } else if (parsed.dstHash) {
        const dest = resolveHopToGps(parsed.dstHash, prefixIndex);
        if (dest) waypoints.push([dest.lat!, dest.lon!]);
      }

      const deduped = dedupeConsecutive(waypoints.map((w) => `${w[0]},${w[1]}`));
      if (deduped.length < 2) return null;

      return deduped.map((s) => {
        const [lat, lon] = s.split(',').map(Number);
        return [lat, lon] as Pt;
      });
    },
    [prefixIndex, nameIndex, myLatLon, contactsRef]
  );

  // Process new packets into particles and track discovered contacts
  useEffect(() => {
    if (!showPackets || !rawPackets?.length) return;

    const nowMs = Date.now();
    const newParticles: MapParticle[] = [];
    const newDiscovered = new Set<string>();

    for (const pkt of rawPackets) {
      // Skip old packets
      if (pkt.timestamp < threeDaysAgoSec) continue;

      // Deduplicate by observation
      const obsKey = getRawPacketObservationKey(pkt);
      if (seenObservationsRef.current.has(obsKey)) continue;

      const parsed = parsePacket(pkt.data);
      if (!parsed) continue;

      // Discover contacts from this packet regardless of whether a full path resolves
      const resolvedContacts = resolvePacketContacts(
        parsed,
        prefixIndex,
        nameIndex,
        myLatLon,
        _config
      );
      const path = resolvePacketPath(parsed);

      // Only mark as seen if we got something useful; otherwise a later run
      // with updated contacts/config can retry this observation.
      if (resolvedContacts.size === 0 && !path) continue;
      seenObservationsRef.current.add(obsKey);

      for (const key of resolvedContacts) newDiscovered.add(key);

      if (path) {
        newParticles.push({
          id: particleIdRef.current++,
          path,
          color: PARTICLE_COLOR_MAP[getPacketLabel(parsed.payloadType)],
          startedAt: nowMs,
        });
      }
    }

    if (newDiscovered.size > 0) {
      setDiscoveredKeys((prev) => {
        const next = new Set(prev);
        for (const k of newDiscovered) next.add(k);
        return next.size !== prev.size ? next : prev;
      });
    }

    if (newParticles.length === 0) return;

    setParticles((prev) => {
      const combined = [...prev, ...newParticles];
      // Prune expired and cap total
      const alive = combined.filter((p) => nowMs - p.startedAt < PARTICLE_LIFETIME_MS);
      return alive.slice(-MAX_MAP_PARTICLES);
    });
  }, [
    rawPackets,
    showPackets,
    resolvePacketPath,
    threeDaysAgoSec,
    prefixIndex,
    nameIndex,
    myLatLon,
    _config,
  ]);

  // Prune expired particles periodically
  useEffect(() => {
    if (!showPackets) return;
    const interval = setInterval(() => {
      const nowMs = Date.now();
      setParticles((prev) => prev.filter((p) => nowMs - p.startedAt < PARTICLE_LIFETIME_MS));
    }, 1000);
    return () => clearInterval(interval);
  }, [showPackets]);

  // Reset discovered set when exiting discovery mode
  useEffect(() => {
    if (!discoveryMode) setDiscoveredKeys(new Set());
  }, [discoveryMode]);

  // Clear state when toggling off
  useEffect(() => {
    if (!showPackets) {
      setParticles([]);
      setDiscoveredKeys(new Set());
      setDiscoveryMode(false);
      seenObservationsRef.current.clear();
    }
  }, [showPackets]);

  // Gather unique link paths for static route lines when packet viz is on
  const routeLines = useMemo(() => {
    if (!showPackets) return [];
    const seen = new Set<string>();
    const lines: { path: [number, number][]; color: string }[] = [];
    for (const p of particles) {
      const key = p.path.map((w) => `${w[0]},${w[1]}`).join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({ path: p.path, color: p.color });
    }
    return lines;
  }, [showPackets, particles]);

  // ── Filtered contacts ───────────────────────────────────────────────────────
  // Phase 1: all filters except country — used to build the country button list
  const baseFilteredContacts = useMemo(() => {
    if (showPackets && discoveryMode) {
      return contacts.filter(
        (c) => isValidLocation(c.lat, c.lon) && discoveredKeys.has(c.public_key)
      );
    }
    return contacts.filter((c) => {
      if (!isValidLocation(c.lat, c.lon)) return false;
      if (c.public_key === focusedKey) return true;
      if (c.last_seen == null || c.last_seen < effectiveStart || c.last_seen > effectiveEnd)
        return false;
      if (showPackets && c.last_seen < threeDaysAgoSec) return false;
      if (showOwnedOnly && !(OWNER_CAPABLE_TYPES.has(c.type) && c.owner_id)) return false;
      if (!visibleTypes[getTypeKey(c.type)]) return false;
      const hmKey = getContactHashModeKeyForFilter(c);
      const allHashModesEnabled = ALL_HASH_MODE_KEYS.every((k) => visibleHashModes[k]);
      if (!allHashModesEnabled && !visibleHashModes[hmKey]) return false;
      return true;
    });
  }, [
    contacts,
    focusedKey,
    effectiveStart,
    effectiveEnd,
    visibleTypes,
    visibleHashModes,
    showOwnedOnly,
    showPackets,
    discoveryMode,
    discoveredKeys,
    threeDaysAgoSec,
  ]);

  // Countries present among the time/type-filtered contacts, sorted alphabetically
  const availableCountries = useMemo(() => {
    const counts = new Map<string, { info: CountryInfo; count: number }>();
    for (const c of baseFilteredContacts) {
      const info = contactCountryMap.get(c.public_key);
      if (!info) continue;
      const existing = counts.get(info.code);
      if (existing) existing.count++;
      else counts.set(info.code, { info, count: 1 });
    }
    return Array.from(counts.values()).sort((a, b) =>
      a.info.name.localeCompare(b.info.name)
    );
  }, [baseFilteredContacts, contactCountryMap]);

  // Drop selected countries that have left the current timeframe window
  useEffect(() => {
    if (selectedCountries.size === 0) return;
    const available = new Set(availableCountries.map((c) => c.info.code));
    const stale = [...selectedCountries].filter((code) => !available.has(code));
    if (stale.length > 0) {
      setSelectedCountries((prev) => {
        const next = new Set(prev);
        stale.forEach((code) => next.delete(code));
        return next;
      });
    }
  }, [availableCountries, selectedCountries]);

  // Phase 2: apply country filter on top
  const mappableContacts = useMemo(() => {
    if (selectedCountries.size === 0) return baseFilteredContacts;
    return baseFilteredContacts.filter((c) => {
      const country = contactCountryMap.get(c.public_key);
      return country != null && selectedCountries.has(country.code);
    });
  }, [baseFilteredContacts, selectedCountries, contactCountryMap]);

  const focusedContact = useMemo(
    () => (focusedKey ? (mappableContacts.find((c) => c.public_key === focusedKey) ?? null) : null),
    [focusedKey, mappableContacts]
  );

  // ── Advert health warnings (for map highlight rings) ─────────────────────
  const [advertWarnings, setAdvertWarnings] = useState<Map<string, HealthLevel>>(new Map());
  useEffect(() => {
    const doFetch = () => {
      fetch('/api/packets/advert-warnings')
        .then(
          (r) => r.json() as Promise<{ warnings: Array<{ public_key: string; level: string }> }>
        )
        .then((d) => {
          const m = new Map<string, HealthLevel>();
          for (const w of d.warnings ?? []) {
            m.set(w.public_key, w.level as HealthLevel);
          }
          setAdvertWarnings(m);
        })
        .catch(() => {
          /* non-critical */
        });
    };
    doFetch();
    const id = setInterval(doFetch, 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Heatmap data — intensity based on packet heard count ─────────────────
  const [heatRawData, setHeatRawData] = useState<{ lat: number; lon: number; count: number }[]>([]);
  const [heatLoading, setHeatLoading] = useState(false);

  useEffect(() => {
    if (!heatmap) return;
    setHeatLoading(true);
    fetch('/api/contacts/heatmap')
      .then((r) => r.json())
      .then((data) => {
        setHeatRawData(data);
        setHeatLoading(false);
      })
      .catch(() => setHeatLoading(false));
  }, [heatmap]);

  const heatPoints = useMemo((): HeatPoint[] => {
    if (!heatmap || !heatRawData.length) return [];
    const maxCount = Math.max(...heatRawData.map((d) => d.count), 1);
    // Filter to only contacts in the current time window + type filter
    const mappableKeys = new Set(mappableContacts.map((c) => `${c.lat},${c.lon}`));
    return heatRawData
      .filter((d) => mappableKeys.has(`${d.lat},${d.lon}`))
      .map((d) => ({
        lat: d.lat,
        lon: d.lon,
        intensity: Math.max(0.05, d.count / maxCount),
      }));
  }, [heatmap, heatRawData, mappableContacts]);

  // ── Path trace overlay ──────────────────────────────────────────────────────
  // Segments of GPS points to draw as a Polyline over the main map
  type PathSegment = [number, number][];
  const [activePathTrace, setActivePathTrace] = useState<{
    contactKey: string;
    segments: PathSegment[];
  } | null>(null);

  const handleShowPathOnMap = useCallback((contactKey: string, segments: PathSegment[]) => {
    setActivePathTrace(segments.length > 0 ? { contactKey, segments } : null);
  }, []);

  // ── Marker refs ─────────────────────────────────────────────────────────────
  const markerRefs = useRef<Record<string, L.Marker | null>>({});
  const setMarkerRef = useCallback((key: string, ref: L.Marker | null) => {
    if (ref === null) {
      delete markerRefs.current[key];
      return;
    }
    markerRefs.current[key] = ref;
  }, []);

  useEffect(() => {
    const currentKeys = new Set(mappableContacts.map((c) => c.public_key));
    for (const key of Object.keys(markerRefs.current)) {
      if (!currentKeys.has(key)) {
        delete markerRefs.current[key];
      }
    }
  }, [mappableContacts]);

  // Open popup for focused contact after map is ready
  useEffect(() => {
    if (focusedContact) {
      const timer = setTimeout(
        () => markerRefs.current[focusedContact.public_key]?.openPopup(),
        100
      );
      return () => clearTimeout(timer);
    }
  }, [focusedContact]);

  const openPopup = useCallback((publicKey: string) => {
    // Delay to let flyTo animation start before opening the popup
    setTimeout(() => markerRefs.current[publicKey]?.openPopup(), 400);
  }, []);

  // ── Map trace execution ──────────────────────────────────────────────────────
  const handleRunMapTrace = useCallback(async () => {
    if (!onRunTracePath || draftHops.length === 0) return;
    const token = ++traceRunTokenRef.current;
    setTraceLoading(true);
    setTraceError(null);
    setTraceResult(null);
    try {
      const result = await onRunTracePath(
        activeTraceHashBytes,
        draftHops.map((h) =>
          h.kind === 'repeater' ? { public_key: h.publicKey } : { hop_hex: h.hopHex }
        )
      );
      if (traceRunTokenRef.current !== token) return;
      setTraceResult(result);
      traceHistory.addEntry({
        draftHops: [...draftHops],
        result,
        hopHashBytes: activeTraceHashBytes,
      });
      const segments = buildTraceSegments(result, contactsRef.current, connectedPublicKey);
      if (segments.length > 0) setActivePathTrace({ contactKey: `trace-${token}`, segments });
    } catch (err) {
      if (traceRunTokenRef.current !== token) return;
      setTraceError(err instanceof Error ? err.message : 'Trace failed');
    } finally {
      if (traceRunTokenRef.current === token) setTraceLoading(false);
    }
  }, [
    onRunTracePath,
    draftHops,
    activeTraceHashBytes,
    traceHistory,
    contactsRef,
    connectedPublicKey,
  ]);

  // ── Update marker icons imperatively (avoids cluster clearLayers on advert-warning changes) ─
  useEffect(() => {
    for (const contact of mappableContacts) {
      const marker = markerRefs.current[contact.public_key];
      if (!marker) continue;
      const typeKey = getTypeKey(contact.type);
      const cfg = CONTACT_TYPE_CONFIG[typeKey];
      const color = getMarkerColor(contact.last_seen);
      const focused = contact.public_key === focusedKey;
      const health = advertWarnings.get(contact.public_key) ?? null;
      marker.setIcon(buildIcon(cfg.emoji, color, focused, health, cfg.small ?? false));
    }
  }, [advertWarnings, mappableContacts, focusedKey]);

  const isFullRange = activePreset === 'All' || (isCustomActive && !customFrom);
  const activeTypeCount = ALL_TYPE_KEYS.filter((k) => visibleTypes[k]).length;
  const activeHashModeCount = ALL_HASH_MODE_KEYS.filter((k) => visibleHashModes[k]).length;

  // Stable key — only changes when the identity/position/type of the marker set changes,
  // NOT when last_seen, name, notes, owner_id etc. change. This prevents MarkerClusterGroup
  // from calling clearLayers() (which closes open popups) on routine data updates.
  const mappableKey = useMemo(
    () =>
      mappableContacts
        .map((c) => `${c.public_key}:${c.lat?.toFixed(4)}:${c.lon?.toFixed(4)}:${c.type}`)
        .join('|'),
    [mappableContacts]
  );

  const markerElements = useMemo(
    () =>
      mappableContacts.map((contact) => {
        const typeKey = getTypeKey(contact.type);
        const cfg = CONTACT_TYPE_CONFIG[typeKey];
        const color = getMarkerColor(contact.last_seen);
        const focused = contact.public_key === focusedKey;
        // Initial icon — health rings applied imperatively via useEffect above
        const icon = buildIcon(cfg.emoji, color, focused, null, cfg.small ?? false);
        const displayName = contact.name || contact.public_key.slice(0, 12);
        const lastHeardLabel =
          contact.last_seen != null ? formatTime(contact.last_seen) : 'Never heard by this server';

        // In trace mode, clicking a repeater adds it as a hop (no popup)
        if (traceModeActive && contact.type === CONTACT_TYPE_REPEATER) {
          return (
            <Marker
              key={contact.public_key}
              ref={(ref) => setMarkerRef(contact.public_key, ref)}
              position={[contact.lat!, contact.lon!]}
              icon={icon}
              eventHandlers={{ click: () => addRepeater(contact.public_key) }}
            />
          );
        }

        return (
          <Marker
            key={contact.public_key}
            ref={(ref) => setMarkerRef(contact.public_key, ref)}
            position={[contact.lat!, contact.lon!]}
            icon={icon}
          >
            <Popup autoPan={false}>
              <MapPopupContent
                contact={contact}
                contactsRef={contactsRef}
                cfg={cfg}
                displayName={displayName}
                lastHeardLabel={lastHeardLabel}
                health={null}
                onSelectConversation={onSelectConversation}
                onOpenPopup={openPopup}
                onShowPathOnMap={handleShowPathOnMap}
                connectedPublicKey={connectedPublicKey}
                onPathDiscovery={onPathDiscovery}
              />
            </Popup>
          </Marker>
        );
        // Only recompute when marker identities/positions/types change (not data-only updates)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      mappableKey,
      focusedKey,
      onSelectConversation,
      openPopup,
      setMarkerRef,
      onPathDiscovery,
      traceModeActive,
      addRepeater,
    ]
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* Info bar + recency legend */}
      <div className="px-4 py-2 bg-muted/50 text-xs text-muted-foreground flex items-center justify-between flex-wrap gap-2">
        <span>
          {showPackets && discoveryMode ? (
            `${mappableContacts.length} node${mappableContacts.length !== 1 ? 's' : ''} discovered from live traffic`
          ) : (
            <>
              Showing {mappableContacts.length} contact{mappableContacts.length !== 1 ? 's' : ''}
              {isFullRange
                ? ' (all time)'
                : isCustomActive
                  ? ` · custom range`
                  : ` · last ${activePreset}`}
              {showPackets ? ' · 3-day packet window' : ''}
              {activeTypeCount < ALL_TYPE_KEYS.length
                ? ` · ${activeTypeCount}/${ALL_TYPE_KEYS.length} types`
                : ''}
              {activeHashModeCount < ALL_HASH_MODE_KEYS.length
                ? ` · ${activeHashModeCount}/${ALL_HASH_MODE_KEYS.length} modes`
                : ''}
              {selectedCountries.size > 0
                ? ` · ${selectedCountries.size}/${availableCountries.length} countr${selectedCountries.size === 1 ? 'y' : 'ies'}`
                : ''}
              {heatmap ? ' · heatmap' : ''}
              {heatmap && heatLoading ? ' · loading…' : ''}
              {activePathTrace && (
                <span>
                  {' · '}
                  <span className="text-cyan-400">path overlay active</span>{' '}
                  <button
                    onClick={() => setActivePathTrace(null)}
                    className="underline text-muted-foreground hover:text-foreground transition"
                  >
                    clear
                  </button>
                </span>
              )}
            </>
          )}
        </span>
        <div className="flex items-center gap-3">
          {!showPackets && !heatmap && (
            <>
              {(
                [
                  { label: '<1h', color: MAP_RECENCY_COLORS.recent },
                  { label: '<1d', color: MAP_RECENCY_COLORS.today },
                  { label: '<3d', color: MAP_RECENCY_COLORS.stale },
                  { label: 'older', color: MAP_RECENCY_COLORS.old },
                ] as const
              ).map(({ label, color }) => (
                <span key={label} className="flex items-center gap-1">
                  <span
                    className="w-2.5 h-2.5 rounded-full inline-block border border-[#0f172a]"
                    style={{ backgroundColor: color }}
                  />
                  {label}
                </span>
              ))}
            </>
          )}
          {showPackets && (
            <>
              <span className="flex items-center gap-1">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: PARTICLE_COLOR_MAP['AD'] }}
                  aria-hidden="true"
                />
                Ad
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: PARTICLE_COLOR_MAP['GT'] }}
                  aria-hidden="true"
                />
                Ch
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: PARTICLE_COLOR_MAP['DM'] }}
                  aria-hidden="true"
                />
                DM
              </span>
              <span className="flex items-center gap-1">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: PARTICLE_COLOR_MAP['ACK'] }}
                  aria-hidden="true"
                />
                ACK
              </span>
            </>
          )}
          {heatmap && (
            <div className="flex items-center gap-1.5 text-[10px]">
              <span>Low</span>
              <span
                className="w-20 h-2 rounded"
                style={{
                  background:
                    'linear-gradient(to right, #0ea5e9, #22c55e, #eab308, #f97316, #ef4444)',
                }}
              />
              <span>High</span>
            </div>
          )}
        </div>
      </div>

      {/* Type toggles + cluster + heatmap buttons */}
      <div className="px-4 py-2 bg-muted/30 border-b border-border flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">
          Show:
        </span>
        {ALL_TYPE_KEYS.map((key) => {
          const cfg = CONTACT_TYPE_CONFIG[key];
          const active = visibleTypes[key];
          const count = contacts.filter(
            (c) =>
              isValidLocation(c.lat, c.lon) &&
              c.public_key !== focusedKey &&
              c.last_seen != null &&
              c.last_seen >= effectiveStart &&
              c.last_seen <= effectiveEnd &&
              getTypeKey(c.type) === key
          ).length;
          return (
            <button
              key={key}
              onClick={() => toggleType(key)}
              title={`${active ? 'Hide' : 'Show'} ${cfg.label} (${count})`}
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors border ${
                active
                  ? 'bg-primary/10 border-primary/40 text-foreground'
                  : 'bg-muted border-border text-muted-foreground opacity-50'
              }`}
            >
              <span className="text-base leading-none">{cfg.emoji}</span>
              <span>{cfg.label}</span>
              <span className="tabular-nums text-[10px] text-muted-foreground">{count}</span>
            </button>
          );
        })}
        {activeTypeCount < ALL_TYPE_KEYS.length && (
          <button
            onClick={() =>
              setVisibleTypes({
                unknown: true,
                client: true,
                repeater: true,
                room: true,
                sensor: true,
              })
            }
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            Show all
          </button>
        )}

        {/* Hash mode toggles */}
        <div className="flex items-center gap-1 border-l border-border pl-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-0.5">
            Hops:
          </span>
          {ALL_HASH_MODE_KEYS.map((key) => {
            const cfg = HASH_MODE_CONFIG[key];
            const active = visibleHashModes[key];
            const count = contacts.filter(
              (c) =>
                isValidLocation(c.lat, c.lon) &&
                c.public_key !== focusedKey &&
                c.last_seen != null &&
                c.last_seen >= effectiveStart &&
                c.last_seen <= effectiveEnd &&
                getContactHashModeKeyForFilter(c) === key
            ).length;
            return (
              <button
                key={key}
                onClick={() => toggleHashMode(key)}
                title={`${active ? 'Hide' : 'Show'} ${cfg.label} nodes (${count})`}
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono transition-colors border ${
                  active
                    ? 'bg-primary/10 border-primary/40 text-foreground'
                    : 'bg-muted border-border text-muted-foreground opacity-50'
                }`}
              >
                <span>{cfg.label}</span>
                <span className="tabular-nums text-[10px] text-muted-foreground">{count}</span>
              </button>
            );
          })}
          {activeHashModeCount < ALL_HASH_MODE_KEYS.length && (
            <button
              onClick={() => setVisibleHashModes({ '1B': true, '2B': true, '3B': true })}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              all
            </button>
          )}
        </div>

        {/* Country filter — only shown when >1 country is present */}
        {availableCountries.length > 1 && (
          <div className="flex items-center gap-1 border-l border-border pl-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-0.5">
              Country:
            </span>
            {availableCountries.map(({ info, count }) => {
              const active = selectedCountries.size === 0 || selectedCountries.has(info.code);
              return (
                <button
                  key={info.code}
                  onClick={() => toggleCountry(info.code)}
                  title={`${active && selectedCountries.size > 0 ? 'Hide' : 'Show only'} ${info.name} (${count})`}
                  className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs transition-colors border ${
                    active
                      ? 'bg-primary/10 border-primary/40 text-foreground'
                      : 'bg-muted border-border text-muted-foreground opacity-50'
                  }`}
                >
                  <FlagEmoji flag={info.flag} size="1.15em" />
                  <span className="tabular-nums text-[10px] text-muted-foreground">{count}</span>
                </button>
              );
            })}
            {selectedCountries.size > 0 && (
              <button
                onClick={() => setSelectedCountries(new Set())}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                all
              </button>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Packet visualization controls */}
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={showPackets}
            onChange={(e) => setShowPackets(e.target.checked)}
            className="rounded border-border"
          />
          <span className="text-[0.6875rem]">Visualize packets</span>
        </label>
        {showPackets && (
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={discoveryMode}
              onChange={(e) => setDiscoveryMode(e.target.checked)}
              className="rounded border-border"
            />
            <span className="text-[0.6875rem]">Discover nodes</span>
          </label>
        )}

        {/* Trace mode toggle */}
        <button
          onClick={() => {
            setTraceModeActive((p) => !p);
            if (traceModeActive) {
              clearHops();
              setTraceError(null);
              setTraceResult(null);
            }
          }}
          title={
            traceModeActive
              ? 'Exit trace mode'
              : 'Enter trace mode: click repeaters to build a path'
          }
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors border ${
            traceModeActive
              ? 'bg-primary border-primary text-primary-foreground'
              : 'bg-muted border-border text-muted-foreground'
          }`}
        >
          <Cable className="h-3 w-3" />
          <span>Trace</span>
        </button>

        {/* Cluster toggle — hidden in heatmap mode */}
        {!heatmap && (
          <button
            onClick={handleClusterToggle}
            title={clustered ? 'Disable clustering' : 'Enable clustering'}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors border ${
              clustered
                ? 'bg-primary/10 border-primary/40 text-foreground'
                : 'bg-muted border-border text-muted-foreground'
            }`}
          >
            <span className="text-base leading-none">🗂️</span>
            <span>Cluster</span>
          </button>
        )}

        {/* Heatmap toggle */}
        <button
          onClick={() => setHeatmap((p) => !p)}
          title={heatmap ? 'Switch to markers' : 'Switch to heatmap'}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors border ${
            heatmap
              ? 'bg-primary/10 border-primary/40 text-foreground'
              : 'bg-muted border-border text-muted-foreground'
          }`}
        >
          <span className="text-base leading-none">🌡️</span>
          <span>Heatmap</span>
        </button>

        {/* Owned-only filter */}
        <button
          onClick={handleOwnedOnlyToggle}
          title={showOwnedOnly ? 'Show all nodes' : 'Show only owned repeaters & rooms'}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors border ${
            showOwnedOnly
              ? 'bg-primary/10 border-primary/40 text-foreground'
              : 'bg-muted border-border text-muted-foreground'
          }`}
        >
          <span className="text-base leading-none">🏠</span>
          <span>Owned</span>
        </button>

        {/* Tile layer picker */}
        <div className="flex items-center gap-1 ml-1 border-l border-border pl-2">
          {(Object.keys(TILE_LAYERS) as TileLayerKey[]).map((key) => (
            <button
              key={key}
              onClick={() => handleTileChange(key)}
              title={TILE_LAYERS[key].label}
              className={`px-2 py-0.5 text-[10px] rounded transition-colors border ${
                tileKey === key
                  ? 'bg-primary/10 border-primary/40 text-foreground font-medium'
                  : 'bg-muted border-border text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              {TILE_LAYERS[key].label}
            </button>
          ))}
        </div>

        {/* Node search */}
        <div className="relative flex items-center gap-1 border-l border-border pl-2">
          <Search className="h-3 w-3 text-muted-foreground flex-shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search nodes…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-28 bg-transparent text-[10px] outline-none placeholder:text-muted-foreground/50 text-foreground"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
          {/* Search results dropdown */}
          {searchLower && searchResults.length > 0 && (
            <div className="absolute top-full left-0 mt-1 z-[1000] bg-popover border border-border rounded shadow-lg w-52 max-h-48 overflow-y-auto">
              {searchResults.map((c) => {
                const typeKey = getTypeKey(c.type);
                const cfg = CONTACT_TYPE_CONFIG[typeKey];
                return (
                  <button
                    key={c.public_key}
                    className="w-full px-2.5 py-1.5 text-left text-xs hover:bg-accent flex items-center gap-2 transition-colors"
                    onClick={() => {
                      setSearchQuery('');
                      setPendingSearchFocus(c.public_key);
                    }}
                  >
                    <span className="text-sm leading-none flex-shrink-0">{cfg.emoji}</span>
                    <span className="truncate">{c.name ?? c.public_key.slice(0, 16)}</span>
                  </button>
                );
              })}
            </div>
          )}
          {searchLower && searchResults.length === 0 && (
            <span className="absolute top-full left-0 mt-1 z-[1000] bg-popover border border-border rounded shadow px-3 py-1.5 text-[10px] text-muted-foreground whitespace-nowrap">
              No nodes found
            </span>
          )}
        </div>
      </div>

      {/* Time window presets */}
      <div className="px-4 py-2 bg-muted/30 border-b border-border flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">
          Period:
        </span>
        {TIME_PRESETS.map(({ label }) => (
          <button
            key={label}
            onClick={() => {
              setActivePreset(label);
              setShowCustom(false);
            }}
            className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
              activePreset === label
                ? 'bg-primary text-primary-foreground font-medium'
                : 'bg-background border border-border text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => {
            setActivePreset('Custom');
            setShowCustom(true);
          }}
          className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
            activePreset === 'Custom'
              ? 'bg-primary text-primary-foreground font-medium'
              : 'bg-background border border-border text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
        >
          Custom…
        </button>

        {/* Custom date inputs — visible when Custom is active */}
        {showCustom && (
          <div className="flex items-center gap-1.5 ml-1 flex-wrap">
            <span className="text-[10px] text-muted-foreground">From:</span>
            <input
              type="datetime-local"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="text-[10px] rounded border border-border bg-background px-1.5 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <span className="text-[10px] text-muted-foreground">To:</span>
            <input
              type="datetime-local"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="text-[10px] rounded border border-border bg-background px-1.5 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        )}
      </div>

      {/* Trace Builder panel — shown only when trace mode is active */}
      {traceModeActive && (
        <div className="px-4 py-2 bg-muted/20 border-b border-border text-xs">
          <div className="font-medium text-foreground mb-1.5">
            🔌 Trace Builder — Click 🗼 repeaters on the map to add hops
          </div>
          <div className="space-y-1 mb-2">
            <div className="text-muted-foreground">Local radio →</div>
            {draftHops.length === 0 ? (
              <div className="text-muted-foreground italic">
                No hops yet. Click a repeater on the map.
              </div>
            ) : (
              draftHops.map((hop, index) => {
                const contact =
                  hop.kind === 'repeater'
                    ? (contacts.find((c) => c.public_key === hop.publicKey) ?? null)
                    : null;
                const label =
                  hop.kind === 'repeater'
                    ? (contact?.name ?? hop.publicKey.slice(0, 12))
                    : `Custom: ${hop.hopHex.toUpperCase()}`;
                return (
                  <div key={hop.id} className="flex items-center gap-1.5">
                    <span className="text-muted-foreground shrink-0">Hop {index + 1}:</span>
                    <span className="font-mono truncate text-foreground">{label}</span>
                    <button
                      onClick={() => moveHopAt(index, -1)}
                      disabled={index === 0}
                      className="px-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveHopAt(index, 1)}
                      disabled={index === draftHops.length - 1}
                      className="px-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                      title="Move down"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => removeHop(hop.id)}
                      className="px-1 text-muted-foreground hover:text-destructive"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                );
              })
            )}
            <div className="text-muted-foreground">→ Local radio</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Address width selector — 1-byte/2-byte/3-byte (protocol values 1/2/4) */}
            <span className="text-muted-foreground text-[10px]">Width:</span>
            {[
              { label: '1-byte', value: 1 as const },
              { label: '2-byte', value: 2 as const },
              { label: '4-byte', value: 4 as const },
            ].map(({ label, value }) => (
              <button
                key={value}
                onClick={() =>
                  setTraceHashBytesOverride(traceHashBytesOverride === value ? null : value)
                }
                title={`Use ${label} hop addresses`}
                className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                  activeTraceHashBytes === value
                    ? 'bg-primary/20 border-primary/50 text-foreground font-medium'
                    : 'bg-muted border-border text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
            <span className="text-muted-foreground ml-1">
              {draftHops.length === 0
                ? '· no hops'
                : `· ${draftHops.length} hop${draftHops.length === 1 ? '' : 's'}`}
            </span>
            <div className="flex-1" />
            <button
              onClick={() => {
                clearHops();
                setTraceError(null);
                setTraceResult(null);
              }}
              className="px-2 py-0.5 rounded border border-border bg-muted text-muted-foreground hover:text-foreground text-[10px] transition-colors"
            >
              Clear
            </button>
            <button
              onClick={handleRunMapTrace}
              disabled={traceLoading || draftHops.length === 0}
              className="px-2 py-0.5 rounded border border-primary bg-primary text-primary-foreground text-[10px] transition-colors disabled:opacity-50"
            >
              {traceLoading ? 'Tracing…' : 'Send Trace'}
            </button>
          </div>
          {traceError && <div className="mt-1.5 text-destructive">{traceError}</div>}
          {traceResult && (
            <div className="mt-1.5 space-y-0.5">
              <div className="font-medium text-foreground">
                Result ({traceResult.timeout_seconds.toFixed(1)}s):
              </div>
              {traceResult.nodes.map((node, i) => (
                <div key={i} className="text-muted-foreground">
                  {node.role === 'local'
                    ? 'Local radio'
                    : (node.name ?? node.public_key?.slice(0, 12) ?? 'Unknown')}
                  {node.snr != null && (
                    <span className="ml-1 font-mono">SNR {formatSNR(node.snr)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Trace History panel — shown when there are saved traces */}
      {traceHistory.entries.length > 0 && (
        <div className="px-4 py-2 bg-muted/10 border-b border-border text-xs">
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium text-foreground">📋 Saved Traces</span>
            <button
              onClick={() => traceHistory.clearAll()}
              className="text-[10px] text-muted-foreground hover:text-destructive transition-colors"
            >
              Clear all
            </button>
          </div>
          <div className="space-y-0.5 max-h-32 overflow-y-auto">
            {traceHistory.entries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-2">
                <span className="text-muted-foreground shrink-0">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
                <span className="text-muted-foreground shrink-0">{entry.label}</span>
                <button
                  onClick={() => {
                    const segments = buildTraceSegments(entry.result, contacts, connectedPublicKey);
                    if (segments.length > 0)
                      setActivePathTrace({ contactKey: `history-${entry.id}`, segments });
                  }}
                  className="px-1 text-primary hover:text-primary/70 transition-colors"
                  title="Draw on map"
                >
                  ▶ Draw
                </button>
                <button
                  onClick={() => traceHistory.removeEntry(entry.id)}
                  className="px-1 text-muted-foreground hover:text-destructive transition-colors"
                  title="Delete"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Map */}
      <div
        className="flex-1 relative"
        style={{ zIndex: 0 }}
        role="img"
        aria-label="Map showing mesh node locations"
      >
        <MapContainer
          center={[20, 0]}
          zoom={2}
          className="h-full w-full"
          style={{ background: '#1a1a2e' }}
        >
          <TileLayer
            key={TILE_LAYERS[tileKey].url}
            attribution={TILE_LAYERS[tileKey].attribution}
            url={TILE_LAYERS[tileKey].url}
          />
          <MapBoundsHandler contacts={mappableContacts} focusedContact={focusedContact} />
          <MapViewPersist />
          <FlyToHandler
            targetKey={pendingSearchFocus}
            contacts={contacts}
            markerRefs={markerRefs}
            onDone={() => setPendingSearchFocus(null)}
          />

          {/* Heatmap mode — no markers */}
          {heatmap && <HeatmapLayer points={heatPoints} />}

          {/* Faint route lines for active packet paths */}
          {showPackets &&
            routeLines.map((line, i) => (
              <Polyline
                key={`route-${i}`}
                positions={line.path}
                pathOptions={{ color: line.color, weight: 1, opacity: 0.15, dashArray: '4 6' }}
              />
            ))}

          {/* Marker mode */}
          {!heatmap &&
            (clustered ? (
              <MarkerClusterGroup
                iconCreateFunction={buildClusterIcon}
                maxClusterRadius={60}
                disableClusteringAtZoom={14}
                showCoverageOnHover={false}
                chunkedLoading
              >
                {markerElements}
              </MarkerClusterGroup>
            ) : (
              markerElements
            ))}

          {/* Active path trace overlay */}
          {activePathTrace &&
            activePathTrace.segments.map((seg, i) => (
              <Polyline
                key={i}
                positions={seg}
                pathOptions={{ color: '#22d3ee', weight: 3, opacity: 0.85, dashArray: '8 5' }}
              />
            ))}

          {/* Particle overlay for packet visualization */}
          {showPackets && <ParticleOverlay particles={particles} />}
        </MapContainer>
      </div>
    </div>
  );
}
