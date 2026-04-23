/**
 * Dashboard Sidebar Components — Sophia
 *
 * Borderless, text-first sidebars that melt into the dark background.
 * No panel container, no card backgrounds, no icon wells.
 * Sweep light manifests as subtle text brightness — nothing more.
 */

'use client';

import {
  ChevronLeft,
  ChevronRight,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';

import { haptic } from '../../hooks/useHaptics';
import { authBypassEnabled, authBypassUserId } from '../../lib/auth/dev-bypass';
import { humanizeTime } from '../../lib/humanize-time';
import { cn } from '../../lib/utils';
import { useAuth } from '../../providers';
import { useConversationStore } from '../../stores/conversation-store';
import { useSessionHistoryStore } from '../../stores/session-history-store';
import { useSessionStore, selectIsLoadingSessions } from '../../stores/session-store';

import { useSweepGlow } from './sweepLight';

// =============================================================================
// CONFIGS
// =============================================================================

function truncatePreview(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
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
  description: string;
  timeText: string;
  timeTooltip: string;
  turns: number;
  isActive: boolean;
  query: string;
  onClick: () => void;
  onDelete: () => void;
}

function SessionRow({
  description,
  timeText,
  timeTooltip,
  turns,
  isActive,
  query,
  onClick,
  onDelete,
}: SessionRowProps) {
  const sweepRef = useSweepGlow();
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <button
      ref={sweepRef as RefObject<HTMLButtonElement>}
      onClick={() => { if (confirmDelete) { setConfirmDelete(false); return; } haptic('light'); onClick(); }}
      onMouseLeave={() => setConfirmDelete(false)}
      className={cn(
        'cosmic-focus-ring group relative w-full rounded-lg px-3 py-2.5 text-left transition-all duration-200',
        'hover:bg-white/[0.03]',
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
      {confirmDelete ? (
        <span
          role="button"
          tabIndex={0}
          aria-label="Confirm delete"
          onClick={(e) => { e.stopPropagation(); haptic('medium'); onDelete(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onDelete(); } }}
          className={cn(
            'absolute right-2 top-2 flex items-center gap-1 rounded-md px-1.5 py-0.5',
            'text-[10px] font-medium transition-all duration-150',
            'bg-red-500/15 hover:bg-red-500/25',
          )}
          style={{ color: 'rgb(248 113 113)' }}
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
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setConfirmDelete(true); } }}
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
      </div>
    </button>
  );
}

// =============================================================================
// LEFT SIDEBAR: Sessions
// =============================================================================
// Ownership contract:
// - NavRail owns the collapsed desktop Sessions trigger.
// - RecentSessionsSidebar owns only the expanded session browser surface.
// - When collapsed, this component should disappear entirely instead of
//   rendering a second session-history button beside the rail.

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
  const router = useRouter();
  const { user } = useAuth();
  const endedSessions = useSessionHistoryStore((s) => s.sessions);
  const removeEndedSession = useSessionHistoryStore((s) => s.removeSession);
  const openSessions = useSessionStore((s) => s.openSessions);
  const isLoadingSessions = useSessionStore(selectIsLoadingSessions);
  const refreshOpenSessions = useSessionStore((s) => s.refreshOpenSessions);
  const restoreOpenSession = useSessionStore((s) => s.restoreOpenSession);
  const viewEndedSession = useSessionStore((s) => s.viewEndedSession);
  const removeOpenSession = useSessionStore((s) => s.removeOpenSession);
  const currentSession = useSessionStore((s) => s.session);
  const [query, setQuery] = useState('');
  const resolvedUserId = currentSession?.userId || user?.id || (authBypassEnabled ? authBypassUserId : undefined);

  const panelSweepRef = useSweepGlow();

  const badgeCount = openSessions.length || endedSessions.filter((s) => !s.recapViewed).length;

  useEffect(() => {
    if (isExpanded) void refreshOpenSessions();
  }, [isExpanded, refreshOpenSessions]);

  const rows = useMemo(() => {
    const list: Array<{
      key: string;
      description: string;
      time: ReturnType<typeof humanizeTime>;
      turns: number;
      isActive: boolean;
      onClick: () => void;
      onDelete: () => void;
    }> = [];

    for (const s of openSessions) {
      const desc =
        s.title?.trim()
        || s.last_message_preview?.trim()
        || s.focus_cue?.trim()
        || s.intention?.trim()
        || 'New session';
      list.push({
        key: `open-${s.session_id}`,
        description: truncatePreview(desc, 120),
        time: humanizeTime(s.updated_at),
        turns: s.turn_count,
        isActive: currentSession?.sessionId === s.session_id,
        onClick: () => {
          void restoreOpenSession(s, resolvedUserId)
            .catch(() => {
              // Session page has its own recovery path; still navigate to preserve resume UX.
            })
            .finally(() => {
              router.push('/session');
            });
        },
        onDelete: () => {
          void removeOpenSession(s.session_id);
        },
      });
    }

    for (const s of endedSessions) {
      const desc =
        s.takeawayPreview?.trim()
        || 'Session ended';
      list.push({
        key: `ended-${s.sessionId}`,
        description: truncatePreview(desc, 120),
        time: humanizeTime(s.endedAt),
        turns: s.messageCount,
        isActive: currentSession?.sessionId === s.sessionId,
        onClick: () => { viewEndedSession(s.sessionId, s.presetType, s.contextMode); router.push('/session'); },
        onDelete: () => removeEndedSession(s.sessionId),
      });
    }

    return list;
  }, [openSessions, endedSessions, currentSession?.sessionId, restoreOpenSession, resolvedUserId, viewEndedSession, removeOpenSession, removeEndedSession, router]);

  const filtered = useMemo(() => {
    if (!query.trim()) return rows;
    const q = query.toLowerCase();
    return rows.filter((r) => r.description.toLowerCase().includes(q));
  }, [rows, query]);

  return (
    <div className={cn(
      'hidden overflow-hidden lg:flex flex-col transition-all duration-300 ease-out',
      isExpanded ? 'w-[220px]' : 'w-0',
      className,
    )}>
      {isExpanded && (
        <>
          {/* This control only collapses the already-open panel; opening lives in NavRail. */}
          {/* Toggle */}
          <button
            onClick={() => { haptic('light'); onToggle(); }}
            className="cosmic-chrome-button cosmic-focus-ring relative mb-6 flex h-10 w-10 items-center justify-center self-start rounded-xl transition-all duration-200 hover:scale-105"
            aria-label="Collapse sessions"
            title="Collapse sessions"
          >
            <ChevronLeft className="h-4 w-4" />
            {badgeCount > 0 && (
              <span
                className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                style={{ background: 'var(--sophia-purple)' }}
              >
                {badgeCount > 9 ? '9+' : badgeCount}
              </span>
            )}
          </button>

          {/* Content */}
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
                  description={r.description}
                  timeText={r.time.text}
                  timeTooltip={r.time.tooltip}
                  turns={r.turns}
                  isActive={r.isActive}
                  query={query}
                  onClick={r.onClick}
                  onDelete={r.onDelete}
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
        </>
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
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="cosmic-modal-backdrop absolute inset-0" onClick={onClose} />
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
            onClick={onClose}
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
  const router = useRouter();
  const { user } = useAuth();
  const endedSessions = useSessionHistoryStore((s) => s.sessions);
  const removeEndedSession = useSessionHistoryStore((s) => s.removeSession);
  const openSessions = useSessionStore((s) => s.openSessions);
  const restoreOpenSession = useSessionStore((s) => s.restoreOpenSession);
  const viewEndedSession = useSessionStore((s) => s.viewEndedSession);
  const removeOpenSession = useSessionStore((s) => s.removeOpenSession);
  const currentSession = useSessionStore((s) => s.session);
  const [query, setQuery] = useState('');
  const resolvedUserId = currentSession?.userId || user?.id || (authBypassEnabled ? authBypassUserId : undefined);

  const rows = useMemo(() => {
    const list: Array<{
      key: string;
      description: string;
      time: ReturnType<typeof humanizeTime>;
      turns: number;
      isActive: boolean;
      onClick: () => void;
      onDelete: () => void;
    }> = [];

    for (const s of openSessions) {
      const desc =
        s.title?.trim()
        || s.last_message_preview?.trim()
        || s.focus_cue?.trim()
        || s.intention?.trim()
        || 'New session';
      list.push({
        key: `open-${s.session_id}`,
        description: truncatePreview(desc, 120),
        time: humanizeTime(s.updated_at),
        turns: s.turn_count,
        isActive: currentSession?.sessionId === s.session_id,
        onClick: () => {
          void restoreOpenSession(s, resolvedUserId)
            .catch(() => {
              // Session page has its own recovery path; still navigate to preserve resume UX.
            })
            .finally(() => {
              router.push('/session');
            });
        },
        onDelete: () => {
          void removeOpenSession(s.session_id);
        },
      });
    }

    for (const s of endedSessions) {
      const desc =
        s.takeawayPreview?.trim()
        || 'Session ended';
      list.push({
        key: `ended-${s.sessionId}`,
        description: truncatePreview(desc, 120),
        time: humanizeTime(s.endedAt),
        turns: s.messageCount,
        isActive: currentSession?.sessionId === s.sessionId,
        onClick: () => { viewEndedSession(s.sessionId, s.presetType, s.contextMode); router.push('/session'); },
        onDelete: () => removeEndedSession(s.sessionId),
      });
    }

    return list;
  }, [openSessions, endedSessions, currentSession?.sessionId, restoreOpenSession, resolvedUserId, viewEndedSession, removeOpenSession, removeEndedSession, router]);

  const filtered = useMemo(() => {
    if (!query.trim()) return rows;
    const q = query.toLowerCase();
    return rows.filter((r) => r.description.toLowerCase().includes(q));
  }, [rows, query]);

  if (rows.length === 0) {
    return (
      <p className="py-12 text-center text-sm" style={{ color: 'var(--cosmic-text-whisper)' }}>
        No sessions yet
      </p>
    );
  }

  return (
    <div>
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
            description={r.description}
            timeText={r.time.text}
            timeTooltip={r.time.tooltip}
            turns={r.turns}
            isActive={r.isActive}
            query={query}
            onClick={r.onClick}
            onDelete={r.onDelete}
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
