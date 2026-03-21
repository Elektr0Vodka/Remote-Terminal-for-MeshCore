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
