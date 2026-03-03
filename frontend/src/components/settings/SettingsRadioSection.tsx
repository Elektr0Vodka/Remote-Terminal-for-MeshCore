import { useState, useEffect, useMemo } from 'react';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import { toast } from '../ui/sonner';
import { RADIO_PRESETS } from '../../utils/radioPresets';
import type { RadioConfig, RadioConfigUpdate } from '../../types';

export function SettingsRadioSection({
  config,
  pageMode,
  onSave,
  onReboot,
  onClose,
  className,
}: {
  config: RadioConfig;
  pageMode: boolean;
  onSave: (update: RadioConfigUpdate) => Promise<void>;
  onReboot: () => Promise<void>;
  onClose: () => void;
  className?: string;
}) {
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [txPower, setTxPower] = useState('');
  const [freq, setFreq] = useState('');
  const [bw, setBw] = useState('');
  const [sf, setSf] = useState('');
  const [cr, setCr] = useState('');
  const [gettingLocation, setGettingLocation] = useState(false);

  const [busy, setBusy] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLat(String(config.lat));
    setLon(String(config.lon));
    setTxPower(String(config.tx_power));
    setFreq(String(config.radio.freq));
    setBw(String(config.radio.bw));
    setSf(String(config.radio.sf));
    setCr(String(config.radio.cr));
  }, [config]);

  const currentPreset = useMemo(() => {
    const freqNum = parseFloat(freq);
    const bwNum = parseFloat(bw);
    const sfNum = parseInt(sf, 10);
    const crNum = parseInt(cr, 10);

    for (const preset of RADIO_PRESETS) {
      if (
        preset.freq === freqNum &&
        preset.bw === bwNum &&
        preset.sf === sfNum &&
        preset.cr === crNum
      ) {
        return preset.name;
      }
    }
    return 'custom';
  }, [freq, bw, sf, cr]);

  const handlePresetChange = (presetName: string) => {
    if (presetName === 'custom') return;
    const preset = RADIO_PRESETS.find((p) => p.name === presetName);
    if (preset) {
      setFreq(String(preset.freq));
      setBw(String(preset.bw));
      setSf(String(preset.sf));
      setCr(String(preset.cr));
    }
  };

  const handleGetLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation not supported', {
        description: 'Your browser does not support geolocation',
      });
      return;
    }

    setGettingLocation(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLat(position.coords.latitude.toFixed(6));
        setLon(position.coords.longitude.toFixed(6));
        setGettingLocation(false);
        toast.success('Location updated');
      },
      (err) => {
        setGettingLocation(false);
        toast.error('Failed to get location', {
          description: err.message,
        });
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleSave = async () => {
    setError(null);

    const parsedLat = parseFloat(lat);
    const parsedLon = parseFloat(lon);
    const parsedTxPower = parseInt(txPower, 10);
    const parsedFreq = parseFloat(freq);
    const parsedBw = parseFloat(bw);
    const parsedSf = parseInt(sf, 10);
    const parsedCr = parseInt(cr, 10);

    if (
      [parsedLat, parsedLon, parsedTxPower, parsedFreq, parsedBw, parsedSf, parsedCr].some(
        (v) => isNaN(v)
      )
    ) {
      setError('All numeric fields must have valid values');
      return;
    }

    setBusy(true);

    try {
      const update: RadioConfigUpdate = {
        lat: parsedLat,
        lon: parsedLon,
        tx_power: parsedTxPower,
        radio: {
          freq: parsedFreq,
          bw: parsedBw,
          sf: parsedSf,
          cr: parsedCr,
        },
      };
      await onSave(update);
      toast.success('Radio config saved, rebooting...');
      setRebooting(true);
      await onReboot();
      if (!pageMode) {
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setRebooting(false);
      setBusy(false);
    }
  };

  return (
    <div className={className}>
      <div className="space-y-2">
        <Label htmlFor="preset">Preset</Label>
        <select
          id="preset"
          value={currentPreset}
          onChange={(e) => handlePresetChange(e.target.value)}
          className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        >
          <option value="custom">Custom</option>
          {RADIO_PRESETS.map((preset) => (
            <option key={preset.name} value={preset.name}>
              {preset.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="freq">Frequency (MHz)</Label>
          <Input
            id="freq"
            type="number"
            step="any"
            value={freq}
            onChange={(e) => setFreq(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="bw">Bandwidth (kHz)</Label>
          <Input
            id="bw"
            type="number"
            step="any"
            value={bw}
            onChange={(e) => setBw(e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="sf">Spreading Factor</Label>
          <Input
            id="sf"
            type="number"
            min="7"
            max="12"
            value={sf}
            onChange={(e) => setSf(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cr">Coding Rate</Label>
          <Input
            id="cr"
            type="number"
            min="5"
            max="8"
            value={cr}
            onChange={(e) => setCr(e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="tx-power">TX Power (dBm)</Label>
          <Input
            id="tx-power"
            type="number"
            value={txPower}
            onChange={(e) => setTxPower(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="max-tx">Max TX Power</Label>
          <Input id="max-tx" type="number" value={config.max_tx_power} disabled />
        </div>
      </div>

      <Separator />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Location</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleGetLocation}
            disabled={gettingLocation}
          >
            {gettingLocation ? 'Getting...' : '📍 Use My Location'}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="lat" className="text-xs text-muted-foreground">
              Latitude
            </Label>
            <Input
              id="lat"
              type="number"
              step="any"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lon" className="text-xs text-muted-foreground">
              Longitude
            </Label>
            <Input
              id="lon"
              type="number"
              step="any"
              value={lon}
              onChange={(e) => setLon(e.target.value)}
            />
          </div>
        </div>
      </div>

      {error && <div className="text-sm text-destructive">{error}</div>}

      <Button onClick={handleSave} disabled={busy || rebooting} className="w-full">
        {busy || rebooting ? 'Saving & Rebooting...' : 'Save Radio Config & Reboot'}
      </Button>
    </div>
  );
}
