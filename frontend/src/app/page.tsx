/**
 * Home Page - Sophia V2 Dashboard
 * Sprint 1 - Voice-First Redesign
 * 
 * Voice is the hero action, rituals are optional modes
 * Auth flow: Discord Login → Consent Gate → Dashboard
 */

import { EnhancedFieldDashboard } from './components/EnhancedFieldDashboard';
import { ProtectedRoute } from './components/ProtectedRoute';

export default function HomePage() {
  return (
    <ProtectedRoute>
      <EnhancedFieldDashboard />
    </ProtectedRoute>
  );
}
