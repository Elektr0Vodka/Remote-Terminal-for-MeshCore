import { useState, useEffect } from 'react';
import { Separator } from '../ui/separator';
import { api } from '../../api';
import { toast } from '../ui/sonner';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import type { StatisticsResponse, AppSettings, AppSettingsUpdate } from '../../types';

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function SettingsStatisticsSection({
  className,
  appSettings,
  onSaveAppSettings,
}: {
  className?: string;
  appSettings?: AppSettings;
  onSaveAppSettings?: (update: AppSettingsUpdate) => Promise<void>;
}) {
  const [stats, setStats] = useState<StatisticsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState(false);
  const [highAdvertThreshold, setHighAdvertThreshold] = useState('');
  const [mediumAdvertThreshold, setMediumAdvertThreshold] = useState('');
  const [thresholdBusy, setThresholdBusy] = useState(false);
  const [thresholdError, setThresholdError] = useState<string | null>(null);

  useEffect(() => {
    if (appSettings) {
      setHighAdvertThreshold(String(appSettings.high_advert_threshold ?? 8));
      setMediumAdvertThreshold(String(appSettings.medium_advert_threshold ?? 2));
    }
  }, [appSettings]);

  useEffect(() => {
    let cancelled = false;
    setStatsLoading(true);
    setStatsError(false);
    api.getStatistics().then(
      (data) => {
        if (!cancelled) {
          setStats(data);
          setStatsLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setStatsError(true);
          setStatsLoading(false);
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaveThresholds = async () => {
    if (!onSaveAppSettings || !appSettings) return;
    setThresholdError(null);
    setThresholdBusy(true);

    try {
      const update: AppSettingsUpdate = {};
      const newHighThreshold = parseInt(highAdvertThreshold, 10);
      if (!isNaN(newHighThreshold) && newHighThreshold !== (appSettings.high_advert_threshold ?? 8)) {
        update.high_advert_threshold = newHighThreshold;
      }
      const newMediumThreshold = parseInt(mediumAdvertThreshold, 10);
      if (!isNaN(newMediumThreshold) && newMediumThreshold !== (appSettings.medium_advert_threshold ?? 2)) {
        update.medium_advert_threshold = newMediumThreshold;
      }
      if (Object.keys(update).length > 0) {
        await onSaveAppSettings(update);
      }
      toast.success('Thresholds saved');
    } catch (err) {
      setThresholdError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setThresholdBusy(false);
    }
  };

  return (
    <div className={className}>
      {statsLoading && !stats ? (
        <div className="py-8 text-center text-muted-foreground">
          Loading statistics... this can take a while if you have a lot of stored packets.
        </div>
      ) : stats ? (
        <div className="space-y-6">
          {/* Network */}
          <div>
            <h4 className="text-sm font-medium mb-2">Network</h4>
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center p-3 bg-muted/50 rounded-md">
                <div className="text-2xl font-bold">{stats.contact_count}</div>
                <div className="text-xs text-muted-foreground">Contacts</div>
              </div>
              <div className="text-center p-3 bg-muted/50 rounded-md">
                <div className="text-2xl font-bold">{stats.repeater_count}</div>
                <div className="text-xs text-muted-foreground">Repeaters</div>
              </div>
              <div className="text-center p-3 bg-muted/50 rounded-md">
                <div className="text-2xl font-bold">{stats.channel_count}</div>
                <div className="text-xs text-muted-foreground">Channels</div>
              </div>
            </div>
          </div>

          <Separator />

          {/* Messages */}
          <div>
            <h4 className="text-sm font-medium mb-2">Messages</h4>
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center p-3 bg-muted/50 rounded-md">
                <div className="text-2xl font-bold">{stats.total_dms}</div>
                <div className="text-xs text-muted-foreground">Direct Messages</div>
              </div>
              <div className="text-center p-3 bg-muted/50 rounded-md">
                <div className="text-2xl font-bold">{stats.total_channel_messages}</div>
                <div className="text-xs text-muted-foreground">Channel Messages</div>
              </div>
              <div className="text-center p-3 bg-muted/50 rounded-md">
                <div className="text-2xl font-bold">{stats.total_outgoing}</div>
                <div className="text-xs text-muted-foreground">Sent (Outgoing)</div>
              </div>
            </div>
          </div>

          <Separator />

          {/* Packets */}
          <div>
            <h4 className="text-sm font-medium mb-2">Packets</h4>
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Total stored</span>
                <span className="font-medium">{stats.total_packets}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-success">Decrypted</span>
                <span className="font-medium text-success">{stats.decrypted_packets}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-warning">Undecrypted</span>
                <span className="font-medium text-warning">{stats.undecrypted_packets}</span>
              </div>
            </div>
          </div>

          {stats.path_hash_width_24h && (
            <>
              <Separator />

              <div>
                <h4 className="text-sm font-medium mb-2">Path Hash Width (24h)</h4>
                <div className="mb-2 text-xs text-muted-foreground">
                  Parsed stored raw packets from the last 24 hours:{' '}
                  {stats.path_hash_width_24h.total_packets}
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between items-center text-sm">
                    <span>1-byte hops</span>
                    <span className="text-muted-foreground">
                      {stats.path_hash_width_24h.single_byte} (
                      {formatPercent(stats.path_hash_width_24h.single_byte_pct)})
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-sm">
                    <span>2-byte hops</span>
                    <span className="text-muted-foreground">
                      {stats.path_hash_width_24h.double_byte} (
                      {formatPercent(stats.path_hash_width_24h.double_byte_pct)})
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-sm">
                    <span>3-byte hops</span>
                    <span className="text-muted-foreground">
                      {stats.path_hash_width_24h.triple_byte} (
                      {formatPercent(stats.path_hash_width_24h.triple_byte_pct)})
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}

          <Separator />

          {/* Activity */}
          <div>
            <h4 className="text-sm font-medium mb-2">Activity</h4>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="text-left font-normal pb-1"></th>
                  <th className="text-right font-normal pb-1">1h</th>
                  <th className="text-right font-normal pb-1">24h</th>
                  <th className="text-right font-normal pb-1">7d</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="py-1">Contacts heard</td>
                  <td className="text-right py-1">{stats.contacts_heard.last_hour}</td>
                  <td className="text-right py-1">{stats.contacts_heard.last_24_hours}</td>
                  <td className="text-right py-1">{stats.contacts_heard.last_week}</td>
                </tr>
                <tr>
                  <td className="py-1">Repeaters heard</td>
                  <td className="text-right py-1">{stats.repeaters_heard.last_hour}</td>
                  <td className="text-right py-1">{stats.repeaters_heard.last_24_hours}</td>
                  <td className="text-right py-1">{stats.repeaters_heard.last_week}</td>
                </tr>
                <tr>
                  <td className="py-1">Known-channels active</td>
                  <td className="text-right py-1">{stats.known_channels_active.last_hour}</td>
                  <td className="text-right py-1">{stats.known_channels_active.last_24_hours}</td>
                  <td className="text-right py-1">{stats.known_channels_active.last_week}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Busiest Channels */}
          {stats.busiest_channels_24h.length > 0 && (
            <>
              <Separator />
              <div>
                <h4 className="text-sm font-medium mb-2">Busiest Channels (24h)</h4>
                <div className="space-y-1">
                  {stats.busiest_channels_24h.map((ch, i) => (
                    <div key={ch.channel_key} className="flex justify-between items-center text-sm">
                      <span>
                        <span className="text-muted-foreground mr-2">{i + 1}.</span>
                        {ch.channel_name}
                      </span>
                      <span className="text-muted-foreground">{ch.message_count} msgs</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {appSettings && (
            <>
              <Separator />

              {/* Mesh Health Alert Thresholds */}
              <div>
                <h4 className="text-sm font-medium mb-4">Mesh Health Alert Thresholds</h4>
                <p className="text-xs text-muted-foreground mb-4">
                  Configure advert count thresholds for mesh health alerts. Customize these to match
                  region-specific advert guidelines (e.g., 1 advert per 24h vs 50 adverts per 24h).
                </p>
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div className="space-y-2">
                    <Label htmlFor="high-threshold">HIGH Alert Threshold</Label>
                    <Input
                      id="high-threshold"
                      type="number"
                      min="1"
                      value={highAdvertThreshold}
                      onChange={(e) => setHighAdvertThreshold(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Contacts exceeding this many adverts are flagged as HIGH alerts.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="medium-threshold">MEDIUM Alert Threshold</Label>
                    <Input
                      id="medium-threshold"
                      type="number"
                      min="1"
                      value={mediumAdvertThreshold}
                      onChange={(e) => setMediumAdvertThreshold(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Contacts exceeding this many adverts are flagged as MEDIUM alerts.
                    </p>
                  </div>
                </div>
                {thresholdError && (
                  <div className="text-sm text-destructive mb-2" role="alert">
                    {thresholdError}
                  </div>
                )}
                <Button
                  onClick={handleSaveThresholds}
                  disabled={thresholdBusy || !appSettings}
                  className="w-full"
                >
                  {thresholdBusy ? 'Saving...' : 'Save Thresholds'}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : statsError ? (
        <div className="py-8 text-center text-muted-foreground">Failed to load statistics.</div>
      ) : null}
    </div>
  );
}
