/**
 * MeshHealthView.tsx
 *
 * Mesh health monitoring page — shows advert frequency alerts for contacts
 * that are advertising too often, plus a full node-DB style contacts table.
 */

import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react';
import type { RadioConfig } from '../types';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MeshHealthContact {
  public_key: string;
  name: string | null;
  advert_count: number;
  first_seen: number | null;
  last_seen: number | null;
  lat: number | null;
  lon: number | null;
  min_path_len: number | null;
}

interface MeshHealthAlert {
  level: 'HIGH' | 'MEDIUM';
  public_key: string;
  name: string | null;
  advert_count: number;
  adverts_per_hour: number;
}

interface MeshHealthResponse {
  start_ts: number;
  end_ts: number;
  window_hours: number;
  total_contacts: number;
  high_alert_count: number;
  medium_alert_count: number;
  alerts: MeshHealthAlert[];
  contacts: MeshHealthContact[];
}

// ─── Time windows ───────────────────────────────────────────────────────────

interface TimeWindow {
  key: string;
  label: string;
  hours: number;
}

const TIME_WINDOWS: TimeWindow[] = [
  { key: '1h',  label: '1h',  hours: 1  },
  { key: '6h',  label: '6h',  hours: 6  },
  { key: '12h', label: '12h', hours: 12 },
  { key: '24h', label: '24h', hours: 24 },
  { key: '7d',  label: '7d',  hours: 168 },
];

const DEFAULT_WINDOW = TIME_WINDOWS[2]; // 12h default

// ─── Props ──────────────────────────────────────────────────────────────────

interface Props {
  config: RadioConfig | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function relTime(unixSec: number | null | undefined): string {
  if (unixSec == null) return 'Never';
  const d = Date.now() - unixSec * 1000;
  if (d < 0) return 'just now';
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function StatTile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded border border-border bg-background p-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function MeshHealthView({ config }: Props) {
  const [selectedWindow, setSelectedWindow] = useState<TimeWindow>(DEFAULT_WINDOW);
  const [data, setData] = useState<MeshHealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  // Tick nowSec every 60s to trigger periodic refreshes
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(id);
  }, []);

  const fetchHealth = useCallback(
    (window: TimeWindow) => {
      const endTs = Math.floor(Date.now() / 1000);
      const startTs = endTs - window.hours * 3600;
      setLoading(true);
      setError(null);
      fetch(`/api/packets/mesh-health?start_ts=${startTs}&end_ts=${endTs}`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<MeshHealthResponse>;
        })
        .then((d) => {
          setData(d);
          setLoading(false);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Failed to load');
          setLoading(false);
        });
    },
    []
  );

  useEffect(() => {
    fetchHealth(selectedWindow);
  }, [selectedWindow, nowSec, fetchHealth]);

  const highAlerts = data?.alerts.filter((a) => a.level === 'HIGH') ?? [];
  const mediumAlerts = data?.alerts.filter((a) => a.level === 'MEDIUM') ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold text-base">Mesh Health</h2>
        </div>
        <button
          onClick={() => fetchHealth(selectedWindow)}
          disabled={loading}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-40"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-4">

          {/* Time window selector */}
          <div className="flex gap-1">
            {TIME_WINDOWS.map((w) => (
              <button
                key={w.key}
                onClick={() => setSelectedWindow(w)}
                className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                  selectedWindow.key === w.key
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Summary tiles */}
          {data && (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <StatTile label="Contacts Heard" value={data.total_contacts} sub={`last ${selectedWindow.label}`} />
              <StatTile label="HIGH Alerts" value={data.high_alert_count} sub="> 8 adverts" />
              <StatTile label="MEDIUM Alerts" value={data.medium_alert_count} sub="> 2 adverts" />
              <StatTile label="Window" value={`${selectedWindow.label}`} sub={`${data.window_hours.toFixed(1)}h`} />
            </div>
          )}
          {loading && !data && (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {[0,1,2,3].map((i) => (
                <div key={i} className="h-16 rounded border border-border bg-background animate-pulse" />
              ))}
            </div>
          )}

          {/* HIGH alerts */}
          {highAlerts.length > 0 && (
            <div className="rounded-lg border border-destructive/40 bg-card overflow-hidden">
              <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                <span className="text-sm font-semibold text-destructive">HIGH — Advertising Too Frequently</span>
                <span className="ml-auto text-[10px] text-destructive/70">{highAlerts.length} node{highAlerts.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="divide-y divide-border">
                {highAlerts.map((a) => (
                  <AlertRow key={a.public_key} alert={a} />
                ))}
              </div>
            </div>
          )}

          {/* MEDIUM alerts */}
          {mediumAlerts.length > 0 && (
            <div className="rounded-lg border border-yellow-500/40 bg-card overflow-hidden">
              <div className="border-b border-yellow-500/30 bg-yellow-500/10 px-3 py-2 flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 text-yellow-600 dark:text-yellow-400" />
                <span className="text-sm font-semibold text-yellow-700 dark:text-yellow-300">MEDIUM — Above Normal Advert Rate</span>
                <span className="ml-auto text-[10px] text-yellow-600/70 dark:text-yellow-400/70">{mediumAlerts.length} node{mediumAlerts.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="divide-y divide-border">
                {mediumAlerts.map((a) => (
                  <AlertRow key={a.public_key} alert={a} />
                ))}
              </div>
            </div>
          )}

          {data && data.alerts.length === 0 && (
            <div className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              No advert frequency alerts in the last {selectedWindow.label}. Mesh looks healthy.
            </div>
          )}

          {/* Full contacts table */}
          {data && data.contacts.length > 0 && (
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <div className="border-b border-border px-3 py-2 flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-foreground">All Contacts Heard</span>
                <span className="text-[10px] text-muted-foreground">{data.contacts.length} nodes · last {selectedWindow.label}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-background">
                      <th className="px-2 py-1.5 text-left font-semibold text-muted-foreground w-8">ID</th>
                      <th className="px-2 py-1.5 text-left font-semibold text-muted-foreground">Name</th>
                      <th className="px-2 py-1.5 text-right font-semibold text-muted-foreground">Adverts</th>
                      <th className="px-2 py-1.5 text-right font-semibold text-muted-foreground">Last Heard</th>
                      <th className="px-2 py-1.5 text-right font-semibold text-muted-foreground hidden sm:table-cell">First Heard</th>
                      <th className="px-2 py-1.5 text-right font-semibold text-muted-foreground hidden md:table-cell">Hops</th>
                      <th className="px-2 py-1.5 text-right font-semibold text-muted-foreground hidden md:table-cell">Distance</th>
                      <th className="px-2 py-1.5 text-right font-semibold text-muted-foreground">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.contacts.map((n) => {
                      const shortId = n.public_key.slice(0, 4).toUpperCase();
                      const nowSecLocal = Math.floor(Date.now() / 1000);
                      const isActive = n.last_seen != null && nowSecLocal - n.last_seen < 3600;
                      const isHighAlert = n.advert_count > 8;
                      const isMedAlert = !isHighAlert && n.advert_count > 2;
                      const distKm =
                        config?.lat != null &&
                        config?.lon != null &&
                        n.lat != null &&
                        n.lon != null
                          ? haversineKm(config.lat, config.lon, n.lat, n.lon)
                          : null;
                      return (
                        <tr
                          key={n.public_key}
                          className="border-b border-border last:border-0 hover:bg-background transition-colors"
                        >
                          <td className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">{shortId}</td>
                          <td className="px-2 py-1.5 font-medium text-foreground max-w-[180px] truncate">
                            {n.name ?? n.public_key.slice(0, 12)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            <span
                              className={
                                isHighAlert
                                  ? 'font-semibold text-destructive'
                                  : isMedAlert
                                  ? 'font-semibold text-yellow-600 dark:text-yellow-400'
                                  : 'text-muted-foreground'
                              }
                            >
                              {n.advert_count}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">
                            {n.last_seen != null ? relTime(n.last_seen) : '—'}
                          </td>
                          <td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums hidden sm:table-cell">
                            {n.first_seen != null ? relTime(n.first_seen) : '—'}
                          </td>
                          <td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums hidden md:table-cell">
                            {n.min_path_len != null ? n.min_path_len : '—'}
                          </td>
                          <td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums hidden md:table-cell">
                            {distKm != null ? `${distKm.toFixed(0)} km` : '—'}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <span
                              className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                isActive
                                  ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                                  : 'bg-muted text-muted-foreground'
                              }`}
                            >
                              {isActive ? 'ACTIVE' : 'INACTIVE'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data && data.contacts.length === 0 && !loading && (
            <div className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              No contacts heard in the last {selectedWindow.label}.
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

// ─── Alert row sub-component ─────────────────────────────────────────────────

function AlertRow({ alert }: { alert: MeshHealthAlert }) {
  const shortId = alert.public_key.slice(0, 4).toUpperCase();
  const isHigh = alert.level === 'HIGH';
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className="font-mono text-[10px] text-muted-foreground w-8 flex-shrink-0">{shortId}</span>
      <span className="flex-1 truncate font-medium text-foreground text-xs">
        {alert.name ?? alert.public_key.slice(0, 12)}
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">
        {alert.advert_count} adverts
      </span>
      <span className="text-xs tabular-nums text-muted-foreground hidden sm:inline">
        {alert.adverts_per_hour.toFixed(1)}/hr
      </span>
      <span
        className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
          isHigh
            ? 'bg-destructive/15 text-destructive'
            : 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-300'
        }`}
      >
        {alert.level}
      </span>
    </div>
  );
}
