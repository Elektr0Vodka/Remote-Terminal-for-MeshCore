# MQTT Architecture

RemoteTerm implements two independent MQTT publishing systems that share a common base class:

1. **Private MQTT** — forwards mesh events to a user-configured broker (home automation, logging, alerting)
2. **Community MQTT** — shares raw RF packets with the MeshCore community aggregator for coverage mapping

Both are optional, configured entirely through the Settings UI, and require no server restart.

## File Map

```
app/
├── mqtt_base.py           # BaseMqttPublisher — shared lifecycle, connection loop, reconnect
├── mqtt.py                # MqttPublisher — private broker forwarding
├── community_mqtt.py      # CommunityMqttPublisher — community aggregator integration
├── keystore.py            # In-memory Ed25519 key storage (community auth)
├── models.py              # AppSettings — all MQTT fields (14 total)
├── repository/settings.py # Database CRUD for MQTT settings
├── routers/settings.py    # PATCH /api/settings — validates + restarts publishers
├── routers/health.py      # GET /api/health — mqtt_status, community_mqtt_status
├── websocket.py           # broadcast_event() — fans out to WS + both MQTT publishers
└── migrations.py          # Migration 031 (private fields), 032 (community fields)

frontend/src/
├── components/settings/SettingsMqttSection.tsx  # Dual collapsible settings UI
└── types.ts                                     # AppSettings, AppSettingsUpdate, HealthStatus

tests/
├── test_mqtt.py                  # Topic routing, lifecycle
├── test_community_mqtt.py        # JWT generation, packet format, hash, broadcast
└── test_health_mqtt_status.py    # Health endpoint status reporting
```

## Base Publisher (`app/mqtt_base.py`)

`BaseMqttPublisher` is an abstract class that manages the full MQTT client lifecycle for both publishers. Subclasses implement hooks; the base class owns the connection loop.

### Connection Loop

The `_connection_loop()` runs as a background `asyncio.Task` and never exits unless cancelled:

```
loop:
  ├─ _is_configured()? No → call _on_not_configured(), wait for settings change, loop
  ├─ _pre_connect()? False → wait and retry
  ├─ Build client via _build_client_kwargs()
  ├─ Connect with aiomqtt.Client
  ├─ Set connected=True, broadcast success toast via _on_connected()
  ├─ Wait in 60s intervals:
  │   ├─ _on_periodic_wake(elapsed) → subclass hook (e.g., periodic status republish)
  │   ├─ Settings version changed? → break, reconnect with new settings
  │   ├─ _should_break_wait()? → break (e.g., JWT expiry)
  │   └─ Otherwise keep waiting (paho-mqtt handles keepalive internally)
  ├─ On error: set connected=False, broadcast error toast, exponential backoff
  └─ On cancel: cleanup and exit
```

### Abstract Hooks

| Hook | Returns | Purpose |
|------|---------|---------|
| `_is_configured()` | `bool` | Should the publisher attempt to connect? |
| `_build_client_kwargs(settings)` | `dict` | Arguments for `aiomqtt.Client(...)` |
| `_on_connected(settings)` | `(title, detail)` | Success toast content |
| `_on_error()` | `(title, detail)` | Error toast content |

### Optional Hooks

| Hook | Default | Purpose |
|------|---------|---------|
| `_pre_connect(settings)` | `return True` | Async setup before connect; return `False` to retry |
| `_should_break_wait(elapsed)` | `return False` | Force reconnect while connected (e.g., token renewal) |
| `_on_not_configured()` | no-op | Called repeatedly while waiting for configuration |
| `_on_periodic_wake(elapsed)` | no-op | Called every ~60s while connected (e.g., periodic status republish) |

### Lifecycle Methods

- `start(settings)` — stores settings, starts the background loop task
- `stop()` — cancels the task, disconnects the client
- `restart(settings)` — `stop()` then `start()` (called when settings change)
- `publish(topic, payload)` — JSON-serializes and publishes; silently drops if disconnected

### Backoff

Reconnect delay: 5 seconds minimum, exponential growth, capped at `_backoff_max` (30s for private, 60s for community). Resets on successful connect.

### QoS

All publishing uses QoS 0 (at-most-once delivery), the aiomqtt default.

## Private MQTT (`app/mqtt.py`)

### When It Connects

`_is_configured()` returns `True` when all of:
- `mqtt_broker_host` is non-empty
- At least one of `mqtt_publish_messages` or `mqtt_publish_raw_packets` is enabled

If the user unchecks both publish toggles and saves, the publisher disconnects and the health status shows "Disabled".

### Client Configuration

```python
hostname:    settings.mqtt_broker_host
port:        settings.mqtt_broker_port (default 1883)
username:    settings.mqtt_username or None
password:    settings.mqtt_password or None
tls_context: ssl.create_default_context() if mqtt_use_tls, else None
             # mqtt_tls_insecure=True disables hostname check + cert verification
```

TLS is opt-in. When enabled with `mqtt_tls_insecure`, both `check_hostname` and `verify_mode` are relaxed for self-signed certificates.

### Topic Structure

Default prefix: `meshcore` (configurable via `mqtt_topic_prefix`).

**Decrypted messages** (when `mqtt_publish_messages` is on):
- `{prefix}/dm:{contact_key}` — private DM
- `{prefix}/gm:{channel_key}` — channel message
- `{prefix}/message:{conversation_key}` — fallback for unknown type

**Raw packets** (when `mqtt_publish_raw_packets` is on):
- `{prefix}/raw/dm:{contact_key}` — attributed to a DM contact
- `{prefix}/raw/gm:{channel_key}` — attributed to a channel
- `{prefix}/raw/unrouted` — unattributed

Topic routing uses `decrypted_info.contact_key` and `decrypted_info.channel_key` from the raw packet data.

### Fire-and-Forget Pattern

`mqtt_broadcast(event_type, data)` is called synchronously from `broadcast_event()` in `websocket.py`. It filters to only `"message"` and `"raw_packet"` events, then creates an `asyncio.Task` for the actual publish. No awaiting — failures are logged at WARNING level and silently dropped.

## Community MQTT (`app/community_mqtt.py`)

Implements the [meshcore-packet-capture](https://github.com/agessaman/meshcore-packet-capture) protocol for sharing raw RF packets with the MeshCore community aggregator.

### When It Connects

`_is_configured()` returns `True` when all of:
- `community_mqtt_enabled` is `True`
- The radio's private key is available in the keystore (`has_private_key()`)

The private key is exported from the radio firmware on startup via `export_and_store_private_key()` in `app/keystore.py`. This requires `ENABLE_PRIVATE_KEY_EXPORT` to be enabled in the radio firmware. If unavailable, the publisher broadcasts a warning and waits.

### Client Configuration

```python
hostname:       community_mqtt_broker_host or "mqtt-us-v1.letsmesh.net"
port:           community_mqtt_broker_port or 443
transport:      "websockets"
tls_context:    ssl.create_default_context()  # always enforced, not user-configurable
websocket_path: "/"
username:       "v1_{pubkey_hex}"
password:       {jwt_token}
```

TLS is always on — the community connection uses WebSocket Secure (WSS) with full certificate verification. There is no option to disable it.

### JWT Authentication

The community broker authenticates via Ed25519-signed JWT tokens.

**Token format:** `header_b64url.payload_b64url.signature_hex`

**Header:**
```json
{"alg": "Ed25519", "typ": "JWT"}
```

**Payload:**
```json
{
  "publicKey": "{PUBKEY_HEX_UPPER}",
  "iat": 1234567890,
  "exp": 1234654290,
  "aud": "{broker_host}",
  "owner": "{PUBKEY_HEX_UPPER}",
  "client": "RemoteTerm (github.com/jkingsman/Remote-Terminal-for-MeshCore)",
  "email": "user@example.com"  // optional, only if configured
}
```

**Signing:** MeshCore uses an "expanded" 64-byte Ed25519 key format (`scalar[32] || prefix[32]`, the "orlp" format). Standard Ed25519 libraries expect seed format and would re-hash the key. The `_ed25519_sign_expanded()` function performs signing manually using `nacl.bindings.crypto_scalarmult_ed25519_base_noclamp()` — a direct port of meshcore-packet-capture's `ed25519_sign_with_expanded_key()`.

**Token lifetime:** 24 hours. The `_should_break_wait()` hook forces a reconnect at the 23-hour mark to renew before expiry.

### Status Messages

On connect and every 5 minutes thereafter, the community publisher sends a retained status message to `meshcore/{IATA}/{PUBKEY}/status` with device info and radio telemetry:

```json
{
  "status":            "online",
  "timestamp":         "2024-01-15T10:30:00.000000",
  "origin":            "NodeName",
  "origin_id":         "PUBKEY_HEX_UPPER",
  "model":             "T-Deck",
  "firmware_version":  "v2.2.2 (Build: 2025-01-15)",
  "radio":             "915.0,250.0,10,8",
  "client_version":    "RemoteTerm 2.4.0",
  "stats": {
    "battery_mv": 4200,
    "uptime_secs": 3600,
    "errors": 0,
    "queue_len": 0,
    "noise_floor": -120,
    "last_rssi": -85,
    "last_snr": 10.5,
    "tx_air_secs": 42,
    "rx_air_secs": 150
  }
}
```

- `model` and `firmware_version` are fetched once per connection via `send_device_query()` (requires firmware version >= 3)
- `radio` is comma-separated raw values from `self_info` (freq, BW, SF, CR) matching the reference format
- `client_version` is read from Python package metadata (`remoteterm-meshcore`)
- `stats` is fetched from `get_stats_core()` + `get_stats_radio()` every 5 minutes; omitted if firmware doesn't support stats commands
- All radio queries use `blocking=False` — if the radio is busy, cached values are used. No user-facing operations are ever blocked.
- LWT (Last Will and Testament) publishes `{"status": "offline", ...}` on the same topic with retain

### Packet Formatting

`_format_raw_packet()` converts raw packet broadcast data into the meshcore-packet-capture JSON format:

```json
{
  "origin":      "NodeName",
  "origin_id":   "PUBKEY_HEX_UPPER",
  "timestamp":   "2024-01-15T10:30:00.000000",
  "type":        "PACKET",
  "direction":   "rx",
  "time":        "10:30:00",
  "date":        "15/01/2024",
  "len":         "42",
  "packet_type": "5",
  "route":       "F",
  "payload_len": "30",
  "raw":         "AABBCCDD...",
  "SNR":         "10.5",
  "RSSI":        "-85",
  "hash":        "A1B2C3D4E5F6G7H8",
  "path":        "ab,cd,ef"
}
```

- `origin` is the radio's device name from `meshcore.self_info`
- `route` is derived from the header's bottom 2 bits: `0,1→"F"` (Flood), `2→"D"` (Direct), `3→"T"` (Trace)
- `path` is only present when `route=="D"`
- `hash` matches MeshCore's C++ `Packet::calculatePacketHash()`: SHA-256 of `payload_type[1 byte] + [path_len as uint16 LE, TRACE only] + payload_data`, truncated to first 16 hex characters

### Topic Structure

```
meshcore/{IATA}/{PUBKEY_HEX}/packets
```

IATA must be exactly 3 uppercase letters (e.g., `DEN`, `LAX`). Validated both client-side (input maxLength + uppercase conversion) and server-side (regex `^[A-Z]{3}$`, returns HTTP 400 on failure).

### Only Raw Packets

The community publisher only handles `"raw_packet"` events. Decrypted messages are never shared with the community — `community_mqtt_broadcast()` explicitly filters `event_type != "raw_packet"`.

## Event Flow

```
Radio RF event
  ↓
meshcore_py library callback
  ↓
app/event_handlers.py (on_contact_message, on_rx_log_data, etc.)
  ↓
Store to SQLite database
  ↓
broadcast_event(event_type, data)   ← app/websocket.py
  ├─ WebSocket → browser clients
  ├─ mqtt_broadcast()               ← app/mqtt.py (messages + raw packets)
  │   └─ asyncio.create_task(_mqtt_maybe_publish())
  └─ community_mqtt_broadcast()     ← app/community_mqtt.py (raw packets only)
      └─ asyncio.create_task(_community_maybe_publish())
```

## Settings & Persistence

### Database Fields (`app_settings` table)

**Private MQTT** (Migration 031):

| Column | Type | Default |
|--------|------|---------|
| `mqtt_broker_host` | TEXT | `''` |
| `mqtt_broker_port` | INTEGER | `1883` |
| `mqtt_username` | TEXT | `''` |
| `mqtt_password` | TEXT | `''` |
| `mqtt_use_tls` | INTEGER | `0` |
| `mqtt_tls_insecure` | INTEGER | `0` |
| `mqtt_topic_prefix` | TEXT | `'meshcore'` |
| `mqtt_publish_messages` | INTEGER | `0` |
| `mqtt_publish_raw_packets` | INTEGER | `0` |

**Community MQTT** (Migration 032):

| Column | Type | Default |
|--------|------|---------|
| `community_mqtt_enabled` | INTEGER | `0` |
| `community_mqtt_iata` | TEXT | `''` |
| `community_mqtt_broker_host` | TEXT | `'mqtt-us-v1.letsmesh.net'` |
| `community_mqtt_broker_port` | INTEGER | `443` |
| `community_mqtt_email` | TEXT | `''` |

### Settings API

`PATCH /api/settings` accepts any subset of MQTT fields. The router tracks whether private or community fields changed independently:

- If any private MQTT field changed → `await mqtt_publisher.restart(result)`
- If any community MQTT field changed → `await community_publisher.restart(result)`

This means toggling a publish checkbox triggers a full disconnect/reconnect cycle.

### Health API

`GET /api/health` reports both statuses:

```json
{
  "mqtt_status": "connected | disconnected | disabled",
  "community_mqtt_status": "connected | disconnected | disabled"
}
```

Status logic for each publisher:
- `_is_configured()` returns `True` → report `"connected"` or `"disconnected"` based on `publisher.connected`
- `_is_configured()` returns `False` → report `"disabled"`

## App Lifecycle

**Startup** (in `app/main.py` lifespan):
1. Database connects, radio connects
2. `export_and_store_private_key()` — export Ed25519 key from radio (needed for community auth)
3. Load `AppSettings` from database
4. `mqtt_publisher.start(settings)` — spawns background connection loop
5. `community_publisher.start(settings)` — spawns background connection loop

**Shutdown:**
1. `community_publisher.stop()`
2. `mqtt_publisher.stop()`
3. Radio and database cleanup

## Frontend (`SettingsMqttSection.tsx`)

The MQTT settings UI is a single React component with two collapsible sections (both collapsed by default):

### Private MQTT Broker Section
- Header shows connection status indicator (green/red/gray dot + label)
- Always visible when expanded: Publish Messages and Publish Raw Packets checkboxes
- Broker configuration (host, port, username, password, TLS, topic prefix) only revealed when at least one publish checkbox is checked
- Responsive grid layout (`grid-cols-1 sm:grid-cols-2`) for host+port and username+password pairs

### Community Analytics Section
- Header shows connection status indicator
- Enable Community Analytics checkbox
- When enabled: broker host/port, IATA code input (3 chars, auto-uppercase), owner email
- Broker host shows "MQTT over TLS (WebSocket Secure) only" note

### Shared
- Beta warning banner at the top (links to GitHub issues)
- Single "Save MQTT Settings" button outside both collapsibles
- Save constructs an `AppSettingsUpdate` and calls `PATCH /api/settings`
- Success/error feedback via toast notifications

## Security Notes

- **Private MQTT password** is stored in plaintext in SQLite, consistent with the project's trusted-network design.
- **Community MQTT** always uses TLS with full certificate verification. The Ed25519 private key is held in memory only (never persisted to disk) and is used solely for JWT signing.
- **Community data** is limited to raw RF packets — decrypted message content is never shared.
