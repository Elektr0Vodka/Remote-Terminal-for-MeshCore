/**
 * WarningTicker.tsx
 *
 * A non-intrusive scrolling ticker in the top bar that surfaces active
 * advert-health warnings (HIGH/MEDIUM nodes) from the last hour.
 *
 * - Polls /api/packets/advert-warnings every 60 s
 * - Renders nothing when there are no warnings or when disabled via settings
 * - Smooth CSS marquee scroll that starts from the right; pauses on hover
 * - X button shows a small dropdown: dismiss temporarily or suppress a node
 *   permanently (stored in localStorage so it survives page reloads)
 * - Clicking a node name navigates to Mesh Health with that node highlighted
 * - Theme-aware: uses CSS variables from the active theme
 */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, X } from 'lucide-react';
import type { AdvertWarning } from '../api';

const SUPPRESSED_KEY = 'remoteterm-ticker-suppressed';

function loadSuppressed(): Set<string> {
  try {
    const r = localStorage.getItem(SUPPRESSED_KEY);
    return r ? new Set(JSON.parse(r) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveSuppressed(s: Set<string>): void {
  try {
    localStorage.setItem(SUPPRESSED_KEY, JSON.stringify([...s]));
  } catch { /* ignore */ }
}

interface Props {
  enabled: boolean;
  onNavigateToHealth?: (publicKey: string) => void;
}

export function WarningTicker({ enabled, onNavigateToHealth }: Props) {
  const [warnings, setWarnings]         = useState<AdvertWarning[]>([]);
  const [dismissed, setDismissed]       = useState(false);
  const [suppressed, setSuppressed]     = useState<Set<string>>(loadSuppressed);
  const [showMenu, setShowMenu]         = useState(false);
  const menuRef                         = useRef<HTMLDivElement>(null);
  const fetchedRef                      = useRef(false);

  // Close dismiss menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMenu]);

  useEffect(() => {
    if (!enabled) return;

    const doFetch = () => {
      fetch('/api/packets/advert-warnings')
        .then((r) => r.json() as Promise<{ warnings: AdvertWarning[] }>)
        .then((d) => {
          setWarnings(d.warnings ?? []);
          // Only reset temporary dismiss when NEW warnings arrive after first fetch
          if ((d.warnings ?? []).length > 0 && fetchedRef.current) {
            setDismissed(false);
          }
          fetchedRef.current = true;
        })
        .catch(() => { /* silently ignore — ticker is non-critical */ });
    };

    doFetch();
    const id = setInterval(doFetch, 60_000);
    return () => clearInterval(id);
  }, [enabled]);

  const suppressNode = (key: string) => {
    const next = new Set([...suppressed, key]);
    setSuppressed(next);
    saveSuppressed(next);
    setShowMenu(false);
  };

  if (!enabled) return null;

  const visibleWarnings = warnings.filter((w) => !suppressed.has(w.public_key));
  if (dismissed || visibleWarnings.length === 0) return null;

  const highCount = visibleWarnings.filter((w) => w.level === 'HIGH').length;
  const medCount  = visibleWarnings.filter((w) => w.level === 'MEDIUM').length;

  const items = visibleWarnings.map((w) => {
    const isHigh = w.level === 'HIGH';
    const name   = w.name ?? w.public_key.slice(0, 8).toUpperCase();
    return (
      <span
        key={w.public_key}
        className={`inline-flex items-center gap-1 mx-4 ${
          isHigh ? 'text-destructive' : 'text-yellow-600 dark:text-yellow-400'
        }`}
      >
        <AlertTriangle className="h-3 w-3 flex-shrink-0" />
        {onNavigateToHealth ? (
          <button
            onClick={() => onNavigateToHealth(w.public_key)}
            className="font-medium underline-offset-2 hover:underline cursor-pointer"
          >
            {name}
          </button>
        ) : (
          <span className="font-medium">{name}</span>
        )}
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

  return (
    <div className="flex items-center border-b border-border bg-muted/60 px-2 text-xs h-6 flex-shrink-0">
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

      {/* Scrolling area — padding-left: 100% pushes content to start at the right
          edge of the container so items enter from the right on each cycle.     */}
      <div className="flex-1 overflow-hidden relative">
        <div
          className="inline-flex whitespace-nowrap animate-ticker hover:[animation-play-state:paused]"
          style={{ paddingLeft: '100%' }}
        >
          {items}
        </div>
      </div>

      {/* Dismiss / suppress button */}
      <div className="relative flex-shrink-0 ml-1" ref={menuRef}>
        <button
          onClick={() => setShowMenu((v) => !v)}
          className="flex items-center gap-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          title="Dismiss or suppress"
        >
          <X className="h-3 w-3" />
          <ChevronDown className="h-2.5 w-2.5" />
        </button>

        {showMenu && (
          <div className="absolute right-0 top-full mt-1 z-50 min-w-[180px] rounded border border-border bg-card shadow-lg text-xs py-1">
            {/* Temporary dismiss */}
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-accent text-foreground"
              onClick={() => { setDismissed(true); setShowMenu(false); }}
            >
              Dismiss until next warning
            </button>

            {visibleWarnings.length > 0 && (
              <div className="border-t border-border my-1" />
            )}

            {/* Per-node suppress options */}
            {visibleWarnings.map((w) => {
              const name = w.name ?? w.public_key.slice(0, 8).toUpperCase();
              return (
                <button
                  key={w.public_key}
                  className="w-full text-left px-3 py-1.5 hover:bg-accent text-muted-foreground hover:text-foreground"
                  onClick={() => suppressNode(w.public_key)}
                >
                  Suppress <span className="font-medium text-foreground">{name}</span> permanently
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
