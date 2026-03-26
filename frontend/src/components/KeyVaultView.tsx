/**
 * KeyVaultView.tsx — MC-KMS stored key management
 *
 * Table/card view of all stored Ed25519 keypairs with full lifecycle metadata.
 * Supports inline editing of metadata fields, JSON export, and deletion.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Edit2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { cn } from '@/lib/utils';
import type { KmsKey, KmsKeyUpdate } from '../types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function downloadKeyJson(key: KmsKey) {
  const blob = new Blob(
    [JSON.stringify({ public_key: key.public_key, private_key: key.private_key }, null, 2)],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meshcore_${key.device_name?.replace(/\s+/g, '_') ?? key.public_key.slice(0, 8)}_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────

const METADATA_FIELDS: { key: keyof KmsKeyUpdate; label: string; type?: string; placeholder?: string }[] = [
  { key: 'device_name', label: 'Device Name', placeholder: 'e.g. Rooftop Repeater' },
  { key: 'device_role', label: 'Device Role', placeholder: 'Repeater, Room Server, Client…' },
  { key: 'model', label: 'Model', placeholder: 'e.g. HELTEC-V3' },
  { key: 'assigned_to', label: 'Assigned To', placeholder: 'Team or person responsible' },
  { key: 'placement_date', label: 'Placement Date', type: 'date' },
  { key: 'last_maintenance', label: 'Last Maintenance', type: 'date' },
  { key: 'last_registered_failure', label: 'Last Registered Failure', type: 'date' },
  { key: 'notes', label: 'Notes', placeholder: 'Free-form notes…' },
];

function EditModal({
  kmsKey,
  onSave,
  onClose,
}: {
  kmsKey: KmsKey;
  onSave: (update: KmsKeyUpdate) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<KmsKeyUpdate>({
    device_name: kmsKey.device_name,
    device_role: kmsKey.device_role,
    model: kmsKey.model,
    assigned_to: kmsKey.assigned_to,
    placement_date: kmsKey.placement_date,
    last_maintenance: kmsKey.last_maintenance,
    last_registered_failure: kmsKey.last_registered_failure,
    notes: kmsKey.notes,
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(form);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Edit2 className="h-4 w-4" />
            Edit Key Metadata
          </h3>
          <span className="text-xs text-muted-foreground font-mono">{kmsKey.public_key.slice(0, 16)}…</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent/50 transition ml-2">
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-3 flex-1">
          {METADATA_FIELDS.map(({ key, label, type, placeholder }) => (
            <div key={key} className="space-y-1">
              <label className="text-xs text-muted-foreground">{label}</label>
              {key === 'notes' ? (
                <textarea
                  value={(form[key] as string) ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value || null }))}
                  placeholder={placeholder}
                  rows={3}
                  className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                />
              ) : (
                <input
                  type={type ?? 'text'}
                  value={(form[key] as string) ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value || null }))}
                  placeholder={placeholder}
                  className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent/50 transition">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Key Row ──────────────────────────────────────────────────────────────────

function KeyRow({
  kmsKey,
  onEdit,
  onDelete,
}: {
  kmsKey: KmsKey;
  onEdit: (k: KmsKey) => void;
  onDelete: (k: KmsKey) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showPriv, setShowPriv] = useState(false);

  const copy = (text: string, label: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error('Clipboard not available'),
    );

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Summary row */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-accent/30 transition select-none"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded
          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />}
        <KeyRound className="h-4 w-4 text-primary flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">
              {kmsKey.device_name ?? <span className="text-muted-foreground italic">Unnamed</span>}
            </span>
            {kmsKey.device_role && (
              <span className="text-[10px] rounded px-1.5 py-0.5 bg-primary/10 text-primary font-medium">
                {kmsKey.device_role}
              </span>
            )}
            {kmsKey.model && (
              <span className="text-[10px] text-muted-foreground">{kmsKey.model}</span>
            )}
          </div>
          <span className="text-[11px] text-muted-foreground font-mono">
            {kmsKey.public_key.slice(0, 16)}…
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => downloadKeyJson(kmsKey)}
            title="Download JSON"
            className="p-1.5 rounded hover:bg-accent/50 transition text-muted-foreground hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onEdit(kmsKey)}
            title="Edit metadata"
            className="p-1.5 rounded hover:bg-accent/50 transition text-muted-foreground hover:text-foreground"
          >
            <Edit2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onDelete(kmsKey)}
            title="Delete key"
            className="p-1.5 rounded hover:bg-destructive/20 transition text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-border bg-muted/20">
          {/* Crypto */}
          <div className="space-y-2">
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Public Key</label>
              <div className="flex items-center gap-2">
                <span className="flex-1 font-mono text-xs bg-muted/40 rounded px-2 py-1.5 break-all select-all">
                  {kmsKey.public_key}
                </span>
                <button onClick={() => copy(kmsKey.public_key, 'Public key')} className="p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition">
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Private Key</label>
                <button
                  onClick={() => setShowPriv((p) => !p)}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition"
                >
                  {showPriv ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  {showPriv ? 'Hide' : 'Reveal'}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="flex-1 font-mono text-xs bg-muted/40 rounded px-2 py-1.5 break-all select-all">
                  {showPriv ? kmsKey.private_key : '•'.repeat(32) + '…'}
                </span>
                <button onClick={() => copy(kmsKey.private_key, 'Private key')} className="p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition">
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Metadata grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-xs">
            {[
              { label: 'Assigned To', value: kmsKey.assigned_to },
              { label: 'Placement', value: formatDate(kmsKey.placement_date) },
              { label: 'Last Maintenance', value: formatDate(kmsKey.last_maintenance) },
              { label: 'Last Failure', value: formatDate(kmsKey.last_registered_failure) },
              { label: 'Created', value: formatTs(kmsKey.created_at) },
              { label: 'Updated', value: formatTs(kmsKey.updated_at) },
            ].map(({ label, value }) => (
              <div key={label}>
                <span className="text-muted-foreground">{label}: </span>
                <span className={cn(value === '—' && 'text-muted-foreground/50')}>{value ?? '—'}</span>
              </div>
            ))}
            {kmsKey.notes && (
              <div className="col-span-full">
                <span className="text-muted-foreground">Notes: </span>
                <span>{kmsKey.notes}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function KeyVaultView({ embedded = false }: { embedded?: boolean }) {
  const [keys, setKeys] = useState<KmsKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editingKey, setEditingKey] = useState<KmsKey | null>(null);
  const [deletingKey, setDeletingKey] = useState<KmsKey | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setKeys(await api.kmsListKeys());
    } catch {
      toast.error('Failed to load vault');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleUpdate = useCallback(async (update: KmsKeyUpdate) => {
    if (!editingKey) return;
    const updated = await api.kmsUpdateKey(editingKey.id, update);
    setKeys((prev) => prev.map((k) => (k.id === updated.id ? updated : k)));
    toast.success('Key updated');
  }, [editingKey]);

  const handleDelete = useCallback(async () => {
    if (!deletingKey) return;
    setDeleting(true);
    try {
      await api.kmsDeleteKey(deletingKey.id);
      setKeys((prev) => prev.filter((k) => k.id !== deletingKey.id));
      toast.success('Key deleted');
      setDeletingKey(null);
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeleting(false);
    }
  }, [deletingKey]);

  const filtered = search
    ? keys.filter((k) => {
        const q = search.toLowerCase();
        return (
          k.public_key.includes(q) ||
          (k.device_name?.toLowerCase().includes(q) ?? false) ||
          (k.device_role?.toLowerCase().includes(q) ?? false) ||
          (k.model?.toLowerCase().includes(q) ?? false) ||
          (k.assigned_to?.toLowerCase().includes(q) ?? false)
        );
      })
    : keys;

  const header = (
    <div className={cn('flex items-center gap-3', embedded ? 'pb-3' : 'px-4 py-2.5 border-b border-border')}>
      {!embedded && <KeyRound className="h-4 w-4 text-primary flex-shrink-0" />}
      {!embedded && <h2 className="font-semibold text-base">Key Vault</h2>}
      <span className="text-xs text-muted-foreground">
        {keys.length} stored {keys.length === 1 ? 'key' : 'keys'}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="pl-7 pr-3 py-1 rounded border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring w-40"
          />
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="p-1.5 rounded hover:bg-accent/50 transition text-muted-foreground hover:text-foreground"
          title="Refresh"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>
    </div>
  );

  const modals = (
    <>
      {editingKey && (
        <EditModal
          kmsKey={editingKey}
          onSave={handleUpdate}
          onClose={() => setEditingKey(null)}
        />
      )}
      {deletingKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-sm mx-4 p-5 space-y-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-sm">Delete key?</p>
                <p className="text-xs text-muted-foreground mt-1">
                  <span className="font-mono">{deletingKey.public_key.slice(0, 16)}…</span>
                  {deletingKey.device_name && ` (${deletingKey.device_name})`}
                </p>
                <p className="text-xs text-destructive/80 mt-2">
                  This permanently deletes the private key from the vault. It cannot be recovered.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeletingKey(null)}
                className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent/50 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition disabled:opacity-60"
              >
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  if (embedded) {
    return (
      <div className="space-y-3">
        {header}
        {loading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading vault…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-muted-foreground gap-2">
            <KeyRound className="h-8 w-8 opacity-30" />
            <p className="text-sm">{search ? 'No keys match your search' : 'No keys in vault yet'}</p>
            {!search && <p className="text-xs">Generate a key on the Generate tab and save it here</p>}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((k) => (
              <KeyRow key={k.id} kmsKey={k} onEdit={setEditingKey} onDelete={setDeletingKey} />
            ))}
          </div>
        )}
        {modals}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {header}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading vault…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-muted-foreground gap-2">
            <KeyRound className="h-8 w-8 opacity-30" />
            <p className="text-sm">{search ? 'No keys match your search' : 'No keys in vault yet'}</p>
            {!search && <p className="text-xs">Generate a key in the MC-KMS tab and save it here</p>}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((k) => (
              <KeyRow key={k.id} kmsKey={k} onEdit={setEditingKey} onDelete={setDeletingKey} />
            ))}
          </div>
        )}
      </div>
      {modals}
    </div>
  );
}
