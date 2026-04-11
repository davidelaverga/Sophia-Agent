/**
 * Dashboard Components
 * Barrel file for dashboard subcomponents
 */

export { PresenceIndicator } from './PresenceIndicator';
export { RitualCard } from './RitualCard';
export { MicCTA } from './MicCTA';
export { ContextTabs } from './ContextTabs';
export { RITUALS, CONTEXTS, PRESENCE_STATES } from './types';
export type { MicState, RitualConfig, ContextConfig } from './types';

// Sidebar components for 3-column layout
export {
  RecentSessionsSidebar,
  ConversationHistorySidebar,
  MobileBottomSheet,
  MobileSessionsContent,
} from './DashboardSidebar';
