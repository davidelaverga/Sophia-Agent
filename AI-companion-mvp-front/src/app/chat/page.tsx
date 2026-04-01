"use client"

/**
 * Free Chat Page
 * Sprint 1 - Week 1
 * 
 * Supported ritual-less chat mode at /chat
 * For users who want free-form chat without ritual session structure
 * 
 * Auth flow: Discord Login → Consent Gate → Chat (protected)
 */

import { useChatRouteExperience } from "./useChatRouteExperience";
import { ConversationView } from "../components/ConversationView";
import { ProtectedRoute } from "../components/ProtectedRoute";

function ChatRouteShell() {
  const routeExperience = useChatRouteExperience();

  return <ConversationView routeExperience={routeExperience} />;
}

export default function ChatPage() {
  return (
    <ProtectedRoute>
      <ChatRouteShell />
    </ProtectedRoute>
  );
}
