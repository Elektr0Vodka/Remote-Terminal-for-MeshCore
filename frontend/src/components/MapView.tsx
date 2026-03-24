import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import type { LatLngBoundsExpression } from 'leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';
import type { Contact } from '../types';
import { formatTime } from '../utils/messageParser';
import { isValidLocation } from '../utils/pathUtils';
import { CONTACT_TYPE_REPEATER, CONTACT_TYPE_ROOM } from '../types';

interface MapViewProps {
  contacts: Contact[];
  focusedKey?: string | null;
}

// ─── Contact type constants ──────────────────────────────────────────────────

const CONTACT_TYPE_UNKNOWN = 0;
const CONTACT_TYPE_CLIENT  = 1;
const CONTACT_TYPE_SENSOR  = 4;

type ContactTypeKey = 'unknown' | 'client' | 'repeater' | 'room' | 'sensor';

const CONTACT_TYPE_CONFIG: Record<ContactTypeKey, { label: string; value: number; emoji: string }> = {
  unknown:  { label: 'Unknown',  value: CONTACT_TYPE_UNKNOWN,  emoji: '❓' },
  client:   { label: 'Client',   value: CONTACT_TYPE_CLIENT,   emoji: '📟' },
  repeater: { label: 'Repeater', value: CONTACT_TYPE_REPEATER, emoji: '🛜' },
  room:     { label: 'Room',     value: CONTACT_TYPE_ROOM,     emoji: '🏠' },
  sensor:   { label: 'Sensor',   value: CONTACT_TYPE_SENSOR,   emoji: '📡' },
};

const ALL_TYPE_KEYS = Object.keys(CONTACT_TYPE_CONFIG) as ContactTypeKey[];

function getTypeKey(type: number | null | undefined): ContactTypeKey {
  return ALL_TYPE_KEYS.find((k) => CONTACT_TYPE_CONFIG[k].value === type) ?? 'unknown';
}

// ─── Recency colors ──────────────────────────────────────────────────────────

const MAP_RECENCY_COLORS = {
  recent: '#06b6d4',
  today:  '#2563eb',
  stale:  '#f59e0b',
  old:    '#64748b',
} as const;

function getMarkerColor(lastSeen: number | null | undefined): string {
  if (lastSeen == null) return MAP_RECENCY_COLORS.old;
  const age = Date.now() / 1000 - lastSeen;
  if (age < 3600)      return MAP_RECENCY_COLORS.recent;
  if (age < 86400)     return MAP_RECENCY_COLORS.today;
  if (age < 3 * 86400) return MAP_RECENCY_COLORS.stale;
  return MAP_RECENCY_COLORS.old;
}

// ─── Emoji DivIcon ────────────────────────────────────────────────────────────

function buildIcon(emoji: string, color: string, focused = false): L.DivIcon {
  const ring = focused
    ? `<div style="position:absolute;inset:-3px;border-radius:50%;border:2px dashed #ffffff;pointer-events:none;"></div>`
    : '';
  const html = `
    <div style="position:relative;width:28px;height:32px;display:flex;flex-direction:column;align-items:center;gap:1px;">
      ${ring}
      <span style="font-size:22px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.6));">${emoji}</span>
      <span style="width:8px;height:8px;border-radius:50%;background:${color};border:1.5px solid #0f172a;flex-shrink:0;"></span>
    </div>`;
  return L.divIcon({ html, className: '', iconSize: [28, 32], iconAnchor: [14, 32], popupAnchor: [0, -34] });
}

// ─── Custom cluster icon ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildClusterIcon(cluster: any): L.DivIcon {
  const count = cluster.getChildCount();
  const size = count < 10 ? 32 : count < 100 ? 38 : 44;
  const html = `<div style="width:${size}px;height:${size}px;border-radius:50%;background:hsl(220 70% 45% / 0.85);border:2px solid #f8fafc;display:flex;align-items:center;justify-content:center;color:#fff;font-size:${size < 38 ? 11 : 13}px;font-weight:700;font-family:sans-serif;box-shadow:0 2px 6px rgba(0,0,0,0.4);">${count}</div>`;
  return L.divIcon({ html, className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

// ─── Heatmap layer ────────────────────────────────────────────────────────────

interface HeatPoint { lat: number; lon: number; intensity: number; }

function HeatmapLayer({ points }: { points: HeatPoint[] }) {
  const map = useMap();
  const heatRef = useRef<any>(null);

  useEffect(() => {
    if (!points.length) return;

    const data = points.map((p) => [p.lat, p.lon, p.intensity] as [number, number, number]);

    if (!heatRef.current) {
      heatRef.current = (L as any).heatLayer(data, {
        radius: 35,
        blur: 25,
        maxZoom: 10,
        max: 1.0,
        gradient: { 0.2: '#0ea5e9', 0.4: '#22c55e', 0.6: '#eab308', 0.8: '#f97316', 1.0: '#ef4444' },
        minOpacity: 0.4,
      }).addTo(map);
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
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  },
  light: {
    label: 'Light',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; <a href="https://www.esri.com/">Esri</a>',
  },
  topo: {
    label: 'Topo',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://opentopomap.org/">OpenTopoMap</a>',
  },
};

const TILE_PREF_KEY = 'remoteterm-map-tile';
function loadTilePref(): TileLayerKey {
  try { const r = localStorage.getItem(TILE_PREF_KEY); return (r as TileLayerKey) ?? 'osm'; }
  catch { return 'osm'; }
}
function saveTilePref(v: TileLayerKey): void {
  try { localStorage.setItem(TILE_PREF_KEY, v); } catch {}
}

// ─── localStorage helpers ─────────────────────────────────────────────────────

function loadClusterPref(): boolean {
  try { const r = localStorage.getItem('remoteterm-map-cluster'); return r === null ? true : r === 'true'; }
  catch { return true; }
}
function saveClusterPref(v: boolean): void {
  try { localStorage.setItem('remoteterm-map-cluster', String(v)); } catch {}
}

// ─── Map bounds handler ──────────────────────────────────────────────────────

function MapBoundsHandler({ contacts, focusedContact }: { contacts: Contact[]; focusedContact: Contact | null }) {
  const map = useMap();
  const [hasInitialized, setHasInitialized] = useState(false);

  useEffect(() => {
    if (focusedContact && focusedContact.lat != null && focusedContact.lon != null) {
      map.setView([focusedContact.lat, focusedContact.lon], 12);
      setHasInitialized(true);
      return;
    }
    if (hasInitialized) return;

    const fitToContacts = () => {
      if (contacts.length === 0) { map.setView([20, 0], 2); setHasInitialized(true); return; }
      if (contacts.length === 1) { map.setView([contacts[0].lat!, contacts[0].lon!], 10); setHasInitialized(true); return; }
      const bounds: LatLngBoundsExpression = contacts.map((c) => [c.lat!, c.lon!] as [number, number]);
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 12 });
      setHasInitialized(true);
    };

    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => { map.setView([pos.coords.latitude, pos.coords.longitude], 8); setHasInitialized(true); },
        () => fitToContacts(),
        { timeout: 5000, maximumAge: 300000 }
      );
    } else {
      fitToContacts();
    }
  }, [map, contacts, hasInitialized, focusedContact]);

  return null;
}

// ─── MapView ─────────────────────────────────────────────────────────────────

export function MapView({ contacts, focusedKey }: MapViewProps) {
  const now = useMemo(() => Math.floor(Date.now() / 1000), []);

  // ── Time window presets ─────────────────────────────────────────────────────
  const TIME_PRESETS = [
    { label: '1h',  seconds: 3600 },
    { label: '2h',  seconds: 2 * 3600 },
    { label: '6h',  seconds: 6 * 3600 },
    { label: '12h', seconds: 12 * 3600 },
    { label: '24h', seconds: 86400 },
    { label: '7d',  seconds: 7 * 86400 },
    { label: '30d', seconds: 30 * 86400 },
    { label: 'All', seconds: null },
  ] as const;

  const [activePreset, setActivePreset] = useState<string>('7d');
  const activeSeconds = TIME_PRESETS.find((p) => p.label === activePreset)?.seconds ?? 7 * 86400;
  const effectiveStart = activeSeconds === null ? 0 : now - activeSeconds;
  const effectiveEnd   = now;

  // ── Type toggles ────────────────────────────────────────────────────────────
  const [visibleTypes, setVisibleTypes] = useState<Record<ContactTypeKey, boolean>>(
    { unknown: true, client: true, repeater: true, room: true, sensor: true }
  );
  const toggleType = (k: ContactTypeKey) => setVisibleTypes((p) => ({ ...p, [k]: !p[k] }));

  // ── Cluster toggle ──────────────────────────────────────────────────────────
  const [clustered, setClustered] = useState(loadClusterPref);
  const handleClusterToggle = () => setClustered((p) => { saveClusterPref(!p); return !p; });

  // ── Heatmap toggle ──────────────────────────────────────────────────────────
  const [heatmap, setHeatmap] = useState(false);

  // ── Tile layer ──────────────────────────────────────────────────────────────
  const [tileKey, setTileKey] = useState<TileLayerKey>(loadTilePref);
  const handleTileChange = (key: TileLayerKey) => { setTileKey(key); saveTilePref(key); };

  // ── Filtered contacts ───────────────────────────────────────────────────────
  const mappableContacts = useMemo(() => contacts.filter((c) => {
    if (!isValidLocation(c.lat, c.lon)) return false;
    if (c.public_key === focusedKey) return true;
    if (c.last_seen == null || c.last_seen < effectiveStart || c.last_seen > effectiveEnd) return false;
    return visibleTypes[getTypeKey(c.type)];
  }), [contacts, focusedKey, effectiveStart, effectiveEnd, visibleTypes]);

  const focusedContact = useMemo(() =>
    focusedKey ? (mappableContacts.find((c) => c.public_key === focusedKey) ?? null) : null,
    [focusedKey, mappableContacts]
  );

  // ── Heatmap data — intensity based on packet heard count ─────────────────
  const [heatRawData, setHeatRawData] = useState<{ lat: number; lon: number; count: number }[]>([]);
  const [heatLoading, setHeatLoading] = useState(false);

  useEffect(() => {
    if (!heatmap) return;
    setHeatLoading(true);
    fetch('/api/contacts/heatmap')
      .then((r) => r.json())
      .then((data) => { setHeatRawData(data); setHeatLoading(false); })
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

  // ── Marker refs ─────────────────────────────────────────────────────────────
  const markerRefs = useRef<Record<string, L.Marker | null>>({});
  const setMarkerRef = useCallback((key: string, ref: L.Marker | null) => {
    markerRefs.current[key] = ref;
  }, []);

  useEffect(() => {
    if (focusedContact) {
      const timer = setTimeout(() => markerRefs.current[focusedContact.public_key]?.openPopup(), 100);
      return () => clearTimeout(timer);
    }
  }, [focusedContact]);

  const isFullRange = activePreset === 'All';
  const activeTypeCount = ALL_TYPE_KEYS.filter((k) => visibleTypes[k]).length;

  const markerElements = mappableContacts.map((contact) => {
    const typeKey = getTypeKey(contact.type);
    const cfg = CONTACT_TYPE_CONFIG[typeKey];
    const color = getMarkerColor(contact.last_seen);
    const focused = contact.public_key === focusedKey;
    const icon = buildIcon(cfg.emoji, color, focused);
    const displayName = contact.name || contact.public_key.slice(0, 12);
    const lastHeardLabel = contact.last_seen != null ? formatTime(contact.last_seen) : 'Never heard by this server';

    return (
      <Marker
        key={contact.public_key}
        ref={(ref) => setMarkerRef(contact.public_key, ref)}
        position={[contact.lat!, contact.lon!]}
        icon={icon}
      >
        <Popup>
          <div className="text-sm">
            <div className="font-medium flex items-center gap-1">
              <span aria-hidden="true">{cfg.emoji}</span>{displayName}
            </div>
            <div className="text-xs text-gray-500 mt-1">{cfg.label} · Last heard: {lastHeardLabel}</div>
            <div className="text-xs text-gray-400 mt-1 font-mono">{contact.lat!.toFixed(5)}, {contact.lon!.toFixed(5)}</div>
          </div>
        </Popup>
      </Marker>
    );
  });

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">

      {/* Info bar + recency legend */}
      <div className="px-4 py-2 bg-muted/50 text-xs text-muted-foreground flex items-center justify-between flex-wrap gap-2">
        <span>
          Showing {mappableContacts.length} contact{mappableContacts.length !== 1 ? 's' : ''}
          {isFullRange ? ' (all time)' : ` · last ${activePreset}`}
          {activeTypeCount < ALL_TYPE_KEYS.length ? ` · ${activeTypeCount}/${ALL_TYPE_KEYS.length} types` : ''}
          {heatmap ? ' · heatmap' : ''}
          {heatmap && heatLoading ? ' · loading…' : ''}
        </span>
        {!heatmap && (
          <div className="flex items-center gap-3">
            {([
              { label: '<1h',   color: MAP_RECENCY_COLORS.recent },
              { label: '<1d',   color: MAP_RECENCY_COLORS.today  },
              { label: '<3d',   color: MAP_RECENCY_COLORS.stale  },
              { label: 'older', color: MAP_RECENCY_COLORS.old    },
            ] as const).map(({ label, color }) => (
              <span key={label} className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full inline-block border border-[#0f172a]" style={{ backgroundColor: color }} />
                {label}
              </span>
            ))}
          </div>
        )}
        {heatmap && (
          <div className="flex items-center gap-1.5 text-[10px]">
            <span>Low</span>
            <span className="w-20 h-2 rounded" style={{
              background: 'linear-gradient(to right, #0ea5e9, #22c55e, #eab308, #f97316, #ef4444)'
            }} />
            <span>High</span>
          </div>
        )}
      </div>

      {/* Type toggles + cluster + heatmap buttons */}
      <div className="px-4 py-2 bg-muted/30 border-b border-border flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">Show:</span>
        {ALL_TYPE_KEYS.map((key) => {
          const cfg = CONTACT_TYPE_CONFIG[key];
          const active = visibleTypes[key];
          const count = contacts.filter((c) =>
            isValidLocation(c.lat, c.lon) && c.public_key !== focusedKey &&
            c.last_seen != null && c.last_seen >= effectiveStart && c.last_seen <= effectiveEnd &&
            getTypeKey(c.type) === key
          ).length;
          return (
            <button key={key} onClick={() => toggleType(key)}
              title={`${active ? 'Hide' : 'Show'} ${cfg.label} (${count})`}
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors border ${
                active ? 'bg-primary/10 border-primary/40 text-foreground' : 'bg-muted border-border text-muted-foreground opacity-50'
              }`}>
              <span className="text-base leading-none">{cfg.emoji}</span>
              <span>{cfg.label}</span>
              <span className="tabular-nums text-[10px] text-muted-foreground">{count}</span>
            </button>
          );
        })}
        {activeTypeCount < ALL_TYPE_KEYS.length && (
          <button onClick={() => setVisibleTypes({ unknown: true, client: true, repeater: true, room: true, sensor: true })}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
            Show all
          </button>
        )}
        <div className="flex-1" />

        {/* Cluster toggle — hidden in heatmap mode */}
        {!heatmap && (
          <button onClick={handleClusterToggle}
            title={clustered ? 'Disable clustering' : 'Enable clustering'}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors border ${
              clustered ? 'bg-primary/10 border-primary/40 text-foreground' : 'bg-muted border-border text-muted-foreground'
            }`}>
            <span className="text-base leading-none">🗂️</span>
            <span>Cluster</span>
          </button>
        )}

        {/* Heatmap toggle */}
        <button onClick={() => setHeatmap((p) => !p)}
          title={heatmap ? 'Switch to markers' : 'Switch to heatmap'}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors border ${
            heatmap ? 'bg-primary/10 border-primary/40 text-foreground' : 'bg-muted border-border text-muted-foreground'
          }`}>
          <span className="text-base leading-none">🌡️</span>
          <span>Heatmap</span>
        </button>

        {/* Tile layer picker */}
        <div className="flex items-center gap-1 ml-1 border-l border-border pl-2">
          {(Object.keys(TILE_LAYERS) as TileLayerKey[]).map((key) => (
            <button key={key}
              onClick={() => handleTileChange(key)}
              title={TILE_LAYERS[key].label}
              className={`px-2 py-0.5 text-[10px] rounded transition-colors border ${
                tileKey === key
                  ? 'bg-primary/10 border-primary/40 text-foreground font-medium'
                  : 'bg-muted border-border text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}>
              {TILE_LAYERS[key].label}
            </button>
          ))}
        </div>
      </div>

      {/* Time window presets */}
      <div className="px-4 py-2 bg-muted/30 border-b border-border flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">Period:</span>
        {TIME_PRESETS.map(({ label }) => (
          <button key={label} onClick={() => setActivePreset(label)}
            className={`px-2 py-0.5 text-[10px] rounded transition-colors ${activePreset === label
              ? 'bg-primary text-primary-foreground font-medium'
              : 'bg-background border border-border text-muted-foreground hover:bg-accent hover:text-foreground'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Map */}
      <div className="flex-1 relative" style={{ zIndex: 0 }} role="img" aria-label="Map showing mesh node locations">
        <MapContainer center={[20, 0]} zoom={2} className="h-full w-full" style={{ background: '#1a1a2e' }}>
          <TileLayer
            attribution={TILE_LAYERS[tileKey].attribution}
            url={TILE_LAYERS[tileKey].url}
          />
          <MapBoundsHandler contacts={mappableContacts} focusedContact={focusedContact} />

          {/* Heatmap mode — no markers */}
          {heatmap && <HeatmapLayer points={heatPoints} />}

          {/* Marker mode */}
          {!heatmap && (
            clustered ? (
              <MarkerClusterGroup iconCreateFunction={buildClusterIcon} maxClusterRadius={60} disableClusteringAtZoom={14} showCoverageOnHover={false} chunkedLoading>
                {markerElements}
              </MarkerClusterGroup>
            ) : (
              markerElements
            )
          )}
        </MapContainer>
      </div>
    </div>
  );
}
