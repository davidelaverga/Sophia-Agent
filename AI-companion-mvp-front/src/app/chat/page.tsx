/**
 * Free Chat Page
 * Sprint 1 - Week 1
 * 
 * Supported ritual-less chat mode at /chat
 * For users who want free-form chat without ritual session structure
 * 
 * Auth flow: Discord Login → Consent Gate → Chat (protected)
 */

import { ConversationView } from "../components/ConversationView";
import { ProtectedRoute } from "../components/ProtectedRoute";

export default function ChatPage() {
  return (
    <ProtectedRoute>
      <ConversationView />
    </ProtectedRoute>
  );
}
