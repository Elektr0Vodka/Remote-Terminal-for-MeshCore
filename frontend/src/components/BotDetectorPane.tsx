import { useCallback, useEffect, useState } from 'react';
import { Bot, RefreshCw, Tag, X } from 'lucide-react';

import type { BotDetectionNode, ManualTag } from '../types';
import { api } from '../api';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

// ── helpers ────────────────────────────────────────────────────────────────

function formatRelativeTime(ts: number | null): string {
  if (ts === null) return '—';
  const diffSec = Math.floor(Date.now() / 1000) - ts;
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function formatTs(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString();
}

function ScoreBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', color)}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums">
        {Math.round(value)}
      </span>
    </div>
  );
}

function automationColor(score: number): string {
  if (score >= 70) return 'bg-destructive';
  if (score >= 40) return 'bg-yellow-500';
  return 'bg-green-500';
}

function impactColor(score: number): string {
  if (score >= 70) return 'bg-orange-500';
  if (score >= 40) return 'bg-yellow-500';
  return 'bg-blue-400';
}

const CLASSIFICATION_LABELS: Record<string, string> = {
  likely_human: 'Likely human',
  automated_utility: 'Automated utility',
  automated_high_impact: 'Automated high-impact',
  insufficient_data: 'Insufficient data',
  unknown: 'Unknown',
};

const CLASSIFICATION_COLORS: Record<string, string> = {
  likely_human: 'text-green-600 bg-green-50 border-green-200',
  automated_utility: 'text-yellow-700 bg-yellow-50 border-yellow-200',
  automated_high_impact: 'text-destructive bg-destructive/10 border-destructive/30',
  insufficient_data: 'text-muted-foreground bg-muted border-border',
  unknown: 'text-muted-foreground bg-muted border-border',
};

const MANUAL_TAG_LABELS: Record<ManualTag, string> = {
  likely_bot: 'Likely bot',
  utility_bot: 'Utility bot',
  test: 'Test',
  not_a_bot: 'Not a bot',
};

const MANUAL_TAG_COLORS: Record<ManualTag, string> = {
  likely_bot: 'bg-destructive/10 text-destructive border-destructive/30',
  utility_bot: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  test: 'bg-blue-50 text-blue-700 border-blue-200',
  not_a_bot: 'bg-green-50 text-green-700 border-green-200',
};

type SortKey = 'automation' | 'impact' | 'name' | 'messages';

// ── Detail panel ───────────────────────────────────────────────────────────

function NodeDetail({
  node,
  onTagChange,
  onClose,
}: {
  node: BotDetectionNode;
  onTagChange: (tag: ManualTag | null) => void;
  onClose: () => void;
}) {
  const shortKey = node.public_key.slice(0, 16);

  return (
    <div className="flex flex-col h-full border-l border-border bg-card overflow-y-auto">
      <div className="flex items-center justify-between gap-2 shrink-0 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="font-semibold text-sm truncate">{node.display_name}</div>
          <div className="text-xs text-muted-foreground font-mono truncate">{shortKey}…</div>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="shrink-0 h-7 w-7"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-4 p-4 text-sm">
        {/* Scores */}
        <section>
          <div className="text-[0.625rem] uppercase tracking-wider font-semibold text-muted-foreground mb-2">
            Scores
          </div>
          <div className="space-y-2">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span>Automation</span>
                <span className="text-muted-foreground">{node.automation_score}</span>
              </div>
              <ScoreBar
                value={node.automation_score}
                color={automationColor(node.automation_score)}
              />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span>Impact</span>
                <span className="text-muted-foreground">{node.impact_score}</span>
              </div>
              <ScoreBar value={node.impact_score} color={impactColor(node.impact_score)} />
            </div>
          </div>
        </section>

        {/* Classification */}
        <section>
          <div className="text-[0.625rem] uppercase tracking-wider font-semibold text-muted-foreground mb-2">
            Classification
          </div>
          <span
            className={cn(
              'inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium',
              CLASSIFICATION_COLORS[node.classification] ?? CLASSIFICATION_COLORS.unknown
            )}
          >
            {CLASSIFICATION_LABELS[node.classification] ?? node.classification}
          </span>
          {node.insufficient_data && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Need at least 4 messages for reliable scoring.
            </p>
          )}
        </section>

        {/* Behavior breakdown */}
        <section>
          <div className="text-[0.625rem] uppercase tracking-wider font-semibold text-muted-foreground mb-2">
            Behaviour breakdown
          </div>
          <div className="rounded-md border border-border bg-muted/30 divide-y divide-border text-xs">
            {[
              ['Messages', node.message_count.toLocaleString()],
              ['Msgs / hour', node.messages_per_hour.toFixed(1)],
              [
                'Avg interval',
                node.avg_interval_seconds != null
                  ? `${node.avg_interval_seconds.toFixed(0)}s`
                  : '—',
              ],
              ['Timing CV', node.timing_cv != null ? node.timing_cv.toFixed(3) : '—'],
              [
                'Pattern ratio',
                node.pattern_ratio != null ? `${(node.pattern_ratio * 100).toFixed(0)}%` : '—',
              ],
              [
                'Structured ratio',
                node.structured_ratio != null
                  ? `${(node.structured_ratio * 100).toFixed(0)}%`
                  : '—',
              ],
              ['Avg msg length', `${node.avg_message_length.toFixed(0)} chars`],
              ['Last seen', formatTs(node.last_seen)],
              ['Last analyzed', formatTs(node.last_analyzed_at)],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-2 px-3 py-1.5">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-mono text-right">{value}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Manual tag */}
        <section>
          <div className="text-[0.625rem] uppercase tracking-wider font-semibold text-muted-foreground mb-2">
            Manual tag
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(['likely_bot', 'utility_bot', 'test', 'not_a_bot'] as const).map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => onTagChange(node.manual_tag === tag ? null : tag)}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                  node.manual_tag === tag
                    ? MANUAL_TAG_COLORS[tag]
                    : 'border-border bg-background text-muted-foreground hover:bg-accent'
                )}
              >
                {MANUAL_TAG_LABELS[tag]}
              </button>
            ))}
          </div>
          {node.manual_tag && (
            <button
              type="button"
              onClick={() => onTagChange(null)}
              className="mt-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear tag
            </button>
          )}
        </section>

        {/* Recent messages */}
        {node.recent_messages && node.recent_messages.length > 0 && (
          <section>
            <div className="text-[0.625rem] uppercase tracking-wider font-semibold text-muted-foreground mb-2">
              Recent messages ({node.recent_messages.length})
            </div>
            <div className="space-y-1.5">
              {node.recent_messages.map((msg, i) => (
                <div
                  key={i}
                  className="rounded-md border border-border bg-background px-2.5 py-2 text-xs"
                >
                  <div className="text-muted-foreground mb-0.5 text-[0.625rem]">
                    {formatTs(msg.received_at)}
                  </div>
                  <div className="break-words whitespace-pre-wrap font-mono leading-relaxed">
                    {msg.text ?? <em className="not-italic text-muted-foreground">[empty]</em>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ── Main pane ──────────────────────────────────────────────────────────────

export function BotDetectorPane() {
  const [nodes, setNodes] = useState<BotDetectionNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<BotDetectionNode | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('automation');
  const [filterClassification, setFilterClassification] = useState<string>('all');
  const [showTaggedOnly, setShowTaggedOnly] = useState(false);
  const [hideNotABot, setHideNotABot] = useState(true);

  const loadNodes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.botDetectionListNodes();
      setNodes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bot detection data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNodes();
  }, [loadNodes]);

  // Reload detail when selected key changes
  useEffect(() => {
    if (!selectedKey) {
      setSelectedDetail(null);
      return;
    }
    api
      .botDetectionGetNode(selectedKey)
      .then((d) => setSelectedDetail(d))
      .catch(() => setSelectedDetail(null));
  }, [selectedKey]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      await api.botDetectionAnalyze();
      await loadNodes();
      // Refresh the open detail panel so scores update without closing/reopening
      if (selectedKey) {
        api
          .botDetectionGetNode(selectedKey)
          .then((d) => setSelectedDetail(d))
          .catch(() => setSelectedDetail(null));
      }
    } finally {
      setAnalyzing(false);
    }
  };

  const handleTagChange = async (tag: ManualTag | null) => {
    if (!selectedKey) return;
    await api.botDetectionSetTag(selectedKey, tag);
    // Update local state immediately
    setNodes((prev) =>
      prev.map((n) => (n.public_key === selectedKey ? { ...n, manual_tag: tag } : n))
    );
    setSelectedDetail((prev) => (prev ? { ...prev, manual_tag: tag } : prev));
  };

  // Sort + filter
  const sorted = [...nodes].sort((a, b) => {
    if (sortKey === 'automation') return b.automation_score - a.automation_score;
    if (sortKey === 'impact') return b.impact_score - a.impact_score;
    if (sortKey === 'messages') return b.message_count - a.message_count;
    return a.display_name.localeCompare(b.display_name);
  });

  const filtered = sorted.filter((n) => {
    if (hideNotABot && n.manual_tag === 'not_a_bot') return false;
    if (showTaggedOnly && !n.manual_tag) return false;
    if (filterClassification !== 'all' && n.classification !== filterClassification) return false;
    return true;
  });

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">Bot Detector</h2>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void loadNodes()}
              disabled={loading}
            >
              <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', loading && 'animate-spin')} />
              Refresh
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void handleAnalyze()}
              disabled={analyzing}
            >
              {analyzing ? 'Analyzing…' : 'Analyze now'}
            </Button>
          </div>
        </div>
        <p className="mt-1 text-sm text-muted-foreground max-w-3xl">
          Identifies nodes showing automated behaviour patterns — timing regularity, repetitive
          message templates, and structured reply formats. Scores are recomputed every 5 minutes.
        </p>
      </div>

      {/* Toolbar */}
      <div className="shrink-0 border-b border-border px-4 py-2 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Sort:</span>
          {(
            [
              ['automation', 'Automation'],
              ['impact', 'Impact'],
              ['messages', 'Messages'],
              ['name', 'Name'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSortKey(key)}
              className={cn(
                'rounded px-2 py-0.5 text-xs transition-colors',
                sortKey === key
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Class:</span>
          {(
            [
              ['all', 'All'],
              ['automated_high_impact', 'High impact'],
              ['automated_utility', 'Utility'],
              ['likely_human', 'Human'],
              ['insufficient_data', 'No data'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilterClassification(key)}
              className={cn(
                'rounded px-2 py-0.5 text-xs transition-colors',
                filterClassification === key
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showTaggedOnly}
            onChange={(e) => setShowTaggedOnly(e.target.checked)}
            className="rounded border-input"
          />
          Tagged only
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={hideNotABot}
            onChange={(e) => setHideNotABot(e.target.checked)}
            className="rounded border-input"
          />
          Hide "not a bot"
        </label>

        <span className="ml-auto text-xs text-muted-foreground">
          {filtered.length} node{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Table */}
        <div
          className={cn(
            'flex flex-col min-h-0 overflow-y-auto',
            selectedDetail ? 'w-[55%]' : 'flex-1'
          )}
        >
          {error && (
            <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {!loading && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center flex-1 gap-3 text-muted-foreground p-8">
              <Bot className="h-10 w-10 opacity-30" />
              <p className="text-sm text-center">
                {nodes.length === 0
                  ? 'No nodes analysed yet. Click "Analyze now" or wait for the background task.'
                  : 'No nodes match the current filter.'}
              </p>
            </div>
          )}

          {filtered.length > 0 && (
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 z-10 bg-card border-b border-border">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-muted-foreground">
                    Node
                  </th>
                  <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground w-36">
                    Automation
                  </th>
                  <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground w-36">
                    Impact
                  </th>
                  <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground hidden lg:table-cell">
                    Classification
                  </th>
                  <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground hidden xl:table-cell w-24">
                    Tag
                  </th>
                  <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground hidden xl:table-cell w-20">
                    Msgs
                  </th>
                  <th className="text-right px-4 py-2 text-xs font-semibold text-muted-foreground hidden 2xl:table-cell w-24">
                    Last seen
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((node) => {
                  const isSelected = node.public_key === selectedKey;
                  return (
                    <tr
                      key={node.public_key}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        if (isSelected) {
                          setSelectedKey(null);
                        } else {
                          setSelectedKey(node.public_key);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedKey(isSelected ? null : node.public_key);
                        }
                      }}
                      className={cn(
                        'cursor-pointer transition-colors hover:bg-accent',
                        isSelected && 'bg-primary/5'
                      )}
                    >
                      <td className="px-4 py-2.5">
                        <div className="font-medium truncate max-w-[12rem]">
                          {node.display_name}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono truncate">
                          {node.public_key.slice(0, 16)}…
                        </div>
                      </td>
                      <td className="px-3 py-2.5 w-36">
                        {node.insufficient_data ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <ScoreBar
                            value={node.automation_score}
                            color={automationColor(node.automation_score)}
                          />
                        )}
                      </td>
                      <td className="px-3 py-2.5 w-36">
                        {node.insufficient_data ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <ScoreBar
                            value={node.impact_score}
                            color={impactColor(node.impact_score)}
                          />
                        )}
                      </td>
                      <td className="px-3 py-2.5 hidden lg:table-cell">
                        <span
                          className={cn(
                            'inline-block rounded-full border px-2 py-0.5 text-[0.625rem] font-medium whitespace-nowrap',
                            CLASSIFICATION_COLORS[node.classification] ??
                              CLASSIFICATION_COLORS.unknown
                          )}
                        >
                          {CLASSIFICATION_LABELS[node.classification] ?? node.classification}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 hidden xl:table-cell w-24">
                        {node.manual_tag ? (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.625rem] font-medium',
                              MANUAL_TAG_COLORS[node.manual_tag]
                            )}
                          >
                            <Tag className="h-2.5 w-2.5" />
                            {MANUAL_TAG_LABELS[node.manual_tag]}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs hidden xl:table-cell w-20">
                        {node.message_count.toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground hidden 2xl:table-cell w-24">
                        {formatRelativeTime(node.last_seen)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Detail panel */}
        {selectedDetail && (
          <div className="w-[45%] min-w-[280px] flex-shrink-0">
            <NodeDetail
              node={selectedDetail}
              onTagChange={(tag) => void handleTagChange(tag)}
              onClose={() => {
                setSelectedKey(null);
                setSelectedDetail(null);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
