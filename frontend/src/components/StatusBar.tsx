import { useState } from 'react';
import { Menu } from 'lucide-react';
import type { HealthStatus, RadioConfig } from '../types';
import { api } from '../api';
import { toast } from './ui/sonner';
import { cn } from '@/lib/utils';

interface StatusBarProps {
  health: HealthStatus | null;
  config: RadioConfig | null;
  settingsMode?: boolean;
  onSettingsClick: () => void;
  onMenuClick?: () => void;
}

export function StatusBar({
  health,
  config,
  settingsMode = false,
  onSettingsClick,
  onMenuClick,
}: StatusBarProps) {
  const connected = health?.radio_connected ?? false;
  const [reconnecting, setReconnecting] = useState(false);

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
    <div className="flex items-center gap-3 px-4 py-2.5 bg-card border-b border-border text-xs">
      {/* Mobile menu button - only visible on small screens */}
      {onMenuClick && (
        <button
          onClick={onMenuClick}
          className="md:hidden p-1 bg-transparent border-none text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
      )}

      <h1 className="text-sm font-semibold tracking-tight mr-auto text-foreground flex items-center gap-1.5">
        <svg
          className="h-5 w-5 shrink-0"
          viewBox="0 0 700 700"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="m405.89 352.77c0 30.797-25.02 55.762-55.887 55.762s-55.887-24.965-55.887-55.762c0-30.797 25.02-55.762 55.887-55.762s55.887 24.965 55.887 55.762z" />
          <path d="m333.07 352.77h33.871v297.37h-33.871z" />
          <path d="m412.71 495.07-13.648-30.926c44.27-19.438 72.879-63.152 72.879-111.37 0-67.082-54.699-121.65-121.94-121.65-67.242 0-121.94 54.57-121.94 121.65 0 48.215 28.609 91.93 72.879 111.37l-13.648 30.926c-56.547-24.844-93.094-80.695-93.094-142.3 0-85.715 69.887-155.44 155.8-155.44 85.918 0 155.8 69.727 155.8 155.44-0.003906 61.594-36.551 117.46-93.094 142.3z" />
          <path d="m410.17 581.6-8.5742-32.691c89.277-23.309 151.63-103.96 151.63-196.15 0-111.8-91.168-202.75-203.22-202.75-112.06 0.003907-203.23 90.961-203.23 202.77 0 92.184 62.348 172.83 151.63 196.15l-8.5742 32.691c-104.18-27.195-176.93-121.3-176.93-228.83 0-130.43 106.36-236.54 237.1-236.54 130.73 0 237.1 106.12 237.1 236.54-0.003906 107.52-72.754 201.62-176.93 228.82z" />
          <path d="m409.05 661.5-6.3125-33.199c132.34-25.047 228.39-140.93 228.39-275.53 0-154.66-126.12-280.48-281.13-280.48-155 0-281.13 125.82-281.13 280.48 0 134.6 96.055 250.48 228.39 275.53l-6.3164 33.199c-148.3-28.07-255.95-157.91-255.95-308.73 0-173.29 141.32-314.27 315-314.27s315 140.98 315 314.27c0 150.81-107.65 280.66-255.95 308.73z" />
        </svg>
        RemoteTerm
      </h1>

      <div className="flex items-center gap-1.5">
        <div
          className={cn(
            'w-2 h-2 rounded-full transition-colors',
            connected
              ? 'bg-primary shadow-[0_0_6px_hsl(var(--primary)/0.5)]'
              : 'bg-muted-foreground'
          )}
        />
        <span className="hidden lg:inline text-muted-foreground">
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      {config && (
        <div className="hidden lg:flex items-center gap-2 text-muted-foreground">
          <span className="text-foreground font-medium">{config.name || 'Unnamed'}</span>
          <span
            className="font-mono text-[11px] text-muted-foreground cursor-pointer hover:text-primary transition-colors"
            onClick={() => {
              navigator.clipboard.writeText(config.public_key);
              toast.success('Public key copied!');
            }}
            title="Click to copy public key"
          >
            {config.public_key.toLowerCase()}
          </span>
        </div>
      )}

      {!connected && (
        <button
          onClick={handleReconnect}
          disabled={reconnecting}
          className="px-3 py-1 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded-md text-xs cursor-pointer hover:bg-amber-500/15 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {reconnecting ? 'Reconnecting...' : 'Reconnect'}
        </button>
      )}
      <button
        onClick={onSettingsClick}
        className="px-3 py-1.5 bg-secondary border border-border text-muted-foreground rounded-md text-xs cursor-pointer hover:bg-accent hover:text-foreground transition-colors"
      >
        {settingsMode ? 'Back to Chat' : 'Settings'}
      </button>
    </div>
  );
}
