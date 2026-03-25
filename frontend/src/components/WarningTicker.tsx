/**
 * WarningTicker.tsx
 *
 * A non-intrusive scrolling ticker in the top bar that surfaces active
 * advert-health warnings (HIGH/MEDIUM nodes) from the last hour.
 *
 * - Polls /api/packets/advert-warnings every 60 s
 * - Renders nothing when there are no warnings or when disabled via settings
 * - Smooth CSS marquee scroll; pauses on hover
 * - Theme-aware: uses CSS variables from the active theme
 */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { AdvertWarning } from '../api';

interface Props {
  enabled: boolean;
}

export function WarningTicker({ enabled }: Props) {
  const [warnings, setWarnings] = useState<AdvertWarning[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const doFetch = () => {
      fetch('/api/packets/advert-warnings')
        .then((r) => r.json() as Promise<{ warnings: AdvertWarning[] }>)
        .then((d) => {
          setWarnings(d.warnings ?? []);
          // Reset dismiss when new warnings arrive after it was dismissed
          if ((d.warnings ?? []).length > 0 && fetchedRef.current) {
            setDismissed(false);
          }
          fetchedRef.current = true;
        })
        .catch(() => {/* silently ignore - ticker is non-critical */});
    };

    doFetch();
    const id = setInterval(doFetch, 60_000);
    return () => clearInterval(id);
  }, [enabled]);

  if (!enabled || dismissed || warnings.length === 0) return null;

  const highCount = warnings.filter((w) => w.level === 'HIGH').length;
  const medCount  = warnings.filter((w) => w.level === 'MEDIUM').length;

  // Build ticker items
  const items = warnings.map((w) => {
    const isHigh = w.level === 'HIGH';
    const name = w.name ?? w.public_key.slice(0, 8).toUpperCase();
    return (
      <span
        key={w.public_key}
        className={`inline-flex items-center gap-1 mx-4 ${
          isHigh ? 'text-destructive' : 'text-yellow-600 dark:text-yellow-400'
        }`}
      >
        <AlertTriangle className="h-3 w-3 flex-shrink-0" />
        <span className="font-medium">{name}</span>
        <span className="opacity-70">({w.advert_count} adverts/hr)</span>
        <span className={`ml-1 rounded px-1 py-0.5 text-[9px] font-bold ${
          isHigh
            ? 'bg-destructive/20 text-destructive'
            : 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300'
        }`}>
          {w.level}
        </span>
      </span>
    );
  });

  // Duplicate items so the scroll loops seamlessly
  const tickerContent = [...items, ...items];

  return (
    <div className="flex items-center border-b border-border bg-muted/60 px-2 text-xs overflow-hidden h-6 flex-shrink-0">
      {/* Static label */}
      <div className="flex items-center gap-1 flex-shrink-0 pr-2 border-r border-border mr-1 text-muted-foreground">
        <AlertTriangle className="h-3 w-3" />
        <span className="font-semibold text-[10px] uppercase tracking-wide">
          Mesh Alerts
          {highCount > 0 && (
            <span className="ml-1 text-destructive">{highCount} HIGH</span>
          )}
          {medCount > 0 && (
            <span className="ml-1 text-yellow-600 dark:text-yellow-400">{medCount} MED</span>
          )}
        </span>
      </div>

      {/* Scrolling area */}
      <div className="flex-1 overflow-hidden relative">
        <div className="flex whitespace-nowrap animate-ticker hover:[animation-play-state:paused]">
          {tickerContent}
        </div>
      </div>

      {/* Dismiss button */}
      <button
        onClick={() => setDismissed(true)}
        className="flex-shrink-0 ml-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        title="Dismiss until next refresh"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
