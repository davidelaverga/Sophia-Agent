/**
 * Reflections Prompt Route - V4 Backend Adaptation
 * ================================================
 * 
 * Note: The V4 backend does not have a /api/reflections/run endpoint.
 * This route uses client-side processing to generate reflection prompts
 * from the conversation context.
 * 
 * Future Enhancement:
 * Once V4 backend adds reflection endpoints, this can be updated to
 * call the backend for more sophisticated analysis.
 */

import { type NextRequest, NextResponse } from "next/server";

/**
 * Generic reflection prompts for when no context is available.
 * These are designed to encourage meaningful self-reflection.
 */
const GENERIC_REFLECTION_PROMPTS = [
  {
    text: "What's one thing you're grateful for right now?",
    reason: "reflection",
  },
  {
    text: "How are you really feeling in this moment?",
    reason: "empathy",
  },
  {
    text: "What small step could you take today towards your goals?",
    reason: "growth",
  },
  {
    text: "Is there something you've been putting off that deserves attention?",
    reason: "guidance",
  },
  {
    text: "What would you tell a friend who was feeling the way you do?",
    reason: "self-care",
  },
];

export async function POST(request: NextRequest) {
  let body: { conversation_id: string; user_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!body.conversation_id) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  // V4 Backend doesn't have reflections endpoint yet
  // Return generic prompts with graceful degradation
  
  // Select a random subset of prompts
  const shuffled = [...GENERIC_REFLECTION_PROMPTS].sort(() => Math.random() - 0.5);
  const selectedPrompts = shuffled.slice(0, 2);

  const chunks = selectedPrompts.map((prompt, idx) => ({
    id: `reflection-${body.conversation_id}-${idx}`,
    text: prompt.text,
    ts: Date.now() - idx * 1000,
    reason: prompt.reason,
  }));

  return NextResponse.json({
    allow: true,
    chunks,
    reflection_id: `local-${body.conversation_id}`,
    source: "client-generated", // Indicates this came from frontend, not backend
  });
}

