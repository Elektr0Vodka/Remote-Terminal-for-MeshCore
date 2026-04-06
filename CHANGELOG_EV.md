# Country Flag Emoji Fix for Windows/Chromium (07-4-2026)

Country flag emoji (🇳🇱, 🇬🇧, etc.) were rendering as two-letter ISO codes on Windows/Chromium because `Segoe UI Emoji` does not support regional indicator pairs. Fixed using `country-flag-emoji-polyfill`, which detects the missing support at runtime and injects a `@font-face` rule using the bundled `TwemojiCountryFlags.woff2` COLR subset font (77 kB). The font is served locally from `public/fonts/` — no CDN dependency, fully offline.

## What's changed

### Font polyfill (`frontend/src/main.tsx`)
- Calls `polyfillCountryFlagEmojis('Twemoji Country Flags', './fonts/TwemojiCountryFlags.woff2')` on startup. Only activates on browsers that support colour emoji but not flag emoji (Windows/Chromium); no-op on macOS/Linux/Firefox.

### CSS font stack (`frontend/src/index.css`)
- `--font-sans` prefixed with `"Twemoji Country Flags"`. The font's `unicode-range` (U+1F1E6–1F1FF) restricts it to flag sequences only, leaving all other text rendering unchanged.

### Bundled font (`frontend/public/fonts/TwemojiCountryFlags.woff2`)
- Subset of Twemoji Mozilla, copied from `country-flag-emoji-polyfill` npm package. Served as a static asset.

### New dependency
- `country-flag-emoji-polyfill` — 0.7 kB gzipped JS + 77 kB WOFF2 font.

---

# Map Country Filter (07-4-2026)

Adds a country filter to the Node Map. Contacts can be filtered by the country their GPS coordinates fall in, using entirely offline lookup.

## What's changed

### Country detection (`frontend/src/components/MapView.tsx`)
- `getCountryFromCoords(lat, lon)` uses `iso1A2Code`, `emojiFlag`, and `feature` from `@rapideditor/country-coder` (bundled GeoJSON, no network). Returns ISO code, name, and flag emoji.
- `contactCountryMap` memo maps each GPS-bearing contact's public key to its `CountryInfo`.

### Two-phase filtering
- `baseFilteredContacts` memo applies time/type/hash-mode filters (all existing filters except country). Used to compute the country button list so it respects the current time window.
- `mappableContacts` applies the country filter on top as a second pass. Avoids a circular dependency between the country list and the country filter.

### Country button toolbar
- Rendered when more than one country is present among currently visible contacts.
- Each button shows the flag emoji and a contact count. Tooltip shows the country name. Active/inactive state styled consistently with the type filter buttons.
- "all" reset link clears the selection.
- A `useEffect` prunes selected countries that leave the visible set when the time window or type filter changes, preventing zero-result dead selections.

### Info bar
- Shows `· N/M countr(y|ies)` when a country filter is active.

### New dependency
- `@rapideditor/country-coder` — offline-capable GeoJSON country lookup.

---

# Mesh Visualizer Time Window (07-4-2026)

The Mesh Visualizer now supports historical time windows, not just the live session.

## What's changed

### Time window toolbar (`frontend/src/components/VisualizerView.tsx`)
- Added preset buttons: **Session · 30m · 1h · 2h · 6h · 12h · 24h · Custom**.
- Session mode streams live WebSocket packets as before.
- Historical modes call `GET /api/packets/recent?after_ts=&before_ts=&limit=5000` and display the returned snapshot.
- Custom mode exposes from/to datetime inputs.
- Changing the window remounts `PacketVisualizer3D` and `RawPacketList` via a `vizKey` counter, resetting incremental graph state.

### Backend endpoint (`app/routers/packets.py`)
- `GET /api/packets/recent` extended with optional `after_ts` and `before_ts` Unix-second query parameters.
- `limit` cap raised from 2000 to 5000.

### API client (`frontend/src/api.ts`)
- `api.getRecentPackets({ afterTs?, beforeTs?, limit? })` added.

---

# Channel Finder Queue & Count Fixes (07-4-2026)

Two bugs in the channel cracker panel corrected.

## What's changed

### Queue staleness (`frontend/src/components/CrackerPanel.tsx`)
- The effect that enqueues new `GROUP_TEXT` packets for cracking used `[undecryptedGroupText.length]` as its dependency. Under React 18 concurrent rendering with frequent state updates, this missed packets that arrived while cracking was active. Changed to `[undecryptedGroupText]` (full array reference) so every state update triggers a re-evaluation.

### Undecrypted count refresh timing
- The 2-minute polling interval was replaced with a per-packet refresh: `refreshUndecryptedCount()` is called after each packet finishes its decrypt/fail sequence, immediately before the next packet is scheduled. Count now stays current rather than drifting 50+ packets behind.
- `refreshUndecryptedCount` extracted as a `useCallback` to keep the `processNext` dependency array clean.

---

# Bot Detection Module (06-4-2026)

Adds a behaviour-based bot detection system that scores nodes on automation likelihood and impact without requiring manual review.

## What's changed

### Backend (`app/services/bot_analyzer.py`, `app/repository/bot_detection.py`, `app/routers/bot_detection.py`)
- `BotAnalyzerService` scores contacts on two axes: **automation score** (timing regularity via coefficient of variation, template repetition, structured content patterns, name keyword bonus) and **impact score** (message volume, channel reach).
- Noise pre-filter strips routine human check-ins (Test, Hello, etc.) before scoring so genuine chatty humans aren't penalised.
- Template normalisation handles MeshCore path payloads (`>`-separated and `,`-separated hex bytes).
- Background analysis task runs periodically; individual re-analysis available via API.
- Manual tags: `likely_bot`, `utility_bot`, `test`, `not_a_bot`.
- Migrations add `bot_scores` and `bot_manual_tags` tables.
- REST endpoints: `GET /api/bot-detection/nodes`, `GET /api/bot-detection/nodes/{key}`, `POST /api/bot-detection/nodes/{key}/analyze`, `POST /api/bot-detection/nodes/{key}/tag`.

### BotDetectorPane (`frontend/src/components/BotDetectorPane.tsx`)
- Sortable/filterable node table with automation and impact score bars.
- Detail panel: score breakdown, message samples, Analyze now button (auto-refreshes panel on completion).
- URL hash persistence (`#bot-detector`), last-viewed restore, sidebar nav entry (🤖).

### ContactInfoPane integration
- Bot tag toggle buttons (Likely bot / Not a bot) added to the contact detail sheet.

### Bot detection improvements (`411779a`)
- Analysis window raised from 300 → 9999 messages so high-traffic routing relays are scored over their full history.
- "pong" removed from human noise words (valid bot response pattern).
- Detail panel auto-refreshes after "Analyze now" without requiring panel close/reopen.

---

# Channel Import / Export (05-4-2026)

Channels can now be exported and imported using a plain-text format, and imported channels can optionally trigger a historical decrypt pass.

## What's changed

### Backend (`app/routers/channels.py`)
- `GET /api/channels/export` — exports all channels as a `.txt` file in `#name - key` format. Three modes: all channels, named channels only, or channels with keys only.
- `POST /api/channels/import` — parses the same format, creates missing channels, and returns a summary of added/skipped/failed entries.
- `POST /api/channels/import/decrypt` — after import, re-runs the historical decrypt pass over stored `GROUP_TEXT` packets using the newly imported keys.

### ChannelImportExportModal (`frontend/src/components/ChannelImportExportModal.tsx`)
- Import tab: file picker or paste area, preview of parsed entries, conflict summary, optional "decrypt historical packets" checkbox after import completes.
- Export tab: three export scope buttons with live download.

### Sidebar / CrackerPanel integration
- Import/Export button added to the Channels section header.
- CrackerPanel wired to accept a post-import trigger to kick off historical decrypt.

### New dependency
- `python-multipart` added for file upload handling.

---

# Migration Fix: Favorites Migration Number Collision (05-4-2026)

Our fork's new migrations (051–055) collided with upstream's numbering and became unreachable on any database already past version 50. Renumbered to 080–085 so they run correctly on all existing databases.

---

# Bugfix: Signal Data (rssi/snr/payload_type) Never Saved for New Packets (04-4-2026)

`raw_packets` INSERT used only `(timestamp, data, payload_hash)` as the conflict key, so the `rssi`, `snr`, and `payload_type` columns were always `NULL` on newly inserted packets. Fixed by including those columns in the single `INSERT OR IGNORE` and using `cursor.rowcount` to distinguish new rows from duplicates.

---

# MapView Fork Features Restored After Upstream Merge (04-4-2026)

An upstream merge had replaced our ~2500-line MapView with the upstream minimal version (~860 lines), silently dropping all fork-specific features. This commit re-merges both codebases.

## What's restored

- Contact type filter buttons with live counts
- Hash mode filter buttons (1B / 2B / 3B)
- Time window presets + custom date range picker
- Heatmap mode (`leaflet.heat`, `/api/contacts/heatmap`)
- `MarkerClusterGroup` with custom cluster icons
- Emoji `DivIcon` markers with recency colour dots and health warning rings
- Full `MapPopupContent`: editable notes, owner ID, live trace, Show Path, copy coords/key, owned nodes, Send DM, Manage Node
- `FlyToHandler`, `MapViewPersist` (pan/zoom to `localStorage`), `MapBoundsHandler`
- Trace Builder + Trace History panels
- Owned-only filter, tile layer picker, node search

## Trace button and prop fixes (`f5c4332`)

- `ConversationPane` was not forwarding `rawPackets`, `connectedPublicKey`, `onSelectConversation`, `onPathDiscovery`, or `onRunTracePath` to `MapView`, silently disabling Send Trace and Show Path. All props now correctly passed.
- Trace builder gains **1-byte / 2-byte / 3-byte** hop width selector (protocol values 1 / 2 / 4). Default follows detected hop type; manually overridable.
- `resolvePacketPath` now prefers the source contact's stored `direct_path` over re-resolving raw hash bytes, routing particles through known repeater GPS points.

## MapView correctness fixes (`796ac83`)

- 4-byte trace mode protocol value corrected.
- Missing props propagated to nested components.
- UI labels corrected.

---

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