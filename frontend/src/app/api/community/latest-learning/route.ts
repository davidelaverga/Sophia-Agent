/**
 * Community Latest Learning Route - V4 Backend Adaptation
 * ========================================================
 * 
 * Note: The V4 backend does not have a /api/community/latest-learning endpoint.
 * This route returns curated default content with graceful fallback.
 * 
 * Design Decision:
 * - Returns inspirational content that fits Sophia's personality
 * - Rotates through different insights to feel dynamic
 * - Fails silently with reasonable defaults
 */

import { type NextRequest, NextResponse } from "next/server"

import { getServerAuthToken } from "../../../lib/auth/server-auth"

// Curated fallback learnings that reflect Sophia's growth
const FALLBACK_LEARNINGS = [
  {
    title: "Today Sophia learned",
    insight: "That listening without judgment creates the safest space for healing.",
    sophia_emotion: { label: "compassionate", confidence: 0.92 },
  },
  {
    title: "Today Sophia learned",
    insight: "The power of small moments of connection in our daily lives.",
    sophia_emotion: { label: "curious", confidence: 0.88 },
  },
  {
    title: "Today Sophia learned",
    insight: "That vulnerability is not weakness—it's the birthplace of courage.",
    sophia_emotion: { label: "warm", confidence: 0.90 },
  },
  {
    title: "Today Sophia learned",
    insight: "How a simple pause can transform a conversation into understanding.",
    sophia_emotion: { label: "thoughtful", confidence: 0.85 },
  },
  {
    title: "Today Sophia learned",
    insight: "That every person carries stories worth hearing.",
    sophia_emotion: { label: "empathetic", confidence: 0.91 },
  },
];

function getDailyLearning() {
  // Use date to consistently show same learning for entire day
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) /
      (1000 * 60 * 60 * 24)
  );
  const index = dayOfYear % FALLBACK_LEARNINGS.length;
  return {
    ...FALLBACK_LEARNINGS[index],
    reflection_id: null,
    source: "curated",
  };
}

export async function GET(_request: NextRequest) {
  const backendUrl = process.env.BACKEND_API_URL;
  const apiKey = await getServerAuthToken();

  // If no backend configured, return daily curated content
  if (!backendUrl) {
    return NextResponse.json(getDailyLearning());
  }

  try {
    const response = await fetch(
      `${backendUrl}/api/community/latest-learning`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        // Short timeout - don't block UI for optional content
        signal: AbortSignal.timeout(2000),
        cache: "no-store",
      }
    );

    if (!response.ok) {
      // Endpoint not available - return curated fallback
      return NextResponse.json(getDailyLearning());
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch {
    // Network error or timeout - return curated fallback
    return NextResponse.json(getDailyLearning());
  }
}
