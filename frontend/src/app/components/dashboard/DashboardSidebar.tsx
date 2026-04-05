/**
 * Dashboard Sidebar Components
 * Phase 4 Week 4 - Subphase 3
 * 
 * Collapsible sidebars for desktop/tablet with mobile floating buttons.
 * Left: Recent Sessions
 * Right: Conversation History
 */

'use client';

import { useState, useCallback, lazy, Suspense } from 'react';
import { 
  Clock, 
  ChevronLeft, 
  ChevronRight, 
  X,
  MessageCircle,
  Target,
  RefreshCw,
  Wind,
  Sparkles,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';
import { useSessionHistoryStore, type SessionHistoryEntry } from '../../stores/session-history-store';
import { useConversationStore } from '../../stores/conversation-store';
import { humanizeTime } from '../../lib/humanize-time';
import type { PresetType, ContextMode } from '../../lib/session-types';

// Lazy load HistoryDrawer
const HistoryDrawer = lazy(() => 
  import('../HistoryDrawer').then(mod => ({ default: mod.HistoryDrawer }))
);

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

const PRESET_LABELS: Record<PresetType, string> = {
  prepare: 'Pre-game',
  debrief: 'Debrief',
  reset: 'Reset',
  vent: 'Vent',
  open: 'Chat',
  chat: 'Chat',
};

const CONTEXT_COLORS: Record<ContextMode, string> = {
  gaming: 'text-emerald-500',
  work: 'text-blue-500',
  life: 'text-pink-500',
};

// =============================================================================
// SESSION CARD (for Recent Sessions sidebar)
// =============================================================================

interface SessionCardProps {
  session: SessionHistoryEntry;
  onClick: () => void;
  compact?: boolean;
}

function SessionCard({ session, onClick, compact = false }: SessionCardProps) {
  const Icon = PRESET_ICONS[session.presetType];
  const label = PRESET_LABELS[session.presetType];
  const timeAgo = humanizeTime(session.endedAt);
  const paddingClass = compact ? 'px-2 py-1.5' : 'px-2.5 py-2';
  
  return (
    <button
      onClick={() => {
        haptic('light');
        onClick();
      }}
      className={cn(
        'w-full rounded-xl text-left transition-all duration-150 group',
        'hover:bg-sophia-bg/60',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple focus-visible:ring-inset',
        paddingClass,
        !session.recapViewed && 'bg-sophia-purple/5'
      )}
    >
      <div className="flex items-center gap-2">
        {/* Icon */}
        <div className={cn(
          'w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors',
          !session.recapViewed 
            ? 'bg-sophia-purple/15' 
            : 'bg-sophia-surface-border/40 group-hover:bg-sophia-purple/10'
        )}>
          <Icon className={cn(
            'w-3.5 h-3.5 transition-colors',
            !session.recapViewed ? 'text-sophia-purple' : 'text-sophia-text2/70 group-hover:text-sophia-purple'
          )} />
        </div>
        
        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <span className="text-[13px] font-medium text-sophia-text truncate">
              {label}
            </span>
            <span className={cn('text-[10px] shrink-0 capitalize', CONTEXT_COLORS[session.contextMode])}>
              {session.contextMode}
            </span>
          </div>
          
          {/* Meta row: time + preview */}
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[10px] text-sophia-text2/50" title={timeAgo.tooltip}>
              {timeAgo.text}
            </span>
            {session.takeawayPreview && (
              <>
                <span className="text-sophia-text2/30">·</span>
                <span className="text-[10px] text-sophia-text2/60 truncate">
                  {session.takeawayPreview.slice(0, 30)}{session.takeawayPreview.length > 30 ? '…' : ''}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

// =============================================================================
// LEFT SIDEBAR: Recent Sessions
// =============================================================================

interface RecentSessionsSidebarProps {
  isExpanded: boolean;
  onToggle: () => void;
  className?: string;
}

export function RecentSessionsSidebar({ 
  isExpanded, 
  onToggle,
  className 
}: RecentSessionsSidebarProps) {
  const router = useRouter();
  const sessions = useSessionHistoryStore((state) => state.sessions);
  const recentSessions = sessions.slice(0, 4); // Show max 4 for density
  
  // Calculate unviewed count
  const unviewedCount = sessions.filter(s => !s.recapViewed).length;
  
  const handleSessionClick = (sessionId: string) => {
    router.push(`/recap/${sessionId}`);
  };
  
  return (
    <div className={cn(
      'hidden lg:flex flex-col transition-all duration-300 ease-out',
      isExpanded ? 'w-[260px]' : 'w-14',
      className
    )}>
      {/* Toggle button */}
      <button
        onClick={() => {
          haptic('light');
          onToggle();
        }}
        className={cn(
          'relative flex items-center justify-center w-10 h-10 rounded-xl mb-4',
          'bg-sophia-surface border border-sophia-surface-border',
          'hover:border-sophia-purple/30 hover:scale-105',
          'transition-all duration-200 shadow-soft',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
          !isExpanded && 'self-center'
        )}
        aria-label={isExpanded ? 'Collapse sessions' : 'Expand sessions'}
      >
        {isExpanded ? (
          <ChevronLeft className="w-4 h-4 text-sophia-text2" />
        ) : (
          <Clock className="w-4 h-4 text-sophia-text2" />
        )}
        {/* Notification dot for unviewed sessions */}
        {!isExpanded && unviewedCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-sophia-purple text-[9px] font-semibold text-white flex items-center justify-center">
            {unviewedCount > 9 ? '9+' : unviewedCount}
          </span>
        )}
      </button>
      
      {/* Content */}
      {isExpanded && (
        <div className={cn(
          'flex-1 rounded-2xl overflow-hidden',
          'bg-sophia-surface/50 backdrop-blur-sm',
          'border border-sophia-surface-border',
          'shadow-soft'
        )}>
          {/* Header */}
          <div className="px-3 pt-3 pb-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-sophia-text">
                Recent Sessions
              </h3>
              {unviewedCount > 0 && (
                <span className="text-[10px] text-sophia-purple bg-sophia-purple/10 px-1.5 py-0.5 rounded-full font-medium">
                  {unviewedCount} new
                </span>
              )}
            </div>
          </div>
          
          {/* Sessions list */}
          <div className="px-2 pb-2">
            {recentSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center px-4">
                <div className="w-10 h-10 rounded-xl bg-sophia-purple/5 flex items-center justify-center mb-2">
                  <Sparkles className="w-5 h-5 text-sophia-text2/30" />
                </div>
                <p className="text-[13px] font-medium text-sophia-text2">No sessions yet</p>
                <p className="text-[11px] text-sophia-text2/50 mt-0.5">
                  Your history will appear here
                </p>
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  {recentSessions.map((session) => (
                    <SessionCard
                      key={session.sessionId}
                      session={session}
                      onClick={() => handleSessionClick(session.sessionId)}
                      compact={true}
                    />
                  ))}
                </div>
                
                {/* View All link */}
                {sessions.length > 4 && (
                  <button
                    onClick={() => {
                      haptic('light');
                      // TODO: Navigate to full history
                    }}
                    className={cn(
                      'w-full mt-2 py-2 text-[12px] font-medium',
                      'text-sophia-purple hover:text-sophia-purple/80',
                      'transition-colors',
                      'focus:outline-none focus-visible:underline'
                    )}
                  >
                    View all {sessions.length} sessions
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// RIGHT SIDEBAR: Conversation History
// =============================================================================

interface ConversationHistorySidebarProps {
  isExpanded: boolean;
  onToggle: () => void;
  className?: string;
}

export function ConversationHistorySidebar({ 
  isExpanded, 
  onToggle,
  className 
}: ConversationHistorySidebarProps) {
  const router = useRouter();
  const [showFullDrawer, setShowFullDrawer] = useState(false);
  const conversations = useConversationStore((state) => state.conversations);
  const refreshConversations = useConversationStore((state) => state.refreshConversations);
  const sessions = useSessionHistoryStore((state) => state.sessions);
  
  // Get latest session with takeaway for "Last Insight"
  const lastInsightSession = sessions.find(s => s.takeawayPreview);
  
  // Handle conversation loaded - navigate to session
  const handleConversationLoaded = useCallback(() => {
    setShowFullDrawer(false);
    router.push('/session');
  }, [router]);
  
  // Refresh on expand
  const handleToggle = useCallback(() => {
    if (!isExpanded) {
      refreshConversations();
    }
    onToggle();
  }, [isExpanded, onToggle, refreshConversations]);
  
  return (
    <>
      <div className={cn(
        'hidden lg:flex flex-col transition-all duration-300 ease-out',
        isExpanded ? 'w-[260px]' : 'w-14',
        className
      )}>
        {/* Toggle button */}
        <button
          onClick={() => {
            haptic('light');
            handleToggle();
          }}
          className={cn(
            'flex items-center justify-center w-10 h-10 rounded-xl mb-4',
            'bg-sophia-surface border border-sophia-surface-border',
            'hover:border-sophia-purple/30 hover:scale-105',
            'transition-all duration-200 shadow-soft',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple',
            !isExpanded && 'self-center'
          )}
          aria-label={isExpanded ? 'Collapse insight' : 'Expand insight'}
        >
          {isExpanded ? (
            <ChevronRight className="w-4 h-4 text-sophia-text2" />
          ) : (
            <Sparkles className="w-4 h-4 text-sophia-text2" />
          )}
        </button>
        
        {/* Content */}
        {isExpanded && (
          <div className={cn(
            'flex-1 rounded-2xl overflow-hidden',
            'bg-sophia-surface/50 backdrop-blur-sm',
            'border border-sophia-surface-border',
            'shadow-soft'
          )}>
            {/* Header */}
            <div className="px-3 pt-3 pb-2">
              <h3 className="text-[13px] font-semibold text-sophia-text">
                Last Insight
              </h3>
              <p className="text-[10px] text-sophia-text2/50 mt-0.5">
                Your most recent takeaway
              </p>
            </div>
            
            {/* Insight content */}
            <div className="px-3 pb-3">
              {!lastInsightSession ? (
                <div className="flex flex-col items-center justify-center py-8 text-center px-2">
                  <div className="w-10 h-10 rounded-xl bg-sophia-purple/5 flex items-center justify-center mb-2">
                    <Sparkles className="w-5 h-5 text-sophia-text2/30" />
                  </div>
                  <p className="text-[13px] font-medium text-sophia-text2">No insights yet</p>
                  <p className="text-[11px] text-sophia-text2/50 mt-0.5">
                    Complete a session to see your takeaway here
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Insight card - hero snippet style */}
                  <div className={cn(
                    'relative p-3 rounded-xl',
                    'bg-sophia-purple/5',
                    'border border-sophia-purple/10'
                  )}>
                    {/* Quote styling */}
                    <div className="absolute top-2 left-2 text-2xl text-sophia-purple/20 font-serif leading-none select-none">&ldquo;</div>
                    
                    {/* Insight text */}
                    <p className="text-[13px] text-sophia-text leading-relaxed pl-4 pr-1 line-clamp-4">
                      {lastInsightSession.takeawayPreview}
                    </p>
                    
                    {/* Session meta */}
                    <div className="mt-2 pt-2 border-t border-sophia-purple/10 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        {(() => {
                          const Icon = PRESET_ICONS[lastInsightSession.presetType];
                          return <Icon className="w-3 h-3 text-sophia-purple/50" />;
                        })()}
                        <span className="text-[10px] text-sophia-text2/70">
                          {PRESET_LABELS[lastInsightSession.presetType]}
                        </span>
                      </div>
                      <span className="text-[10px] text-sophia-text2/50">
                        {humanizeTime(lastInsightSession.endedAt).text}
                      </span>
                    </div>
                  </div>
                  
                  {/* View history button */}
                  {conversations.length > 0 && (
                    <button
                      onClick={() => {
                        haptic('light');
                        setShowFullDrawer(true);
                      }}
                      className={cn(
                        'w-full py-2 text-[12px] font-medium',
                        'text-sophia-text2 hover:text-sophia-purple',
                        'transition-colors',
                        'focus:outline-none focus-visible:underline'
                      )}
                    >
                      View conversation history
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      
      {/* Full History Drawer */}
      {showFullDrawer && (
        <Suspense fallback={null}>
          <HistoryDrawer
            isOpen={showFullDrawer}
            onClose={() => setShowFullDrawer(false)}
            onConversationLoaded={handleConversationLoaded}
          />
        </Suspense>
      )}
    </>
  );
}

// =============================================================================
// MOBILE FLOATING BUTTONS
// =============================================================================

interface MobileFloatingButtonsProps {
  onOpenHistory: () => void;
}

export function MobileFloatingButtons({ 
  onOpenHistory 
}: MobileFloatingButtonsProps) {
  const sessions = useSessionHistoryStore((state) => state.sessions);
  const unviewedCount = sessions.filter(s => !s.recapViewed).length;
  
  return (
    <>
      {/* Mobile: History */}
      <button
        onClick={() => {
          haptic('light');
          onOpenHistory();
        }}
        className={cn(
          'lg:hidden fixed right-3 top-1/2 -translate-y-1/2 z-30',
          'w-10 h-10 rounded-full',
          'bg-sophia-surface backdrop-blur-sm',
          'border border-sophia-surface-border shadow-soft',
          'flex items-center justify-center',
          'hover:border-sophia-purple/30 hover:scale-105',
          'active:scale-95',
          'transition-all duration-150',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple'
        )}
        aria-label="History"
      >
        <Clock className="w-4 h-4 text-sophia-text2" />
        {unviewedCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-sophia-purple text-[8px] font-semibold text-white flex items-center justify-center">
            {unviewedCount > 9 ? '9+' : unviewedCount}
          </span>
        )}
      </button>
    </>
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

export function MobileBottomSheet({ 
  isOpen, 
  onClose, 
  title, 
  icon,
  children 
}: MobileBottomSheetProps) {
  if (!isOpen) return null;
  
  return (
    <div className="lg:hidden fixed inset-0 z-50">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Sheet */}
      <div className={cn(
        'absolute bottom-0 left-0 right-0',
        'bg-sophia-surface rounded-t-3xl',
        'border-t border-sophia-surface-border',
        'max-h-[70vh] overflow-hidden',
        'animate-in slide-in-from-bottom duration-300'
      )}>
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 rounded-full bg-sophia-text2/20" />
        </div>
        
        {/* Header */}
        <div className="flex items-center justify-between px-5 pb-4">
          <div className="flex items-center gap-2">
            {icon}
            <h3 className="text-lg font-semibold text-sophia-text">{title}</h3>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-sophia-button transition-colors"
          >
            <X className="w-5 h-5 text-sophia-text2" />
          </button>
        </div>
        
        {/* Content */}
        <div className="px-5 pb-8 overflow-y-auto max-h-[calc(70vh-100px)]">
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
  const sessions = useSessionHistoryStore((state) => state.sessions);
  const recentSessions = sessions.slice(0, 10);
  
  if (recentSessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Sparkles className="w-12 h-12 text-sophia-text2/30 mb-3" />
        <p className="text-sophia-text2">No sessions yet</p>
        <p className="text-sm text-sophia-text2/60 mt-1">
          Start talking to build your history
        </p>
      </div>
    );
  }
  
  return (
    <div className="space-y-3">
      {recentSessions.map((session) => (
        <SessionCard
          key={session.sessionId}
          session={session}
          onClick={() => router.push(`/recap/${session.sessionId}`)}
        />
      ))}
    </div>
  );
}
