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

import { ConversationView } from "../components/ConversationView";
import { ProtectedRoute } from "../components/ProtectedRoute";

import { useChatRouteExperience } from "./useChatRouteExperience";

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
