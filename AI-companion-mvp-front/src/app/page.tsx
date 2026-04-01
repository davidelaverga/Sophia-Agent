/**
 * Home Page - Sophia V2 Dashboard
 * Sprint 1 - Voice-First Redesign
 * 
 * Voice is the hero action, rituals are optional modes
 * Auth flow: Discord Login → Consent Gate → Dashboard
 */

import { VoiceFirstDashboard } from './components/VoiceFirstDashboard';
import { ProtectedRoute } from './components/ProtectedRoute';

export default function HomePage() {
  return (
    <ProtectedRoute>
      <VoiceFirstDashboard />
    </ProtectedRoute>
  );
}
