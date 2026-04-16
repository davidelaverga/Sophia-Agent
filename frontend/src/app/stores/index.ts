/**
 * Stores Index
 * =============
 * 
 * Barrel file for centralized store imports.
 * 
 * @example
 * import { useSessionStore, useChatStore, useVoiceStore } from '../stores'
 */

// =============================================================================
// PRIMARY STORES (use these)
// =============================================================================

// Session management
export { useSessionStore } from './session-store'
export { selectOpenSessions, selectRecentSessions, selectOpenSessionCount, selectIsLoadingSessions } from './session-store'
export { useSessionHistoryStore } from './session-history-store'
export { 
  useConversationStore,
  selectConversations,
  selectIsListLoading,
  selectHasMore,
  selectIsLoadingConversation,
  selectLastRecapSessionId,
  type ConversationListItem,
  type ConversationSource,
  type ListLoadingState,
  type ConversationLoadingState,
} from './conversation-store'

// Chat & messaging
export { useChatStore, type ChatMessage } from './chat-store'
export { useMessageMetadataStore } from './message-metadata-store'

// Voice
export { useVoiceStore, type VoiceMessage } from './voice-store'

// UI state
export { useUiStore, type FocusMode, type UiToastVariant, type UiToastState } from './ui-store'

// Presence & connectivity
export { usePresenceStore, type PresenceState } from './presence-store'
export { useConnectivityStore, selectStatus, selectIsOnline, type ConnectivityStatus } from './connectivity-store'

// Auth & onboarding
export { useAuthTokenStore } from './auth-token-store'
export { useOnboardingStore } from './onboarding-store'

// Features
export { useRecapStore } from './recap-store'
export { useConsentStore } from './consent-store'
export { useFeedbackStore } from './feedback-store'
export { useUsageLimitStore } from './usage-limit-store'
export { useLocaleStore } from './locale-store'

// =============================================================================
// DEPRECATED ALIASES (for backward compatibility)
// =============================================================================

/** @deprecated Session persistence now unified in session-store */
export { 
  useSessionSnapshotStore,
  selectSnapshot,
  selectCanResume,
  selectHasAttemptedRestore,
  setupBeforeUnloadPersistence,
} from './session-snapshot-store'

