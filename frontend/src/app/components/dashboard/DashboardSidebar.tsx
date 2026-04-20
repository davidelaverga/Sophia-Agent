/**
 * Dashboard Sidebar Components — Sophia
 *
 * Borderless, text-first sidebars that melt into the dark background.
 * No panel container, no card backgrounds, no icon wells.
 * Sweep light manifests as subtle text brightness — nothing more.
 */

'use client';

import {
  ChevronRight,
  Loader2,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { haptic } from '../../hooks/useHaptics';
import { authBypassEnabled, authBypassUserId } from '../../lib/auth/dev-bypass';
import { humanizeTime } from '../../lib/humanize-time';
import type { SessionInfo } from '../../lib/session-types';
import { cn } from '../../lib/utils';
import { useAuth } from '../../providers';
import { useConversationStore } from '../../stores/conversation-store';
import { useSessionHistoryStore, type SessionHistoryEntry } from '../../stores/session-history-store';
import { useSessionStore, selectRecentSessions, selectIsLoadingSessions } from '../../stores/session-store';
import { useUiStore } from '../../stores/ui-store';

import { useSweepGlow } from './sweepLight';

// =============================================================================
// CONFIGS
// =============================================================================

function truncatePreview(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const DELETE_FEEDBACK_DELAY_MS = 220;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDeleteLabel(text: string) {
  const normalized = text.trim();
  if (!normalized) return 'session';
  return truncatePreview(normalized, 38);
}

function formatSessionCount(count: number) {
  return `${count} session${count === 1 ? '' : 's'}`;
}

function parseSessionTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeSessionStatus(status: string | null | undefined): 'open' | 'paused' | 'ended' {
  if (status === 'open' || status === 'paused') {
    return status;
  }

  return 'ended';
}

function resolveSessionDescription(session: SessionInfo | null, historyEntry: SessionHistoryEntry | undefined): string {
  const description = [
    historyEntry?.takeawayPreview?.trim(),
    session?.title?.trim(),
    session?.last_message_preview?.trim(),
    session?.focus_cue?.trim(),
    session?.intention?.trim(),
  ].find((value) => Boolean(value));

  const normalizedStatus = normalizeSessionStatus(session?.status);
  const fallback = normalizedStatus === 'ended'
    ? 'Session ended'
    : normalizedStatus === 'paused'
      ? 'Paused session'
      : 'New session';
  return truncatePreview(description || fallback, 120);
}

interface SessionListRow {
  key: string;
  sessionId: string;
  description: string;
  time: ReturnType<typeof humanizeTime>;
  turns: number;
  isActive: boolean;
  statusText: string;
  onClick: () => void;
  onDelete: () => boolean | Promise<boolean>;
  sortAt: number;
}

interface BuildSessionRowsOptions {
  recentSessions: SessionInfo[];
  historySessions: SessionHistoryEntry[];
  currentSessionId?: string;
  onOpenBackendSession: (session: SessionInfo) => void;
  onOpenLocalSession: (session: SessionHistoryEntry) => void;
  onDeleteBackendSession: (session: SessionInfo) => Promise<boolean>;
  onDeleteLocalSession: (session: SessionHistoryEntry) => boolean | Promise<boolean>;
}

function buildSessionRows({
  recentSessions,
  historySessions,
  currentSessionId,
  onOpenBackendSession,
  onOpenLocalSession,
  onDeleteBackendSession,
  onDeleteLocalSession,
}: BuildSessionRowsOptions): SessionListRow[] {
  const historyById = new Map(historySessions.map((session) => [session.sessionId, session]));
  const backendSessionIds = new Set(recentSessions.map((session) => session.session_id));
  const rows: SessionListRow[] = recentSessions.map((session) => {
    const historyEntry = historyById.get(session.session_id);
    const status = normalizeSessionStatus(session.status);
    const timeSource = status === 'ended'
      ? historyEntry?.endedAt || session.ended_at || session.updated_at
      : session.updated_at;

    const statusText = status === 'open'
      ? 'Active'
      : status === 'paused'
        ? 'Paused'
        : 'Archived';

    return {
      key: `backend-${session.session_id}`,
      sessionId: session.session_id,
      description: resolveSessionDescription(session, historyEntry),
      time: humanizeTime(timeSource),
      turns: historyEntry?.messageCount ?? session.turn_count,
      isActive: currentSessionId === session.session_id,
      statusText,
      onClick: () => onOpenBackendSession(session),
      onDelete: () => onDeleteBackendSession(session),
      sortAt: parseSessionTimestamp(timeSource),
    };
  });

  for (const session of historySessions) {
    if (backendSessionIds.has(session.sessionId)) {
      continue;
    }

    rows.push({
      key: `local-${session.sessionId}`,
      sessionId: session.sessionId,
      description: truncatePreview(session.takeawayPreview?.trim() || 'Session ended', 120),
      time: humanizeTime(session.endedAt),
      turns: session.messageCount,
      isActive: currentSessionId === session.sessionId,
      statusText: 'Archived',
      onClick: () => onOpenLocalSession(session),
      onDelete: () => onDeleteLocalSession(session),
      sortAt: parseSessionTimestamp(session.endedAt),
    });
  }

  return rows.sort((left, right) => right.sortAt - left.sortAt);
}

// =============================================================================
// HIGHLIGHT — wraps matching substrings
// =============================================================================

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));

  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark
            key={i}
            className="rounded-sm bg-transparent font-medium"
            style={{ color: 'var(--sophia-purple)' }}
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

// =============================================================================
// SESSION ROW — description-first, no preset label
// =============================================================================

interface SessionRowProps {
  rowKey: string;
  description: string;
  timeText: string;
  timeTooltip: string;
  turns: number;
  statusText: string;
  isActive: boolean;
  query: string;
  isDeleting: boolean;
  onClick: () => void;
  onDelete: () => void | Promise<void>;
}

function SessionRow({
  rowKey: _rowKey,
  description,
  timeText,
  timeTooltip,
  turns,
  statusText,
  isActive,
  query,
  isDeleting,
  onClick,
  onDelete,
}: SessionRowProps) {
  const sweepRef = useSweepGlow();
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (isDeleting) {
      setConfirmDelete(false);
    }
  }, [isDeleting]);

  return (
    <button
      ref={sweepRef as RefObject<HTMLButtonElement>}
      onClick={() => {
        if (isDeleting) return;
        if (confirmDelete) { setConfirmDelete(false); return; }
        haptic('light');
        onClick();
      }}
      onMouseLeave={() => { if (!isDeleting) setConfirmDelete(false); }}
      aria-busy={isDeleting}
      className={cn(
        'cosmic-focus-ring group relative w-full rounded-lg px-3 py-2.5 text-left transition-all duration-200',
        'hover:bg-white/[0.03]',
        isDeleting && 'scale-[0.985] bg-red-500/[0.06] opacity-70',
      )}
      style={{
        filter: 'brightness(calc(1 + var(--sweep-glow, 0) * 0.18))',
        boxShadow: [
          `calc(var(--sweep-sx, 0) * 4px) calc(var(--sweep-sy, 0) * 4px) calc(6px + var(--sweep-glow, 0) * 8px) rgba(0,0,0, calc(0.15 + var(--sweep-glow, 0) * 0.25))`,
          `0 0 calc(var(--sweep-glow, 0) * 12px) color-mix(in srgb, var(--sophia-purple) calc(var(--sweep-glow, 0) * 8%), transparent)`,
        ].join(', '),
      }}
    >
      {/* Active accent — 2px left bar */}
      {isActive && (
        <span
          className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full"
          style={{ background: 'var(--sophia-purple)', boxShadow: '0 0 8px var(--sophia-purple)' }}
        />
      )}

      {/* Delete: two-step — first click shows confirm, second click deletes */}
      {isDeleting ? (
        <span
          aria-live="polite"
          className={cn(
            'absolute right-2 top-2 flex items-center gap-1 rounded-md px-1.5 py-0.5',
            'text-[10px] font-medium transition-all duration-150',
            'bg-red-500/15',
          )}
          style={{ color: 'var(--error)' }}
        >
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          Deleting...
        </span>
      ) : confirmDelete ? (
        <span
          role="button"
          tabIndex={0}
          aria-label="Confirm delete"
          onClick={(e) => { e.stopPropagation(); haptic('medium'); void onDelete(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); haptic('medium'); void onDelete(); } }}
          className={cn(
            'absolute right-2 top-2 flex items-center gap-1 rounded-md px-1.5 py-0.5',
            'text-[10px] font-medium transition-all duration-150',
            'bg-red-500/15 hover:bg-red-500/25',
          )}
          style={{ color: 'var(--error)' }}
        >
          <Trash2 className="h-2.5 w-2.5" />
          Delete?
        </span>
      ) : (
        <span
          role="button"
          tabIndex={0}
          aria-label="Delete session"
          onClick={(e) => { e.stopPropagation(); haptic('light'); setConfirmDelete(true); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); haptic('light'); setConfirmDelete(true); } }}
          className={cn(
            'absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-md',
            'opacity-0 transition-opacity duration-150 group-hover:opacity-100',
            'hover:bg-white/[0.08]',
          )}
          style={{ color: 'var(--cosmic-text-whisper)' }}
        >
          <Trash2 className="h-3 w-3" />
        </span>
      )}

      <p
        className={cn(
          'line-clamp-2 pr-5 text-[13px] leading-snug transition-colors duration-200',
          isActive ? 'font-medium' : 'font-normal',
          isDeleting && 'pr-16',
        )}
        style={{ color: isActive ? 'var(--cosmic-text-strong)' : 'var(--cosmic-text)' }}
      >
        <HighlightText text={description} query={query} />
      </p>

      <div className="mt-1 flex items-center gap-1">
        <span
          className="text-[10px]"
          style={{ color: 'var(--cosmic-text-whisper)' }}
          title={timeTooltip}
        >
          {timeText}
        </span>
        {turns > 0 && (
          <>
            <span style={{ color: 'var(--cosmic-text-faint)' }}>&middot;</span>
            <span className="text-[10px]" style={{ color: 'var(--cosmic-text-whisper)' }}>
              {turns} {turns === 1 ? 'turn' : 'turns'}
            </span>
          </>
        )}
        <>
          <span style={{ color: 'var(--cosmic-text-faint)' }}>&middot;</span>
          <span
            className="text-[10px]"
            style={{ color: isActive ? 'var(--sophia-purple)' : 'var(--cosmic-text-whisper)' }}
          >
            {statusText}
          </span>
        </>
        {isDeleting && (
          <>
            <span style={{ color: 'var(--cosmic-text-faint)' }}>&middot;</span>
            <span className="text-[10px] font-medium" style={{ color: 'var(--error)' }}>
              Removing
            </span>
          </>
        )}
      </div>
    </button>
  );
}

function useDeleteFeedback() {
  const showToast = useUiStore((state) => state.showToast);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const runDelete = useCallback(async ({
    key,
    label,
    onDelete,
  }: {
    key: string;
    label: string;
    onDelete: () => boolean | void | Promise<boolean | void>;
  }) => {
    if (deletingKey === key) return;

    setDeletingKey(key);
    await wait(DELETE_FEEDBACK_DELAY_MS);

    let deleted = false;
    try {
      deleted = (await onDelete()) !== false;
    } catch {
      deleted = false;
    }

    if (deleted) {
      haptic('success');
      showToast({
        message: `Deleted ${formatDeleteLabel(label)}.`,
        variant: 'success',
        durationMs: 3200,
      });
      setDeletingKey((current) => (current === key ? null : current));
      return;
    }

    haptic('error');
    setDeletingKey((current) => (current === key ? null : current));
    showToast({
      message: `Couldn't delete ${formatDeleteLabel(label)}.`,
      variant: 'error',
    });
  }, [deletingKey, showToast]);

  return {
    deletingKey,
    runDelete,
  };
}

function useClearAllFeedback() {
  const showToast = useUiStore((state) => state.showToast);
  const [isClearingAll, setIsClearingAll] = useState(false);
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  const requestClearAll = useCallback(() => {
    if (isClearingAll) return;
    haptic('light');
    setConfirmClearAll(true);
  }, [isClearingAll]);

  const cancelClearAll = useCallback(() => {
    if (isClearingAll) return;
    setConfirmClearAll(false);
  }, [isClearingAll]);

  const runClearAll = useCallback(async ({
    count,
    onClearAll,
  }: {
    count: number;
    onClearAll: () => boolean | void | Promise<boolean | void>;
  }) => {
    if (isClearingAll) return;

    setIsClearingAll(true);
    await wait(DELETE_FEEDBACK_DELAY_MS);

    let cleared = false;
    try {
      cleared = (await onClearAll()) !== false;
    } catch {
      cleared = false;
    }

    setIsClearingAll(false);
    setConfirmClearAll(false);

    if (cleared) {
      haptic('success');
      showToast({
        message: `Cleared ${formatSessionCount(count)}.`,
        variant: 'success',
        durationMs: 3200,
      });
      return;
    }

    haptic('error');
    showToast({
      message: "Couldn't clear all sessions.",
      variant: 'error',
    });
  }, [isClearingAll, showToast]);

  return {
    isClearingAll,
    confirmClearAll,
    requestClearAll,
    cancelClearAll,
    runClearAll,
  };
}

function ClearAllSessionsButton({
  count,
  isClearingAll,
  confirmClearAll,
  onRequestClearAll,
  onCancelClearAll,
  onConfirmClearAll,
}: {
  count: number;
  isClearingAll: boolean;
  confirmClearAll: boolean;
  onRequestClearAll: () => void;
  onCancelClearAll: () => void;
  onConfirmClearAll: () => void;
}) {
  if (count === 0) return null;

  if (isClearingAll) {
    return (
      <span
        aria-live="polite"
        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium"
        style={{
          color: 'var(--error)',
          background: 'color-mix(in srgb, var(--error) 12%, transparent)',
        }}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Clearing...
      </span>
    );
  }

  if (confirmClearAll) {
    return (
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Confirm clear all sessions"
          onClick={onConfirmClearAll}
          className="cosmic-focus-ring inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium transition-colors duration-150"
          style={{
            color: 'var(--error)',
            background: 'color-mix(in srgb, var(--error) 12%, transparent)',
          }}
        >
          <Trash2 className="h-3 w-3" />
          Delete {count}?
        </button>
        <button
          type="button"
          aria-label="Cancel clear all sessions"
          onClick={onCancelClearAll}
          className="cosmic-focus-ring inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors duration-150 hover:bg-white/[0.06]"
          style={{ color: 'var(--cosmic-text-whisper)' }}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-label="Clear all sessions"
      onClick={onRequestClearAll}
      className="cosmic-focus-ring inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium transition-colors duration-150 hover:bg-white/[0.06]"
      style={{ color: 'var(--cosmic-text-whisper)' }}
      title={`Delete all ${formatSessionCount(count)}`}
    >
      <Trash2 className="h-3 w-3" />
      Clear all
    </button>
  );
}

// =============================================================================
// LEFT SIDEBAR: Sessions
// =============================================================================

interface RecentSessionsSidebarProps {
  isExpanded: boolean;
  onToggle: () => void;
  className?: string;
}

export function RecentSessionsSidebar({
  isExpanded,
  onToggle,
  className,
}: RecentSessionsSidebarProps) {
  const { user } = useAuth();
  const router = useRouter();
  const historySessions = useSessionHistoryStore((s) => s.sessions);
  const clearHistory = useSessionHistoryStore((s) => s.clearHistory);
  const removeHistorySession = useSessionHistoryStore((s) => s.removeSession);
  const recentSessions = useSessionStore(selectRecentSessions);
  const isLoadingSessions = useSessionStore(selectIsLoadingSessions);
  const refreshRecentSessions = useSessionStore((s) => s.refreshRecentSessions);
  const restoreOpenSession = useSessionStore((s) => s.restoreOpenSession);
  const viewEndedSession = useSessionStore((s) => s.viewEndedSession);
  const clearSession = useSessionStore((s) => s.clearSession);
  const removeAllSessions = useSessionStore((s) => s.removeAllSessions);
  const removeOpenSession = useSessionStore((s) => s.removeOpenSession);
  const removeRecentSession = useSessionStore((s) => s.removeRecentSession);
  const currentSession = useSessionStore((s) => s.session);
  const [query, setQuery] = useState('');
  const { deletingKey, runDelete } = useDeleteFeedback();
  const { isClearingAll, confirmClearAll, requestClearAll, cancelClearAll, runClearAll } = useClearAllFeedback();
  const resolvedUserId = user?.id || currentSession?.userId || (authBypassEnabled ? authBypassUserId : undefined);

  const panelSweepRef = useSweepGlow();

  useEffect(() => {
    if (isExpanded) void refreshRecentSessions(resolvedUserId);
  }, [isExpanded, refreshRecentSessions, resolvedUserId]);

  const rows = useMemo(() => {
    return buildSessionRows({
      recentSessions,
      historySessions,
      currentSessionId: currentSession?.sessionId,
      onOpenBackendSession: (session) => {
        void (async () => {
          await restoreOpenSession(session, resolvedUserId);
          router.push('/session');
        })();
      },
      onOpenLocalSession: (session) => {
        viewEndedSession(session.sessionId, session.presetType, session.contextMode);
        router.push('/session');
      },
      onDeleteBackendSession: async (session) => {
        const deleted = normalizeSessionStatus(session.status) !== 'ended'
          ? await removeOpenSession(session.session_id, resolvedUserId)
          : await removeRecentSession(session.session_id, resolvedUserId);
        if (deleted) {
          removeHistorySession(session.session_id);
        }
        return deleted;
      },
      onDeleteLocalSession: async (session) => {
        removeHistorySession(session.sessionId);
        return true;
      },
    });
  }, [recentSessions, historySessions, currentSession?.sessionId, restoreOpenSession, resolvedUserId, router, viewEndedSession, removeOpenSession, removeRecentSession, removeHistorySession]);

  const badgeCount = rows.length;

  const filtered = useMemo(() => {
    if (!query.trim()) return rows;
    const q = query.toLowerCase();
    return rows.filter((r) => r.description.toLowerCase().includes(q));
  }, [rows, query]);

  const handleClearAll = useCallback(async () => {
    const hasBackendRows = rows.some((row) => row.key.startsWith('backend-'));

    if (hasBackendRows) {
      const deleted = await removeAllSessions(resolvedUserId);
      if (!deleted) {
        return false;
      }
    }

    clearHistory();

    if (currentSession?.sessionId && rows.some((row) => row.sessionId === currentSession.sessionId)) {
      clearSession();
    }

    return true;
  }, [rows, removeAllSessions, resolvedUserId, clearHistory, currentSession?.sessionId, clearSession]);

  const sessionsBadge = badgeCount > 9 ? '9+' : String(badgeCount);

  return (
    <div className={cn(
      'hidden lg:flex flex-col overflow-hidden transition-all duration-300 ease-out',
      isExpanded ? 'w-[220px] opacity-100' : 'w-0 opacity-0 pointer-events-none',
      className,
    )}>
      {/* Content */}
      {isExpanded && (
        <div
          ref={panelSweepRef as RefObject<HTMLDivElement>}
          className="flex flex-1 flex-col overflow-hidden rounded-2xl"
          style={{
            filter: 'brightness(calc(1 + var(--sweep-glow, 0) * 0.12))',
            boxShadow: [
              `calc(var(--sweep-sx, 0) * 6px) calc(var(--sweep-sy, 0) * 6px) calc(12px + var(--sweep-glow, 0) * 16px) rgba(0,0,0, calc(0.12 + var(--sweep-glow, 0) * 0.2))`,
              `0 0 calc(var(--sweep-glow, 0) * 20px) color-mix(in srgb, var(--sophia-purple) calc(var(--sweep-glow, 0) * 6%), transparent)`,
            ].join(', '),
          }}
        >
          <div className="mb-3 flex items-center justify-between px-2">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-medium" style={{ color: 'var(--cosmic-text)' }}>
                Sessions
              </span>
              {badgeCount > 0 ? (
                <span
                  className="flex min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold text-white"
                  style={{ background: 'var(--sophia-purple)' }}
                >
                  {sessionsBadge}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-1">
              <ClearAllSessionsButton
                count={badgeCount}
                isClearingAll={isClearingAll}
                confirmClearAll={confirmClearAll}
                onRequestClearAll={requestClearAll}
                onCancelClearAll={cancelClearAll}
                onConfirmClearAll={() => void runClearAll({ count: badgeCount, onClearAll: handleClearAll })}
              />
              <button
                type="button"
                onClick={() => { haptic('light'); onToggle(); }}
                aria-label="Collapse sessions"
                title="Collapse sessions"
                className="cosmic-focus-ring flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-200 hover:bg-white/[0.06]"
                style={{ color: 'var(--cosmic-text-muted)' }}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Search */}
          <div className="relative mb-3 px-2">
            <Search
              className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
              style={{ color: 'var(--cosmic-text-whisper)' }}
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sessions…"
              className={cn(
                'w-full rounded-lg border-0 bg-white/[0.04] py-1.5 pl-8 pr-3',
                'text-[12px] placeholder:text-[12px]',
                'outline-none transition-colors duration-200',
                'focus:bg-white/[0.06]',
              )}
              style={{
                color: 'var(--cosmic-text)',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ['--tw-placeholder-opacity' as any]: 1,
              }}
            />
          </div>

          {/* List */}
          <div className="flex-1 space-y-0.5 overflow-y-auto" style={{ maxHeight: 'calc(100% - 48px)' }}>
            {isLoadingSessions && rows.length === 0 && (
              <div className="flex items-center justify-center py-8">
                <div
                  className="h-4 w-4 animate-spin rounded-full border-2"
                  style={{ borderColor: 'var(--cosmic-border-soft)', borderTopColor: 'var(--sophia-purple)' }}
                />
              </div>
            )}

            {filtered.map((r) => (
              <SessionRow
                key={r.key}
                rowKey={r.key}
                description={r.description}
                timeText={r.time.text}
                timeTooltip={r.time.tooltip}
                turns={r.turns}
                statusText={r.statusText}
                isActive={r.isActive}
                query={query}
                isDeleting={deletingKey === r.key}
                onClick={r.onClick}
                onDelete={() => runDelete({ key: r.key, label: r.description, onDelete: r.onDelete })}
              />
            ))}

            {filtered.length === 0 && !isLoadingSessions && rows.length > 0 && (
              <p className="px-3 pt-4 text-[12px]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                No matches
              </p>
            )}

            {rows.length === 0 && !isLoadingSessions && (
              <p className="px-3 pt-4 text-[12px]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                No sessions yet
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// RIGHT SIDEBAR: Last Insight
// =============================================================================

interface ConversationHistorySidebarProps {
  isExpanded: boolean;
  onToggle: () => void;
  className?: string;
}

export function ConversationHistorySidebar({
  isExpanded,
  onToggle,
  className,
}: ConversationHistorySidebarProps) {
  const sweepRef = useSweepGlow();
  const refreshConversations = useConversationStore((s) => s.refreshConversations);
  const sessions = useSessionHistoryStore((s) => s.sessions);
  const lastInsight = sessions.find((s) => s.takeawayPreview);

  const handleToggle = useCallback(() => {
    if (!isExpanded) void refreshConversations();
    onToggle();
  }, [isExpanded, onToggle, refreshConversations]);

  return (
    <div className={cn(
      'hidden lg:flex flex-col transition-all duration-300 ease-out',
      isExpanded ? 'w-[220px]' : 'w-14',
      className,
    )}>
      {/* Toggle */}
      <button
        onClick={() => { haptic('light'); handleToggle(); }}
        className={cn(
          'cosmic-chrome-button cosmic-focus-ring flex h-10 w-10 items-center justify-center rounded-xl mb-6 transition-all duration-200 hover:scale-105',
          !isExpanded && 'self-center',
        )}
        aria-label={isExpanded ? 'Collapse insight' : 'Expand insight'}
      >
        {isExpanded ? <ChevronRight className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
      </button>

      {/* Content — borderless */}
      {isExpanded && (
        <div
          ref={sweepRef as RefObject<HTMLDivElement>}
          className="flex-1 overflow-hidden"
          style={{ filter: 'brightness(calc(1 + var(--sweep-glow, 0) * 0.15))' }}
        >
          <h3
            className="mb-4 px-3 font-cormorant text-[1.1rem] leading-none"
            style={{ color: 'var(--cosmic-text-muted)' }}
          >
            Insight
          </h3>

          {!lastInsight ? (
            <p className="px-3 text-[12px]" style={{ color: 'var(--cosmic-text-whisper)' }}>
              Complete a session to see your takeaway
            </p>
          ) : (
            <div className="px-3">
              <div
                className="select-none font-serif text-xl leading-none"
                style={{ color: 'color-mix(in srgb, var(--sophia-glow) 20%, transparent)' }}
              >&ldquo;</div>

              <p
                className="mt-1 line-clamp-5 text-[13px] leading-relaxed"
                style={{ color: 'var(--cosmic-text)' }}
              >
                {lastInsight.takeawayPreview}
              </p>

              <div className="mt-3">
                <span className="text-[10px]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                  {humanizeTime(lastInsight.endedAt).text}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// MOBILE BOTTOM SHEET
// =============================================================================

interface MobileBottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}

export function MobileBottomSheet({ isOpen, onClose, title, icon, children }: MobileBottomSheetProps) {
  // Fire a soft haptic the first time the sheet opens so the user feels the
  // surface rise. We use a ref-based latch so re-renders don't retrigger it.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      wasOpenRef.current = true;
      haptic('light');
    } else if (!isOpen && wasOpenRef.current) {
      wasOpenRef.current = false;
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    haptic('selection');
    onClose();
  }, [onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="cosmic-modal-backdrop absolute inset-0" onClick={handleClose} />
      <div className={cn(
        'absolute bottom-0 left-0 right-0',
        'cosmic-surface-panel-strong rounded-t-3xl border-t',
        'max-h-[70vh] overflow-hidden',
        'animate-in slide-in-from-bottom duration-300',
      )}>
        <div className="flex justify-center pb-2 pt-3">
          <div className="h-1 w-10 rounded-full" style={{ background: 'var(--cosmic-text-faint)' }} />
        </div>
        <div className="flex items-center justify-between px-5 pb-4">
          <div className="flex items-center gap-2">
            {icon}
            <h3 className="text-lg font-semibold" style={{ color: 'var(--cosmic-text-strong)' }}>{title}</h3>
          </div>
          <button
            onClick={handleClose}
            className="cosmic-chrome-button cosmic-focus-ring rounded-xl p-2 transition-colors"
          >
            <X className="h-5 w-5" style={{ color: 'var(--cosmic-text-muted)' }} />
          </button>
        </div>
        <div className="max-h-[calc(70vh-100px)] overflow-y-auto px-5 pb-8">
          {children}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// MOBILE SESSIONS SHEET CONTENT
// =============================================================================

export function MobileSessionsContent() {
  const { user } = useAuth();
  const router = useRouter();
  const historySessions = useSessionHistoryStore((s) => s.sessions);
  const clearHistory = useSessionHistoryStore((s) => s.clearHistory);
  const removeHistorySession = useSessionHistoryStore((s) => s.removeSession);
  const recentSessions = useSessionStore(selectRecentSessions);
  const refreshRecentSessions = useSessionStore((s) => s.refreshRecentSessions);
  const restoreOpenSession = useSessionStore((s) => s.restoreOpenSession);
  const viewEndedSession = useSessionStore((s) => s.viewEndedSession);
  const clearSession = useSessionStore((s) => s.clearSession);
  const removeAllSessions = useSessionStore((s) => s.removeAllSessions);
  const removeOpenSession = useSessionStore((s) => s.removeOpenSession);
  const removeRecentSession = useSessionStore((s) => s.removeRecentSession);
  const currentSession = useSessionStore((s) => s.session);
  const [query, setQuery] = useState('');
  const { deletingKey, runDelete } = useDeleteFeedback();
  const { isClearingAll, confirmClearAll, requestClearAll, cancelClearAll, runClearAll } = useClearAllFeedback();
  const resolvedUserId = user?.id || currentSession?.userId || (authBypassEnabled ? authBypassUserId : undefined);

  useEffect(() => {
    void refreshRecentSessions(resolvedUserId);
  }, [refreshRecentSessions, resolvedUserId]);

  const rows = useMemo(() => {
    return buildSessionRows({
      recentSessions,
      historySessions,
      currentSessionId: currentSession?.sessionId,
      onOpenBackendSession: (session) => {
        void (async () => {
          await restoreOpenSession(session, resolvedUserId);
          router.push('/session');
        })();
      },
      onOpenLocalSession: (session) => {
        viewEndedSession(session.sessionId, session.presetType, session.contextMode);
        router.push('/session');
      },
      onDeleteBackendSession: async (session) => {
        const deleted = normalizeSessionStatus(session.status) !== 'ended'
          ? await removeOpenSession(session.session_id, resolvedUserId)
          : await removeRecentSession(session.session_id, resolvedUserId);
        if (deleted) {
          removeHistorySession(session.session_id);
        }
        return deleted;
      },
      onDeleteLocalSession: async (session) => {
        removeHistorySession(session.sessionId);
        return true;
      },
    });
  }, [recentSessions, historySessions, currentSession?.sessionId, restoreOpenSession, resolvedUserId, router, viewEndedSession, removeOpenSession, removeRecentSession, removeHistorySession]);

  const filtered = useMemo(() => {
    if (!query.trim()) return rows;
    const q = query.toLowerCase();
    return rows.filter((r) => r.description.toLowerCase().includes(q));
  }, [rows, query]);

  const handleClearAll = useCallback(async () => {
    const hasBackendRows = rows.some((row) => row.key.startsWith('backend-'));

    if (hasBackendRows) {
      const deleted = await removeAllSessions(resolvedUserId);
      if (!deleted) {
        return false;
      }
    }

    clearHistory();

    if (currentSession?.sessionId && rows.some((row) => row.sessionId === currentSession.sessionId)) {
      clearSession();
    }

    return true;
  }, [rows, removeAllSessions, resolvedUserId, clearHistory, currentSession?.sessionId, clearSession]);

  if (rows.length === 0) {
    return (
      <p className="py-12 text-center text-sm" style={{ color: 'var(--cosmic-text-whisper)' }}>
        No sessions yet
      </p>
    );
  }

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <ClearAllSessionsButton
          count={rows.length}
          isClearingAll={isClearingAll}
          confirmClearAll={confirmClearAll}
          onRequestClearAll={requestClearAll}
          onCancelClearAll={cancelClearAll}
          onConfirmClearAll={() => void runClearAll({ count: rows.length, onClearAll: handleClearAll })}
        />
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
          style={{ color: 'var(--cosmic-text-whisper)' }}
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions…"
          className={cn(
            'w-full rounded-lg border-0 bg-white/[0.04] py-1.5 pl-8 pr-3',
            'text-[12px] placeholder:text-[12px]',
            'outline-none transition-colors duration-200',
            'focus:bg-white/[0.06]',
          )}
          style={{ color: 'var(--cosmic-text)' }}
        />
      </div>

      <div className="space-y-0.5">
        {filtered.map((r) => (
          <SessionRow
            key={r.key}
            rowKey={r.key}
            description={r.description}
            timeText={r.time.text}
            timeTooltip={r.time.tooltip}
            turns={r.turns}
            statusText={r.statusText}
            isActive={r.isActive}
            query={query}
            isDeleting={deletingKey === r.key}
            onClick={r.onClick}
            onDelete={() => runDelete({ key: r.key, label: r.description, onDelete: r.onDelete })}
          />
        ))}
        {filtered.length === 0 && (
          <p className="px-3 pt-4 text-[12px]" style={{ color: 'var(--cosmic-text-whisper)' }}>
            No matches
          </p>
        )}
      </div>
    </div>
  );
}
