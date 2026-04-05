/**
 * Session History Component
 * Phase 3 - Week 3
 * 
 * Shows recent sessions with quick access to read-only session view.
 * Compact horizontal scroll on mobile, list on desktop.
 */

'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Clock, 
  ChevronRight, 
  MessageCircle,
  Target,
  RefreshCw,
  Wind,
  Sparkles,
  Brain,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';
import { useConversationStore } from '../../stores/conversation-store';
import { useSessionHistoryStore, type SessionHistoryEntry } from '../../stores/session-history-store';
import { useUiStore } from '../../stores/ui-store';
import { humanizeTime } from '../../lib/humanize-time';
import type { PresetType, ContextMode } from '../../lib/session-types';

// =============================================================================
// CONFIGS
// =============================================================================

const PRESET_ICONS: Record<PresetType, typeof Target> = {
  prepare: Target,
  debrief: MessageCircle,
  reset: RefreshCw,
  vent: Wind,
  open: MessageCircle,
  chat: MessageCircle,
};

const PRESET_LABELS: Record<PresetType, Record<ContextMode, string>> = {
  prepare: { gaming: 'Pre-game', work: 'Pre-work', life: 'Prepare' },
  debrief: { gaming: 'Post-game', work: 'Post-work', life: 'Debrief' },
  reset: { gaming: 'Reset', work: 'Stress Reset', life: 'Grounding' },
  vent: { gaming: 'Vent', work: 'Unload', life: 'Let it out' },
  open: { gaming: 'Chat', work: 'Chat', life: 'Chat' },
  chat: { gaming: 'Chat', work: 'Chat', life: 'Chat' },
};

const CONTEXT_COLORS: Record<ContextMode, string> = {
  gaming: 'text-emerald-500',
  work: 'text-blue-500',
  life: 'text-pink-500',
};

// =============================================================================
// SESSION HISTORY CARD
// =============================================================================

interface SessionCardProps {
  session: SessionHistoryEntry;
  onClick: () => void;
}

function SessionCard({ session, onClick }: SessionCardProps) {
  const Icon = PRESET_ICONS[session.presetType];
  const label = PRESET_LABELS[session.presetType][session.contextMode];
  const timeAgo = humanizeTime(session.endedAt);
  
  return (
    <button
      onClick={() => {
        haptic('light');
        onClick();
      }}
      className={cn(
        'flex-shrink-0 w-[160px] p-3 rounded-xl text-left transition-all duration-200',
        'bg-sophia-surface border border-sophia-surface-border',
        'hover:border-sophia-purple/30 hover:shadow-md',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple'
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <div className={cn(
          'w-7 h-7 rounded-lg flex items-center justify-center',
          'bg-sophia-purple/10'
        )}>
          <Icon className="w-4 h-4 text-sophia-purple" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-sophia-text truncate">{label}</p>
          <p className={cn('text-[10px] capitalize', CONTEXT_COLORS[session.contextMode])}>
            {session.contextMode}
          </p>
        </div>
      </div>
      
      {/* Takeaway preview */}
      {session.takeawayPreview && (
        <p className="text-xs text-sophia-text2 line-clamp-2 mb-2 leading-relaxed">
          {session.takeawayPreview}
        </p>
      )}
      
      {/* Footer */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-sophia-text2/60" title={timeAgo.tooltip}>
          <Clock className="w-3 h-3" />
          <span className="text-[10px]">{timeAgo.text}</span>
        </div>
        
        {/* Status indicators */}
        <div className="flex items-center gap-1">
          {!session.recapViewed && (
            <span className="px-1.5 py-0.5 text-[9px] font-medium bg-sophia-purple/10 text-sophia-purple rounded">
              New
            </span>
          )}
          {session.memoriesApproved && (
            <Brain className="w-3 h-3 text-green-500" />
          )}
        </div>
      </div>
    </button>
  );
}

// =============================================================================
// EMPTY STATE
// =============================================================================

function EmptyState() {
  return (
    <div className="flex items-center gap-3 p-4 rounded-xl bg-sophia-surface/50 border border-dashed border-sophia-surface-border">
      <Sparkles className="w-5 h-5 text-sophia-text2/50" />
      <div>
        <p className="text-sm text-sophia-text2">No sessions yet</p>
        <p className="text-xs text-sophia-text2/60">Start talking to build your history</p>
      </div>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

interface SessionHistoryProps {
  className?: string;
  maxItems?: number;
}

export function SessionHistory({ className, maxItems = 5 }: SessionHistoryProps) {
  const router = useRouter();
  const sessions = useSessionHistoryStore((state) => state.sessions);
  const loadConversationAction = useConversationStore((state) => state.loadConversation);
  const showToast = useUiStore((state) => state.showToast);
  
  const recentSessions = useMemo(() => {
    return sessions.slice(0, maxItems);
  }, [sessions, maxItems]);
  
  const handleSessionClick = async (sessionId: string) => {
    const success = await loadConversationAction(sessionId, 'backend');
    if (success) {
      router.push('/session');
    } else {
      showToast({ message: "Couldn't open that session.", variant: 'warning', durationMs: 3200 });
    }
  };
  
  const handleViewAll = () => {
    haptic('light');
    router.push('/history');
  };
  
  if (recentSessions.length === 0) {
    return (
      <div className={className}>
        <EmptyState />
      </div>
    );
  }
  
  return (
    <div className={className}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-sophia-text2">Recent Sessions</h2>
        {sessions.length > maxItems && (
          <button
            onClick={handleViewAll}
            className="flex items-center gap-1 text-xs text-sophia-purple hover:text-sophia-purple/80 transition-colors"
          >
            View all
            <ChevronRight className="w-3 h-3" />
          </button>
        )}
      </div>
      
      {/* Horizontal scroll container */}
      <div className="relative -mx-4 px-4">
        <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
          {recentSessions.map((session) => (
            <SessionCard
              key={session.sessionId}
              session={session}
              onClick={() => handleSessionClick(session.sessionId)}
            />
          ))}
        </div>
        
        {/* Fade edge indicator */}
        {recentSessions.length > 2 && (
          <div className="absolute right-0 top-0 bottom-2 w-8 bg-gradient-to-l from-sophia-bg to-transparent pointer-events-none" />
        )}
      </div>
    </div>
  );
}

export default SessionHistory;
