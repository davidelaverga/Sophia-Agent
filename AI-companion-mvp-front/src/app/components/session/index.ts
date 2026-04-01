/**
 * Session Components Index
 * Sprint 1+ - Enhanced with Feedback UI and Emotional Weather
 * 
 * Exports all session-related components for clean imports.
 */

// Core session components
export { ArtifactsPanel, ArtifactsRail } from './ArtifactsPanel';
export { SessionEmptyState } from './SessionEmptyState';
export { SessionConversationPane } from './SessionConversationPane';
export { InterruptCard } from './InterruptCard';
export type { InterruptCardProps } from './InterruptCard';

// UI components
export { TypingIndicator } from './TypingIndicator';
export { MessageBubble, type UIMessage } from './MessageBubble';
export { ReflectionPromptBubble, ReflectionResponseBubble } from './ReflectionBubble';
export { MessageFeedback, FeedbackToast } from './MessageFeedback';
export { VoiceFirstComposer, type VoiceStatus } from './VoiceFirstComposer';
export { MobileDrawer, type ArtifactStatusType } from './MobileDrawer';
export { SophiaEyes } from './SophiaEyes';

// Sprint 1+ components
export { 
  EmotionalWeather,
  TrendIcon, 
  WeatherBadge, 
  WeatherCard, 
  MiniWeather 
} from './EmotionalWeather';
export { MemoryHighlights, CompactMemoryHighlight } from './MemoryHighlights';
export { SessionMemoryHighlights, CompactSessionMemoryHighlight } from './SessionMemoryHighlights';
export { ResumeBanner } from './ResumeBanner';
export { SessionFeedback, InlineSessionFeedback, type SessionFeedbackData } from './SessionFeedback';
export { EmotionBadge } from './EmotionBadge';

// Bootstrap components (Sprint 1+)
// BootstrapCards archived - see _archived_BootstrapCards.tsx
export { 
  BootstrapGreeting, 
  BootstrapGreetingSkeleton, 
  BootstrapEmptyState 
} from './BootstrapGreeting';
export { 
  MemoryHighlightCard, 
  MemoryHighlightCards, 
  CompactMemoryCard 
} from './MemoryHighlightCard';

// Companion components (Phase 3)
export { CompanionButtons, CompanionButtonsCompact, CompanionRail } from './CompanionButtons';
export { NudgeBanner, NudgeQueue, MiniNudge, type NudgeSuggestion } from './NudgeBanner';
export { DebriefOfferModal } from './DebriefOfferModal';
