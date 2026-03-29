import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, MapPin } from 'lucide-react';
import { api } from '../api';
import { formatTime } from '../utils/messageParser';
import {
  getContactDisplayName,
  isPrefixOnlyContact,
} from '../utils/pubkey';
import {
  isValidLocation,
  calculateDistance,
  formatDistance,
  parsePathHops,
} from '../utils/pathUtils';
import { getMapFocusHash } from '../utils/urlHash';
import { ContactAvatar } from './ContactAvatar';
import { toast } from './ui/sonner';
import { useDistanceUnit } from '../contexts/DistanceUnitContext';
import type {
  Contact,
  ContactAnalytics,
  ContactAnalyticsHourlyBucket,
  ContactAnalyticsWeeklyBucket,
  Conversation,
  RadioConfig,
} from '../types';
import { isPublicChannelKey } from '../utils/publicChannel';

const CONTACT_TYPE_LABELS: Record<number, string> = {
  0: 'Unknown',
  1: 'Client',
  2: 'Repeater',
  3: 'Room',
  4: 'Sensor',
};

interface ContactAnalyticsViewProps {
  publicKey: string;
  displayName: string;
  config: RadioConfig | null;
  contacts: Contact[];
  onSelectConversation?: (conversation: Conversation) => void;
}

// ─── Shared chart primitives ──────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
      {children}
    </h3>
  );
}

function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function ChartLegend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2 text-[11px] text-muted-foreground">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: item.color }}
            aria-hidden="true"
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function ActivityLineChart<T extends ContactAnalyticsHourlyBucket | ContactAnalyticsWeeklyBucket>({
  ariaLabel,
  points,
  series,
  tickFormatter,
  valueFormatter,
}: {
  ariaLabel: string;
  points: T[];
  series: Array<{ key: keyof T; color: string }>;
  tickFormatter: (point: T) => string;
  valueFormatter: (value: number) => string;
}) {
  const width = 560;
  const height = 140;
  const padding = { top: 8, right: 8, bottom: 24, left: 36 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const allValues = points.flatMap((point) =>
    series.map((entry) => {
      const value = point[entry.key];
      return typeof value === 'number' ? value : 0;
    })
  );
  const maxValue = Math.max(1, ...allValues);

  const tickIndices = Array.from(
    new Set([
      0,
      Math.floor((points.length - 1) / 3),
      Math.floor(((points.length - 1) * 2) / 3),
      points.length - 1,
    ])
  );

  const buildPolyline = (key: keyof T) =>
    points
      .map((point, index) => {
        const rawValue = point[key];
        const value = typeof rawValue === 'number' ? rawValue : 0;
        const x =
          padding.left + (points.length === 1 ? 0 : (index / (points.length - 1)) * plotWidth);
        const y = padding.top + plotHeight - (value / maxValue) * plotHeight;
        return `${x},${y}`;
      })
      .join(' ');

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-auto"
      role="img"
      aria-label={ariaLabel}
    >
      {[0, 0.5, 1].map((ratio) => {
        const y = padding.top + plotHeight - ratio * plotHeight;
        const value = maxValue * ratio;
        return (
          <g key={ratio}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y}
              y2={y}
              stroke="hsl(var(--border))"
              strokeWidth={0.5}
            />
            <text
              x={padding.left - 4}
              y={y + 4}
              textAnchor="end"
              fontSize={9}
              fill="hsl(var(--muted-foreground))"
            >
              {valueFormatter(value)}
            </text>
          </g>
        );
      })}

      {tickIndices.map((idx) => {
        const point = points[idx];
        const x =
          padding.left + (points.length === 1 ? 0 : (idx / (points.length - 1)) * plotWidth);
        return (
          <text
            key={idx}
            x={x}
            y={height - 4}
            textAnchor="middle"
            fontSize={9}
            fill="hsl(var(--muted-foreground))"
          >
            {tickFormatter(point)}
          </text>
        );
      })}

      {series.map((entry) => (
        <polyline
          key={String(entry.key)}
          points={buildPolyline(entry.key)}
          fill="none"
          stroke={entry.color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

// Weekly bar chart (no rolling average needed — just raw counts per week)
function WeeklyBarChart({ points }: { points: ContactAnalyticsWeeklyBucket[] }) {
  const max = Math.max(1, ...points.map((p) => p.message_count));
  const width = 560;
  const height = 100;
  const pad = { top: 8, right: 8, bottom: 20, left: 36 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const barW = Math.max(2, plotW / points.length - 2);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img" aria-label="Messages per week">
      {[0, 0.5, 1].map((ratio) => {
        const y = pad.top + plotH - ratio * plotH;
        return (
          <g key={ratio}>
            <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="hsl(var(--border))" strokeWidth={0.5} />
            <text x={pad.left - 4} y={y + 4} textAnchor="end" fontSize={9} fill="hsl(var(--muted-foreground))">
              {Math.round(max * ratio)}
            </text>
          </g>
        );
      })}
      {points.map((p, i) => {
        const x = pad.left + (i / points.length) * plotW + (plotW / points.length - barW) / 2;
        const barH = (p.message_count / max) * plotH;
        const y = pad.top + plotH - barH;
        return (
          <rect key={p.bucket_start} x={x} y={y} width={barW} height={barH} fill="#16a34a" opacity={0.8} rx={1} />
        );
      })}
      {/* x-axis labels: first, middle, last */}
      {[0, Math.floor((points.length - 1) / 2), points.length - 1].map((idx) => {
        const p = points[idx];
        const x = pad.left + (idx / points.length) * plotW + plotW / points.length / 2;
        return (
          <text key={idx} x={x} y={height - 4} textAnchor="middle" fontSize={9} fill="hsl(var(--muted-foreground))">
            {new Date(p.bucket_start * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })}
          </text>
        );
      })}
    </svg>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ContactAnalyticsView({
  publicKey,
  displayName,
  config,
  contacts,
  onSelectConversation,
}: ContactAnalyticsViewProps) {
  const { distanceUnit } = useDistanceUnit();
  const [analytics, setAnalytics] = useState<ContactAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Live contact from WS
  const liveContact = useMemo(
    () => contacts.find((c) => c.public_key === publicKey) ?? null,
    [contacts, publicKey]
  );
  const contact = liveContact ?? analytics?.contact ?? null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getContactAnalytics({ publicKey })
      .then((data) => {
        if (!cancelled) setAnalytics(data);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Failed to fetch contact analytics:', err);
          setError('Failed to load analytics');
          toast.error('Failed to load analytics');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  const distFromUs = useMemo(() => {
    if (!contact || !config) return null;
    if (!isValidLocation(config.lat, config.lon) || !isValidLocation(contact.lat, contact.lon))
      return null;
    return calculateDistance(config.lat, config.lon, contact.lat, contact.lon);
  }, [contact, config]);

  const hasHourlyActivity = analytics?.hourly_activity.some(
    (b) => b.last_24h_count > 0 || b.last_week_average > 0 || b.all_time_average > 0
  ) ?? false;

  const hasWeeklyActivity = analytics?.weekly_activity.some((b) => b.message_count > 0) ?? false;

  const isPrefixOnly = isPrefixOnlyContact(publicKey);

  const resolvedDisplayName = contact
    ? getContactDisplayName(contact.name, contact.public_key, contact.last_advert)
    : displayName;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground transition-colors"
          onClick={() =>
            onSelectConversation?.({ type: 'contact', id: publicKey, name: resolvedDisplayName })
          }
          title="Back to conversation"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="font-semibold text-base truncate flex-1">
          Analytics — {resolvedDisplayName}
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && !analytics ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            Loading…
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-32 text-destructive">{error}</div>
        ) : (
          <div className="px-5 py-4 space-y-6">
            {/* Contact identity */}
            {contact && (
              <div className="flex items-start gap-4">
                <ContactAvatar
                  name={contact.name}
                  publicKey={contact.public_key}
                  size={52}
                  contactType={contact.type}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-base truncate">{resolvedDisplayName}</div>
                  <div className="text-xs font-mono text-muted-foreground truncate">
                    {contact.public_key}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                      {CONTACT_TYPE_LABELS[contact.type] ?? 'Unknown'}
                    </span>
                    {distFromUs !== null && (
                      <span className="text-[10px] text-muted-foreground">
                        {formatDistance(distFromUs, distanceUnit)} away
                      </span>
                    )}
                    {isValidLocation(contact.lat, contact.lon) && (
                      <button
                        type="button"
                        title="View on map"
                        className="text-muted-foreground hover:text-primary transition-colors"
                        onClick={() => {
                          const url =
                            window.location.origin +
                            window.location.pathname +
                            getMapFocusHash(contact.public_key);
                          window.open(url, '_blank');
                        }}
                      >
                        <MapPin className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Summary tiles */}
            <div>
              <SectionLabel>Summary</SectionLabel>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {analytics && (
                  <>
                    <StatTile
                      label="Total Messages"
                      value={(
                        (analytics.dm_message_count ?? 0) + analytics.channel_message_count
                      ).toLocaleString()}
                    />
                    {analytics.includes_direct_messages && (
                      <StatTile
                        label="Direct Messages"
                        value={(analytics.dm_message_count ?? 0).toLocaleString()}
                      />
                    )}
                    <StatTile
                      label="Channel Messages"
                      value={analytics.channel_message_count.toLocaleString()}
                    />
                    {analytics.advert_frequency !== null && (
                      <StatTile
                        label="Advert Freq"
                        value={`${analytics.advert_frequency}/hr`}
                      />
                    )}
                    {contact?.first_seen && (
                      <StatTile label="First Heard" value={formatTime(contact.first_seen)} />
                    )}
                    {contact?.last_seen && (
                      <StatTile label="Last Seen" value={formatTime(contact.last_seen)} />
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Weekly activity */}
            {analytics && hasWeeklyActivity && (
              <div>
                <SectionLabel>Messages Per Week</SectionLabel>
                <WeeklyBarChart points={analytics.weekly_activity} />
              </div>
            )}

            {/* Hourly pattern */}
            {analytics && hasHourlyActivity && (
              <div>
                <SectionLabel>Time-of-Day Pattern</SectionLabel>
                <ChartLegend
                  items={[
                    { label: 'Last 24h', color: '#2563eb' },
                    { label: '7-day avg', color: '#ea580c' },
                    { label: 'All-time avg', color: '#64748b' },
                  ]}
                />
                <ActivityLineChart
                  ariaLabel="Messages per hour of day"
                  points={analytics.hourly_activity}
                  series={[
                    { key: 'last_24h_count', color: '#2563eb' },
                    { key: 'last_week_average', color: '#ea580c' },
                    { key: 'all_time_average', color: '#64748b' },
                  ]}
                  valueFormatter={(v) => v.toFixed(v % 1 === 0 ? 0 : 1)}
                  tickFormatter={(b) =>
                    new Date(b.bucket_start * 1000).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })
                  }
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Compares the last 24 hours against 7-day and all-time averages for the same hour
                  slot.
                  {!analytics.includes_direct_messages && ' Channel messages only (name-only contact).'}
                </p>
              </div>
            )}

            {/* Nearest repeaters */}
            {analytics && analytics.nearest_repeaters.length > 0 && (
              <div>
                <SectionLabel>Nearest Repeaters</SectionLabel>
                <div className="space-y-1">
                  {analytics.nearest_repeaters.map((r) => (
                    <div key={r.public_key} className="flex justify-between items-center text-sm">
                      <span className="truncate">{r.name || r.public_key.slice(0, 12)}</span>
                      <span className="text-xs text-muted-foreground flex-shrink-0 ml-2">
                        {r.path_len === 0
                          ? 'direct'
                          : `${r.path_len} hop${r.path_len > 1 ? 's' : ''}`}{' '}
                        · {r.heard_count}×
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Advert paths */}
            {analytics && analytics.advert_paths.length > 0 && (
              <div>
                <SectionLabel>Recent Advert Paths</SectionLabel>
                <div className="space-y-1.5">
                  {analytics.advert_paths.map((p) => {
                    const hopBytes = p.hash_mode != null ? p.hash_mode + 1 : null;
                    const modeLabel = hopBytes != null ? `${hopBytes}` : '?';
                    const hops = parsePathHops(p.path, p.path_len);
                    return (
                      <div
                        key={p.path + p.first_seen}
                        className="flex justify-between items-start text-sm gap-2"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className="shrink-0 rounded px-1 py-px text-[9px] font-bold uppercase tracking-wide bg-muted text-muted-foreground"
                            title={
                              hopBytes != null
                                ? `${hopBytes}-byte hop addresses (mode ${p.hash_mode})`
                                : 'Hop address width unknown'
                            }
                          >
                            {modeLabel}
                          </span>
                          <span className="font-mono text-xs truncate">
                            {hops.length > 0 ? hops.join(' → ') : '(direct)'}
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {p.heard_count}× · {formatTime(p.last_seen)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Most active channels */}
            {analytics && analytics.most_active_rooms.length > 0 && (
              <div>
                <SectionLabel>Most Active Channels</SectionLabel>
                <div className="space-y-1">
                  {analytics.most_active_rooms.map((ch) => (
                    <div key={ch.channel_key} className="flex justify-between items-center text-sm">
                      <span className="truncate">
                        {ch.channel_name.startsWith('#') || isPublicChannelKey(ch.channel_key)
                          ? ch.channel_name
                          : `#${ch.channel_name}`}
                      </span>
                      <span className="text-xs text-muted-foreground flex-shrink-0 ml-2">
                        {ch.message_count.toLocaleString()} msg
                        {ch.message_count !== 1 ? 's' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Name history */}
            {analytics && analytics.name_history.length > 1 && (
              <div>
                <SectionLabel>Also Known As</SectionLabel>
                <div className="space-y-1">
                  {analytics.name_history.map((h) => (
                    <div key={h.name} className="flex justify-between items-center text-sm">
                      <span className="font-medium truncate">{h.name}</span>
                      <span className="text-xs text-muted-foreground flex-shrink-0 ml-2">
                        {formatTime(h.first_seen)} – {formatTime(h.last_seen)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Prefix-only note */}
            {isPrefixOnly && (
              <p className="text-xs text-muted-foreground border border-dashed border-border rounded p-3">
                Only a key prefix is known for this contact. Analytics may be incomplete until a
                full advertisement is received.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
