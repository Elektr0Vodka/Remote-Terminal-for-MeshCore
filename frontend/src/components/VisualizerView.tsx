import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { Contact, RawPacket, RadioConfig } from '../types';
import { PacketVisualizer3D } from './PacketVisualizer3D';
import { RawPacketList } from './RawPacketList';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { cn } from '@/lib/utils';
import { getVisualizerSettings, saveVisualizerSettings } from '../utils/visualizerSettings';
import { api } from '../api';

interface VisualizerViewProps {
  packets: RawPacket[];
  contacts: Contact[];
  config: RadioConfig | null;
}

// ── time window presets ────────────────────────────────────────────────────────
const TIME_PRESETS = [
  { label: 'Session', seconds: null },
  { label: '30m', seconds: 30 * 60 },
  { label: '1h', seconds: 60 * 60 },
  { label: '2h', seconds: 2 * 60 * 60 },
  { label: '6h', seconds: 6 * 60 * 60 },
  { label: '12h', seconds: 12 * 60 * 60 },
  { label: '24h', seconds: 24 * 60 * 60 },
] as const;

type WindowKey = 'session' | '30m' | '1h' | '2h' | '6h' | '12h' | '24h' | 'custom';

function toLocalDateTimeValue(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDateTimeValue(val: string): number {
  return Math.floor(new Date(val).getTime() / 1000);
}

export function VisualizerView({ packets, contacts, config }: VisualizerViewProps) {
  const [fullScreen, setFullScreen] = useState(() => getVisualizerSettings().hidePacketFeed);
  const [paneFullScreen, setPaneFullScreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Time window state
  const [windowKey, setWindowKey] = useState<WindowKey>('session');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [showCustom, setShowCustom] = useState(false);

  // Historical packet state (used when not in session mode)
  const [historicalPackets, setHistoricalPackets] = useState<RawPacket[] | null>(null);
  const [histLoading, setHistLoading] = useState(false);

  // Key used to remount visualizer on window change (clears incremental state)
  const [vizKey, setVizKey] = useState(0);

  // Persist packet feed visibility to localStorage
  useEffect(() => {
    const current = getVisualizerSettings();
    if (current.hidePacketFeed !== fullScreen) {
      saveVisualizerSettings({ ...current, hidePacketFeed: fullScreen });
    }
  }, [fullScreen]);

  // Sync state when browser exits fullscreen (Escape, F11, etc.)
  useEffect(() => {
    const handler = () => {
      if (!document.fullscreenElement) setPaneFullScreen(false);
    };
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const toggleFullScreen = useCallback(() => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
      setPaneFullScreen(true);
    } else {
      document.exitFullscreen();
    }
  }, []);

  // Fetch historical packets when a non-session window is active
  useEffect(() => {
    if (windowKey === 'session') {
      setHistoricalPackets(null);
      return;
    }

    let cancelled = false;
    setHistLoading(true);

    const nowTs = Math.floor(Date.now() / 1000);
    let afterTs: number | undefined;
    let beforeTs: number | undefined;

    if (windowKey === 'custom') {
      afterTs = customFrom ? fromLocalDateTimeValue(customFrom) : undefined;
      beforeTs = customTo ? fromLocalDateTimeValue(customTo) : undefined;
    } else {
      const preset = TIME_PRESETS.find((p) => p.label.toLowerCase() === windowKey);
      if (preset?.seconds) {
        afterTs = nowTs - preset.seconds;
      }
    }

    api
      .getRecentPackets({ afterTs, beforeTs, limit: 5000 })
      .then((data) => {
        if (!cancelled) {
          setHistoricalPackets(data);
          setHistLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHistoricalPackets([]);
          setHistLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [windowKey, customFrom, customTo]);

  const selectWindow = useCallback((key: WindowKey) => {
    setWindowKey(key);
    if (key !== 'custom') setShowCustom(false);
    setVizKey((k) => k + 1);
  }, []);

  const applyCustom = useCallback(() => {
    setWindowKey('custom');
    setVizKey((k) => k + 1);
  }, []);

  // The packets to display: live stream in session mode, fetched otherwise
  const displayPackets = windowKey === 'session' ? packets : (historicalPackets ?? []);

  const toolbar = (
    <div className="flex flex-wrap items-center gap-1 px-3 py-1.5 border-b border-border bg-muted/30">
      {TIME_PRESETS.map((preset) => {
        const key = preset.label.toLowerCase() as WindowKey;
        const active = windowKey === key;
        return (
          <button
            key={preset.label}
            onClick={() => selectWindow(key)}
            className={cn(
              'px-2.5 py-0.5 rounded text-xs font-medium transition-colors',
              active
                ? 'bg-primary text-primary-foreground'
                : 'bg-background border border-border text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
          >
            {preset.label}
          </button>
        );
      })}
      <button
        onClick={() => {
          setShowCustom((v) => !v);
          if (!showCustom) {
            // Pre-fill to last 1 hour if empty
            const nowTs = Math.floor(Date.now() / 1000);
            if (!customFrom) setCustomFrom(toLocalDateTimeValue(nowTs - 3600));
            if (!customTo) setCustomTo(toLocalDateTimeValue(nowTs));
          }
        }}
        className={cn(
          'px-2.5 py-0.5 rounded text-xs font-medium transition-colors',
          windowKey === 'custom'
            ? 'bg-primary text-primary-foreground'
            : 'bg-background border border-border text-muted-foreground hover:text-foreground hover:bg-accent'
        )}
      >
        Custom
      </button>
      {histLoading && windowKey !== 'session' && (
        <span className="text-xs text-muted-foreground ml-1 animate-pulse">Loading…</span>
      )}
      {!histLoading && windowKey !== 'session' && historicalPackets !== null && (
        <span className="text-xs text-muted-foreground ml-1">
          {historicalPackets.length.toLocaleString()} packets
        </span>
      )}
      {showCustom && (
        <div className="flex items-center gap-1 flex-wrap ml-1">
          <input
            type="datetime-local"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="text-xs bg-background border border-border rounded px-1.5 py-0.5 text-foreground"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <input
            type="datetime-local"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="text-xs bg-background border border-border rounded px-1.5 py-0.5 text-foreground"
          />
          <button
            onClick={applyCustom}
            className="px-2 py-0.5 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div ref={containerRef} className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex justify-between items-center px-4 py-3 border-b border-border font-medium text-lg">
        <span>{paneFullScreen ? 'RemoteTerm MeshCore Visualizer' : 'Mesh Visualizer'}</span>
        <button
          className="hidden md:inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={toggleFullScreen}
          title={paneFullScreen ? 'Exit fullscreen' : 'Fullscreen'}
          aria-label={paneFullScreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {paneFullScreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
        </button>
      </div>

      {/* Time window toolbar */}
      {toolbar}

      {/* Mobile: Tabbed interface */}
      <div className="flex-1 overflow-hidden md:hidden">
        <Tabs defaultValue="visualizer" className="h-full flex flex-col">
          <TabsList className="mx-4 mt-2 grid grid-cols-2">
            <TabsTrigger value="visualizer">Visualizer</TabsTrigger>
            <TabsTrigger value="packets">Packet Feed</TabsTrigger>
          </TabsList>
          <TabsContent value="visualizer" className="flex-1 m-0 overflow-hidden">
            <PacketVisualizer3D
              key={vizKey}
              packets={displayPackets}
              contacts={contacts}
              config={config}
            />
          </TabsContent>
          <TabsContent value="packets" className="flex-1 m-0 overflow-hidden">
            <RawPacketList key={vizKey} packets={displayPackets} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Desktop: Split screen (or full screen if toggled) */}
      <div className="hidden md:flex flex-1 overflow-hidden">
        {/* Visualizer panel */}
        <div
          className={cn(
            'overflow-hidden transition-all duration-200',
            fullScreen ? 'flex-1' : 'flex-1 border-r border-border'
          )}
        >
          <PacketVisualizer3D
            key={vizKey}
            packets={displayPackets}
            contacts={contacts}
            config={config}
            fullScreen={fullScreen}
            onFullScreenChange={setFullScreen}
          />
        </div>

        {/* Packet feed panel - hidden when full screen */}
        <div
          className={cn(
            'overflow-hidden transition-all duration-200',
            fullScreen ? 'w-0' : 'w-[31rem] lg:w-[38rem]'
          )}
        >
          <div className="h-full flex flex-col">
            <div className="px-3 py-2 border-b border-border text-sm font-medium text-muted-foreground">
              Packet Feed
            </div>
            <div className="flex-1 overflow-hidden">
              <RawPacketList key={vizKey} packets={displayPackets} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
