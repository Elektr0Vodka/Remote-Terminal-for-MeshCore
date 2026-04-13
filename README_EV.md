# Elektr0Vodka Fork — Additional Features

This document covers features added in the [Elektr0Vodka fork](https://github.com/Elektr0Vodka/Remote-Terminal-for-MeshCore) on top of the upstream [jkingsman/Remote-Terminal-for-MeshCore](https://github.com/jkingsman/Remote-Terminal-for-MeshCore). All upstream features remain intact.

---

## Table of Contents

- [Channel Registry](#channel-registry)
- [Channel Import / Export](#channel-import--export)
- [Mention Ticker](#mention-ticker)
- [Bot Detection](#bot-detection)
- [My Node Page](#my-node-page)
- [Map Enhancements](#map-enhancements)
- [Mesh Visualizer Time Windows](#mesh-visualizer-time-windows)
- [Sidebar Enhancements](#sidebar-enhancements)
- [Packet Feed History](#packet-feed-history)
- [Raw Packet Signal Data](#raw-packet-signal-data)
- [Channel Finder Fixes](#channel-finder-fixes)
- [Country Flag Emoji (Windows)](#country-flag-emoji-windows)

---

## Channel Registry

**Location:** Sidebar → Tools → `#` (Channel Registry)  
**URL hash:** `#channel-registry`

A persistent, enriched metadata store for known MeshCore channels. Compatible with the [meshcore-nl-discovered-channels](https://github.com/Elektr0Vodka/meshcore-nl-discovered-channels) JSON schema.

### What it does

- Filterable, sortable table showing channel name, category, status, source, last heard time, and packet count.
- Expandable row detail: subcategory, region, country, language, verified/recommended flags, first/last seen, alias, tags, scopes, and notes.
- **Auto-seeded** from all channels already stored in the database on first load (`source: radio`), so the page is never empty.
- Channels discovered by the Channel Finder are automatically registered (`source: finder`) and their packet count increments with each new crack.

### Adding channels manually

Click **Add Channel** to open the inline form. Fill in name, category, subcategory, country, language codes, status, region, and notes. The channel is saved to `localStorage` immediately.

### Dutch geo auto-fill (Netherlands)

When editing a channel, if the name matches a known Dutch municipality or region, a banner appears offering to auto-fill country (`Netherlands`), region (province), and scopes (including the veiligheidsregio scope in orange). Click **Apply** to accept.

### Private channels

Check **Private (exclude from export)** in the edit modal to prevent a channel from appearing in any export. Private channels show a 🔒 icon in the table.

### Scope pills

The edit modal shows a live preview of all configured scopes as coloured pills. Veiligheidsregio scopes (prefixed `VR `) render in orange.

### Import

Click **Import JSON** and select or paste a `channels.json` file. Supported formats:

- This tool's own export format
- The `meshcore-nl-discovered-channels` project schema

Merge rules:
- Existing `firstSeen` is never overwritten.
- `lastHeard` takes the newer of the two values.
- Packet counts are summed.
- Missing metadata fields are filled in without clobbering existing data.

### Export

Click **Export JSON** to download a `meshcore_channel_registry_YYYY-MM-DD.json` file. Private channels (marked with 🔒) are excluded. The file is compatible with meshcore-nl-discovered-channels.

---

## Channel Import / Export

**Location:** Sidebar → Channels section header → import/export icon

Bulk import and export of channels using a plain-text `#name - key` format.

### Export

Three scope buttons on the Export tab:
- **All channels** — every channel in the database
- **Named channels only** — channels that have a name set
- **Channels with keys only** — channels that have a key

### Import

Paste or upload a `.txt` file in `#name - key` format. The import preview shows which channels will be added and which already exist. An optional **Decrypt historical packets** checkbox re-runs the historical decrypt pass over stored `GROUP_TEXT` packets using any newly added keys, recovering messages that couldn't be decrypted before.

---

## Mention Ticker

**Location:** Always-visible strip at the top of the page (when enabled)  
**Toggle:** Settings → Local → Show mention ticker

When your username is @mentioned in a channel you are not currently viewing, a scrolling ticker appears at the top of the screen showing who mentioned you, in which channel, and a preview of the message. Clicking the ticker navigates directly to that message.

- Multiple mentions stack in the ticker and scroll automatically.
- Each mention entry shows the channel name, sender, and message preview.
- Dismiss individual mentions with the × button, or they expire after 10 minutes.
- The ticker only fires for new incoming messages — not your own outgoing ones.

To disable the ticker entirely, go to **Settings → Local** and uncheck **Show mention ticker**.

---

## Bot Detection

**Location:** Sidebar → Tools → 🤖 (Bot Detector)  
**URL hash:** `#bot-detector`

Scores nodes on two axes without requiring manual review:

| Score | What it measures |
|-------|-----------------|
| **Automation score** | Timing regularity (coefficient of variation), template repetition, structured content patterns, name keyword matching |
| **Impact score** | Message volume, channel reach |

### Using the detector

The table lists all nodes that have enough message history to score. Click any row to open the detail panel showing score breakdown, message samples, and a manual **Analyze now** button that refreshes immediately.

### Manual tags

Four tags are available from the contact detail sheet:
- `likely_bot`
- `utility_bot`
- `test`
- `not_a_bot`

Tags override the automated score display and persist in the database.

### Notes

- Analysis window covers up to 9999 messages so high-traffic relays are scored over their full history.
- Routine human check-ins (Test, Hello, etc.) are filtered out before scoring to avoid false positives.
- "pong" is treated as a valid bot response pattern (not filtered as a human phrase).

---

## My Node Page

**Location:** Sidebar → Tools → bar chart icon  
**URL hash:** `#node`

A dedicated analytics page for your own node.

### Identity header

Node name, public key (click to copy), radio parameters (frequency, bandwidth, spreading factor, coding rate, TX power), firmware version, and GPS link.

### Session Stats tiles

| Tile | Description |
|------|-------------|
| Packets/min | Live throughput rate |
| Decrypt rate | Percentage of GROUP_TEXT packets successfully decrypted |
| Unique sources | Distinct public keys heard this session |
| Distinct paths | Number of unique packet paths observed |
| Best / Median / Avg RSSI | Signal strength statistics |

### Live Activity charts

Time window selector: **20m · 1h · 6h · 1d · 7d · 30d · 1y · Custom**

- Windows ≤ 1 hour use live WebSocket session data.
- Longer windows query the database (`GET /api/packets/timeseries`).

Charts: Bytes received, Packets received, Packets by type (stacked), SNR, RSSI.

### Session Breakdown

Horizontal bar charts: packet types, route mix (Flood / Direct / Transport), hop profile, signal distribution (Strong / OK / Weak), hop byte width.

### RF Neighbors

Resolves the last RF hop before this node using path token matching against the contacts database. Distance-based disambiguation handles 1-byte hash collisions.

### More section

Network totals, nodes heard (1h / 24h / 7d), busiest channels, path hash width stats.

---

## Map Enhancements

### Country filter

When nodes from multiple countries are visible, a country button toolbar appears. Each button shows the flag emoji and a count. Clicking filters the map to that country; click **all** to clear. Country lookup is fully offline using `@rapideditor/country-coder`.

### Node type filter

Toggle bar above the map to show/hide nodes by type:

| Type | Icon |
|------|------|
| Client | 📟 |
| Repeater | 🛜 |
| Room Server | 🏠 |
| Sensor | 📡 |
| Unknown | ❓ |

Each button shows a live count of visible nodes for the current time window.

### Emoji markers

Each node is shown as its type emoji. A small coloured dot beneath indicates recency:

| Colour | Age |
|--------|-----|
| Cyan | < 1 hour |
| Blue | < 1 day |
| Amber | < 3 days |
| Grey | Older |

### Time window presets

**1h · 2h · 6h · 12h · 24h · 7d · 30d · All** — replaces the hard-coded 7-day filter.

### Marker clustering

Nearby markers cluster into numbered bubbles at lower zoom levels and expand at zoom 14+. Toggle the **Cluster** button in the filter bar to enable/disable. Preference is saved to `localStorage`.

### Map popup

Full popup for each contact: editable notes, owner ID, live trace, Show Path, copy coordinates/key, owned nodes, Send DM, Manage Node.

### Trace Builder

Send a trace path from within the map. Supports **1-byte / 2-byte / 3-byte** hop width selector (protocol values 1 / 2 / 4). Default follows the detected hop type for the contact; manually overridable. The builder prefers the contact's stored `direct_path` for particle routing so traces pass through known repeater GPS points.

### Heatmap mode

Toggle heatmap display using `leaflet.heat` and the `/api/contacts/heatmap` endpoint.

### Pan/zoom persistence

Map position and zoom level are saved to `localStorage` and restored on reload.

---

## Mesh Visualizer Time Windows

The Mesh Visualizer supports historical time windows, not just the live session.

**Presets:** Session · 30m · 1h · 2h · 6h · 12h · 24h · Custom

- **Session** — live WebSocket stream as before.
- **Historical presets** — fetches a snapshot from `GET /api/packets/recent?after_ts=&before_ts=&limit=5000`.
- **Custom** — exposes from/to datetime inputs.

Changing the window resets the graph state (remounts the visualizer with a fresh key).

---

## Sidebar Enhancements

### Unread DMs always at top

Contact entries with unread direct messages float above all other contacts regardless of sort order.

### Drag-to-reorder customization

Click the gear icon in the sidebar header to open the customization panel:

- **Section Order** — drag to reorder Favorites, Channels, Contacts, Room Servers, Repeaters, and Tools.
- **Tool Order** — drag to reorder tools within the Tools section.

Orders persist to `localStorage`. Click **Reset to defaults** to restore the original layout.

### Mark all as read

A `✓✓` icon in the Channels section header marks all channel messages as read. Only visible when there are unread messages.

---

## Packet Feed History

The raw packet feed survives page refreshes and radio reconnects.

On load, the frontend fetches `/api/packets/recent?limit=500` and pre-populates the feed before the WebSocket session begins. On reconnect, the same endpoint is re-fetched instead of clearing the feed.

---

## Raw Packet Signal Data

RSSI, SNR, and payload type are stored in the database at ingest time (migration 47). This enables:

- SNR/RSSI scatter charts in My Node
- Packets by Type stacked chart
- SNR/RSSI history for all historical time windows
- Hash mode badge in the packet feed

The timeseries endpoint (`GET /api/packets/timeseries`) returns `avg_rssi`, `avg_snr`, and `type_counts` per bin when these columns exist. It includes `has_signal_data` and `has_type_data` flags so the frontend renders charts conditionally.

---

## Channel Finder Fixes

Two bugs in the channel cracker corrected:

- **Queue staleness** — the effect that enqueued new `GROUP_TEXT` packets was depending on array length rather than array reference, missing packets that arrived during active cracking. Fixed to `[undecryptedGroupText]`.
- **Undecrypted count drift** — replaced 2-minute polling with a per-packet refresh that fires immediately after each decrypt/fail sequence. The count no longer drifts 50+ packets behind.

---

## Country Flag Emoji (Windows)

Country flag emoji (🇳🇱, 🇬🇧, etc.) render correctly on Windows/Chromium, which does not support regional indicator pairs in Segoe UI Emoji.

The fix uses `country-flag-emoji-polyfill`, which detects missing flag support at runtime and injects a `@font-face` rule backed by a bundled `TwemojiCountryFlags.woff2` COLR subset font (77 kB served from `public/fonts/`). No CDN dependency — fully offline. The font's `unicode-range` (U+1F1E6–1F1FF) restricts it to flag sequences only; all other text rendering is unchanged.

---

## Settings Added by This Fork

| Setting | Location | Description |
|---------|----------|-------------|
| Show mention ticker | Settings → Local | Toggle the @mention notification strip |
| Show warning ticker | Settings → Local | Toggle the mesh health warning strip |

---

## meshcore-nl-discovered-channels Integration

This fork's Channel Registry is schema-compatible with the [meshcore-nl-discovered-channels](https://github.com/Elektr0Vodka/meshcore-nl-discovered-channels) public channel directory. You can:

- **Import** the project's `channels.json` directly into the Channel Registry.
- **Export** your registry as a `channels.json` that can be submitted to the directory.
- The Dutch geo auto-fill feature uses an offline copy of the municipality/province/veiligheidsregio dataset from that project.
