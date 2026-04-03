# Migration Fix: Upstream FK Rebuild Stripped Signal Data (04-4-2026)

The upstream FK cascade migration (62) introduced in the 3.7.0 merge rebuilt
`raw_packets` and `contact_advert_paths` without preserving our fork's added
columns (`rssi`, `snr`, `payload_type`, `best_rssi`, `best_snr`, `hash_mode`).
This caused the SNR/RSSI scatter, Packets by Type, SNR/RSSI history, and hash
mode badge features to stop working.

## What's fixed

### Database migrations (`app/migrations.py`)
- Migration 62 now dynamically preserves `rssi`, `snr`, and `payload_type` when
  rebuilding `raw_packets` (fixes fresh installs and users who haven't restarted yet).
- Migration 78 (new): re-adds `rssi`, `snr`, `payload_type` to `raw_packets` for
  databases where migration 62 already ran.
- Migrations 63–77 (new): correct a migration numbering collision where our fork's
  new migrations were numbered the same as upstream's and became unreachable for
  any DB already past version 50.

## Action required if you restarted after the 2026-04-02 merge

The schema is repaired automatically on restart. However, historical signal data
in `raw_packets` (rssi/snr/payload_type values) was lost when migration 62
rebuilt the table. A backup was saved automatically at startup:

```
data/meshcore.db.pre-fk-migration.bak
```

To restore the historical data, **stop the server**, run:

```bash
cd /opt/meshcore-terminal/Remote-Terminal-for-MeshCore
uv run python -c "
import sqlite3
main = sqlite3.connect('data/meshcore.db')
bak  = sqlite3.connect('data/meshcore.db.pre-fk-migration.bak')

rows = bak.execute('SELECT id, rssi, snr, payload_type FROM raw_packets WHERE rssi IS NOT NULL OR snr IS NOT NULL OR payload_type IS NOT NULL').fetchall()
print(f'raw_packets: {len(rows)} rows to restore')
main.executemany('UPDATE raw_packets SET rssi=?, snr=?, payload_type=? WHERE id=?', [(r[1], r[2], r[3], r[0]) for r in rows])

rows2 = bak.execute('SELECT id, best_rssi, best_snr, hash_mode FROM contact_advert_paths WHERE best_rssi IS NOT NULL OR best_snr IS NOT NULL OR hash_mode IS NOT NULL').fetchall()
print(f'contact_advert_paths: {len(rows2)} rows to restore')
main.executemany('UPDATE contact_advert_paths SET best_rssi=?, best_snr=?, hash_mode=? WHERE id=?', [(r[1], r[2], r[3], r[0]) for r in rows2])

main.commit()
print('Done.')
main.close()
bak.close()
"
```

Then restart the server. If you never restarted after the 2026-04-02 merge,
no action is needed — the fix applies cleanly.

---

# Packet Feed History Persistence (23-3-2026)

Packet feed no longer resets to empty on page refresh or radio reconnect.

## What's changed

### New backend endpoint (`app/routers/packets.py`)
- `GET /api/packets/recent?limit=500` — returns the most recent raw packets from the database in the same shape as the WebSocket `raw_packet` broadcast. Compatible with and without migration 47 signal columns. Ordered oldest-first for natural append order on the frontend.

### Frontend seed on mount (`frontend/src/App.tsx`)
- On first load, fetches `/api/packets/recent` and seeds `rawPackets` state before the WebSocket session begins. Errors are silently ignored — live packets still arrive normally.

### Reconnect behaviour (`frontend/src/hooks/useRealtimeAppState.ts`)
- `onReconnect` now re-fetches `/api/packets/recent` instead of calling `setRawPackets([])`, so history survives radio disconnects and reconnects.

---

# Raw Packet Signal Storage (23-3-2026)

RSSI, SNR, and payload type are now stored in the database at ingest time, enabling rich historical analytics.

## What's changed

### Database migration (`app/migrations.py`)
- Migration 47: adds `rssi INTEGER`, `snr REAL`, and `payload_type TEXT` columns to `raw_packets`. Existing rows retain `NULL` for these fields (signal data is not recoverable from stored hex bytes).

### Repository (`app/repository/raw_packets.py`)
- `RawPacketRepository.create()` now accepts and stores `rssi`, `snr`, and `payload_type` parameters.

### Packet processor (`app/packet_processor.py`)
- `process_raw_packet()` parses the packet type before calling `create()` so `payload_type_name` is always bound, fixing an `UnboundLocalError` on malformed packets.
- Passes `rssi`, `snr`, and `payload_type` through to the repository.

### Timeseries endpoint (`app/routers/packets.py`)
- `GET /api/packets/timeseries` now returns `avg_rssi`, `avg_snr`, and `type_counts` per bin when migration 47 columns are present, falling back to count/byte-only data for older databases.
- Added `has_signal_data` and `has_type_data` flags to the response so the frontend can conditionally render charts.

### My Node page (`frontend/src/components/MyNodeView.tsx`)
- `fetchHistorical` maps `avg_rssi`, `avg_snr`, and `type_counts` from the timeseries response onto the existing `Bin` structure, enabling SNR, RSSI, and stacked packet-type charts for all historical time windows (not just the live ≤ 1h session).

---

# My Node Page

Adds a dedicated **My Node** analytics page accessible from the sidebar (bar chart icon).

## What's new

### My Node page (`frontend/src/components/MyNodeView.tsx`)
- Identity header with node name, public key, radio params (freq/BW/SF/CR/TX power), firmware version, GPS link
- **Session Stats** tiles: packets/min, decrypt rate, unique sources, distinct paths, best/median/average RSSI
- **Live Activity** charts with time window selector (20m, 1h, 6h, 1d, 7d, 30d, 1y, custom range):
  - Bytes received, Packets received, Packets by type (stacked), SNR, RSSI
  - Windows ≤ 1h use live WebSocket session data; longer windows query the database
- **Session Breakdown** horizontal bar charts: packet types, route mix (Flood/Direct/Transport), hop profile, signal distribution (Strong/Okay/Weak), hop byte width
- **RF Neighbors** — resolves the last RF hop before this node using path token matching against the contacts database, with distance-based disambiguation for 1-byte hash collisions
- **Details** section: full radio config key/value list
- **More** toggle: network totals, nodes heard (1h/24h/7d), busiest channels, path hash width stats

### New backend endpoint (`app/routers/packets.py`)
- `GET /api/packets/timeseries?start_ts=&end_ts=&bin_count=` — returns time-binned packet counts and byte totals from the `raw_packets` table for historical chart windows

### Other changes
- `frontend/src/types.ts` — added `'node'` to `ConversationType`
- `frontend/src/components/Sidebar.tsx` — added My Node entry to the tools section
- `frontend/src/components/ConversationPane.tsx` — added `'node'` conversation type handler, passes `rawPacketStatsSession` to `MyNodeView`

---

# Sidebar Improvements (23-3-2026)

Added a customization panel to the sidebar.

## What's changed

### Drag-to-reorder customization
A gear icon in the sidebar header opens a settings panel with two drag-and-drop lists:

- **Section Order** — reorder Favorites, Channels, Contacts, Room Servers, Repeaters, and Tools
- **Tool Order** — reorder the tools within the Tools section (Packet Feed, Node Map, Mesh Visualizer, Message Search, My Node, Room Finder)

Each list item has a grip handle. Drag to reorder, drop to confirm. The drop target highlights in primary colour while dragging. Both orders are persisted to `localStorage` and restored on reload. A **Reset to defaults** link restores original order.

### Mark all as read
Moved the "Mark all as read" action from a standalone floating row into the Channels section header. It appears as a small `CheckCheck` icon next to the unread count badge, only when there are unread channel messages.

### Favorites fix
Fixed a regression where favorited repeaters and room servers were not appearing in the Favorites section. All five contact types (clients, repeaters, rooms, sensors, unknown) are now correctly split between Favorites and their own sections.

---

# Map View Improvements (23-3-2026)

Overhauled the Node Map with a set of usability and performance improvements.

## What's changed

### Node type filtering
Added a toggle bar above the map to show or hide nodes by type. Each button displays the node's emoji icon and a live count of visible nodes in the current time window.

| Type | Icon |
|------|------|
| Client | 📟 |
| Repeater | 🛜 |
| Room Server | 🏠 |
| Sensor | 📡 |
| Unknown | ❓ |

### Emoji markers
Replaced the plain circle markers with per-type emoji icons. Each marker has a small coloured dot beneath it indicating recency — same colour scheme as before (cyan < 1h, blue < 1d, amber < 3d, grey older). Focused contacts get a dashed white ring.

### Time window presets
Replaced the hard-coded 7-day filter with a row of preset buttons:
**1h · 2h · 6h · 12h · 24h · 7d · 30d · All**

The active preset is highlighted. The info bar updates to reflect the selected window.

### Marker clustering
Added marker clustering via `react-leaflet-cluster`. Nearby markers are grouped into a numbered bubble at lower zoom levels and expand automatically as you zoom in (unclusters at zoom 14+).

A **Cluster** toggle button in the filter bar lets you enable or disable clustering at any time. The preference is saved to `localStorage` and defaults to **on** for better performance on lower-end systems.

### Dependencies
- Added `react-leaflet-cluster@2.1.0`