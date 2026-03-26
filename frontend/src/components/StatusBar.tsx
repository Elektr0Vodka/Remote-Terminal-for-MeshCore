import { useEffect, useRef, useState } from 'react';
import { Menu, Moon, Palette, Sun } from 'lucide-react';
import type { HealthStatus, RadioConfig } from '../types';
import { api } from '../api';
import { toast } from './ui/sonner';
import { handleKeyboardActivate } from '../utils/a11y';
import { applyTheme, getSavedTheme, THEME_CHANGE_EVENT, THEMES } from '../utils/theme';
import { cn } from '@/lib/utils';

interface StatusBarProps {
  health: HealthStatus | null;
  config: RadioConfig | null;
  settingsMode?: boolean;
  onSettingsClick: () => void;
  onMenuClick?: () => void;
}

// Themes whose day/night toggle is meaningful (they have a clear light ↔ dark pairing)
const LIGHT_THEMES  = new Set(['light', 'ios', 'paper-grove', 'monochrome']);
const TOGGLE_THEMES = new Set(['original', 'light', 'ios', 'paper-grove', 'monochrome']);
const PREV_DARK_KEY = 'remoteterm-prev-dark-theme';

// ─── Compact theme swatch ─────────────────────────────────────────────────────

function MiniSwatch({ colors }: { colors: readonly string[] }) {
  return (
    <div className="grid grid-cols-3 gap-[2px] shrink-0" aria-hidden="true">
      {colors.slice(0, 6).map((c, i) => (
        <div key={i} className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: c }} />
      ))}
    </div>
  );
}

// ─── Theme picker popup ───────────────────────────────────────────────────────

interface ThemePickerProps {
  currentTheme: string;
  onClose: () => void;
}

function ThemePickerMenu({ currentTheme, onClose }: ThemePickerProps) {
  const isLight    = LIGHT_THEMES.has(currentTheme);
  const showToggle = TOGGLE_THEMES.has(currentTheme);

  const handleToggle = () => {
    if (isLight) {
      let prev = 'original';
      try { prev = localStorage.getItem(PREV_DARK_KEY) ?? 'original'; } catch { /* ignore */ }
      applyTheme(prev);
    } else {
      try { localStorage.setItem(PREV_DARK_KEY, currentTheme); } catch { /* ignore */ }
      applyTheme('light');
    }
    onClose();
  };

  return (
    <div className="absolute right-0 top-full mt-1 z-50 w-64 rounded-lg border border-border bg-card shadow-xl py-2">

      {/* Light / dark toggle — only when this theme has a meaningful counterpart */}
      {showToggle && (
        <>
          <button
            onClick={handleToggle}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
          >
            {isLight
              ? <Moon className="h-3.5 w-3.5 text-muted-foreground" />
              : <Sun  className="h-3.5 w-3.5 text-muted-foreground" />}
            <span>{isLight ? 'Switch to dark mode' : 'Switch to light mode'}</span>
          </button>
          <div className="my-1.5 border-t border-border" />
        </>
      )}

      {/* Theme grid */}
      <div className="px-2 grid grid-cols-2 gap-1">
        {THEMES.map((theme) => {
          const active = theme.id === currentTheme;
          return (
            <button
              key={theme.id}
              onClick={() => { applyTheme(theme.id); onClose(); }}
              className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-left transition-colors',
                active
                  ? 'bg-primary/10 border border-primary/40 text-foreground font-medium'
                  : 'border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
              aria-pressed={active}
            >
              <MiniSwatch colors={theme.swatches} />
              <span className="truncate">{theme.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── StatusBar ────────────────────────────────────────────────────────────────

export function StatusBar({
  health,
  config,
  settingsMode = false,
  onSettingsClick,
  onMenuClick,
}: StatusBarProps) {
  const radioState =
    health?.radio_state ??
    (health?.radio_initializing
      ? 'initializing'
      : health?.radio_connected
        ? 'connected'
        : 'disconnected');
  const connected = health?.radio_connected ?? false;
  const statusLabel =
    radioState === 'paused'
      ? 'Radio Paused'
      : radioState === 'connecting'
        ? 'Radio Connecting'
        : radioState === 'initializing'
          ? 'Radio Initializing'
          : connected
            ? 'Radio OK'
            : 'Radio Disconnected';

  const [reconnecting, setReconnecting]   = useState(false);
  const [currentTheme, setCurrentTheme]   = useState(getSavedTheme);
  const [pickerOpen, setPickerOpen]       = useState(false);
  const pickerRef                         = useRef<HTMLDivElement>(null);

  // Sync theme state when changed from anywhere (e.g. the Settings → Appearance page)
  useEffect(() => {
    const handler = (event: Event) => {
      const themeId = (event as CustomEvent<string>).detail;
      setCurrentTheme(typeof themeId === 'string' && themeId ? themeId : getSavedTheme());
    };
    window.addEventListener(THEME_CHANGE_EVENT, handler as EventListener);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, handler as EventListener);
  }, []);

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  const handleReconnect = async () => {
    setReconnecting(true);
    try {
      const result = await api.reconnectRadio();
      if (result.connected) {
        toast.success('Reconnected', { description: result.message });
      }
    } catch (err) {
      toast.error('Reconnection failed', {
        description: err instanceof Error ? err.message : 'Check radio connection and power',
      });
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <header className="flex items-center gap-3 px-4 py-2.5 bg-card border-b border-border text-xs">
      {/* Mobile menu button */}
      {onMenuClick && (
        <button
          onClick={onMenuClick}
          className="md:hidden p-0.5 bg-transparent border-none text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
          aria-label="Open menu"
        >
          <Menu className="h-4 w-4" />
        </button>
      )}

      <h1 className="text-base font-semibold tracking-tight mr-auto text-foreground flex items-center gap-1.5">
        <svg
          className="h-4 w-4 shrink-0 text-white"
          viewBox="0 0 512 512"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="m455.68 85.902c-31.289 0-56.32 25.031-56.32 56.32 0 11.379 3.4141 21.617 8.5352 30.152l-106.38 135.39c12.516 6.2578 23.895 15.359 32.996 25.602l107.52-136.54c4.5508 1.1367 9.1016 1.707 13.652 1.707 31.289 0 56.32-25.031 56.32-56.32 0-30.719-25.031-56.32-56.32-56.32z" />
          <path d="m256 343.04c-5.6875 0-10.809 0.57031-15.93 2.2773l-106.38-135.96c-9.1016 10.809-20.48 19.344-32.996 25.602l106.38 135.96c-5.1211 8.5352-7.3945 18.203-7.3945 28.445 0 31.289 25.031 56.32 56.32 56.32s56.32-25.031 56.32-56.32c0-31.293-25.031-56.324-56.32-56.324z" />
          <path d="m356.69 114.91c3.9805-13.652 10.238-26.738 19.344-37.547-38.113-13.652-78.508-21.047-120.04-21.047-59.164 0-115.48 14.789-166.12 42.668-9.1016-6.8281-21.051-10.809-33.562-10.809-31.289-0.57031-56.32 25.027-56.32 55.75 0 31.289 25.031 56.32 56.32 56.32 31.289 0 56.32-25.031 56.32-56.32 0-3.4141-0.57031-6.8281-1.1367-9.6719 44.371-23.895 93.297-36.41 144.5-36.41 34.703 0 68.836 5.6914 100.69 17.066z" />
        </svg>
        RemoteTerm
      </h1>

      <div className="flex items-center gap-1.5" role="status" aria-label={statusLabel}>
        <div
          className={cn(
            'w-2 h-2 rounded-full transition-colors',
            radioState === 'initializing' || radioState === 'connecting'
              ? 'bg-warning'
              : connected
                ? 'bg-status-connected shadow-[0_0_6px_hsl(var(--status-connected)/0.5)]'
                : 'bg-status-disconnected'
          )}
          aria-hidden="true"
        />
        <span className="hidden lg:inline text-muted-foreground">{statusLabel}</span>
      </div>

      {config && (
        <div className="hidden lg:flex items-center gap-2 text-muted-foreground">
          <span className="text-foreground font-medium">{config.name || 'Unnamed'}</span>
          <span
            className="font-mono text-[11px] text-muted-foreground cursor-pointer hover:text-primary transition-colors"
            role="button"
            tabIndex={0}
            onKeyDown={handleKeyboardActivate}
            onClick={() => {
              navigator.clipboard.writeText(config.public_key);
              toast.success('Public key copied!');
            }}
            title="Click to copy public key"
            aria-label="Copy public key"
          >
            {config.public_key.toLowerCase()}
          </span>
        </div>
      )}

      {(radioState === 'disconnected' || radioState === 'paused') && (
        <button
          onClick={handleReconnect}
          disabled={reconnecting}
          className="px-3 py-1 bg-warning/10 border border-warning/20 text-warning rounded-md text-xs cursor-pointer hover:bg-warning/15 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {reconnecting ? 'Reconnecting...' : radioState === 'paused' ? 'Connect' : 'Reconnect'}
        </button>
      )}

      <button
        onClick={onSettingsClick}
        className={cn(
          'px-3 py-1.5 rounded-md text-xs cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          settingsMode
            ? 'bg-status-connected/15 border border-status-connected/30 text-status-connected hover:bg-status-connected/25'
            : 'bg-secondary border border-border text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
      >
        {settingsMode ? 'Back to Chat' : 'Settings'}
      </button>

      {/* Theme picker */}
      <div className="relative" ref={pickerRef}>
        <button
          onClick={() => setPickerOpen((v) => !v)}
          className={cn(
            'p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            pickerOpen && 'bg-accent text-foreground'
          )}
          title="Change theme"
          aria-label="Change theme"
          aria-expanded={pickerOpen}
        >
          <Palette className="h-4 w-4" aria-hidden="true" />
        </button>

        {pickerOpen && (
          <ThemePickerMenu
            currentTheme={currentTheme}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    </header>
  );
}
