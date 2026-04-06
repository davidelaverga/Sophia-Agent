/**
 * Session Bootstrap API Route
 * Sprint 1+ - Instant Personalized Openers
 * 
 * Returns pre-computed bootstrap data for session start:
 * - Opening message (personalized, no LLM call needed)
 * - Thread ID for LangGraph resume
 * - Top memories for "Since last time" display
 * - Emotional weather indicator
 * - Suggested ritual (if any)
 * 
 * In production: Proxies to backend GET /session/bootstrap
 * In dev/mock: Returns contextual mock data
 */

import { type NextRequest, NextResponse } from 'next/server';

import { getServerAuthToken } from '../../../lib/auth/server-auth';
import { debugLog, debugWarn } from '../../../lib/debug-logger';
import { logger } from '../../../lib/error-logger';
import type { BootstrapResponse, EmotionalTrend, UICard } from '../../../types/sophia-ui-message';

// ============================================================================
// CONFIGURATION
// ============================================================================

const BACKEND_URL = process.env.RENDER_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || '';
const USE_MOCK = !BACKEND_URL || process.env.USE_MOCK_BOOTSTRAP === 'true';

// ============================================================================
// MOCK DATA GENERATORS
// ============================================================================

function getTimeOfDay(): 'morning' | 'afternoon' | 'evening' | 'night' {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

function getMockOpeningMessage(
  sessionType?: string,
  contextMode?: string,
  timeOfDay?: string
): { message: string; tone: 'warm' | 'energizing' | 'grounding' | 'supportive' } {
  const time = timeOfDay || getTimeOfDay();
  
  const openers: Record<string, Record<string, { message: string; tone: 'warm' | 'energizing' | 'grounding' | 'supportive' }>> = {
    prepare: {
      gaming: {
        message: time === 'night' 
          ? "Late night session? Let's make sure you're mentally locked in."
          : "Ready to prep for your games. What's the plan today?",
        tone: 'energizing',
      },
      work: {
        message: time === 'morning'
          ? "Good morning. Let's set your intention for the day ahead."
          : "Taking a moment to prepare. What do you want to focus on?",
        tone: 'grounding',
      },
      life: {
        message: "Hey. What's coming up that you want to feel ready for?",
        tone: 'warm',
      },
    },
    debrief: {
      gaming: {
        message: "How did your session go? I'm here to help you process.",
        tone: 'supportive',
      },
      work: {
        message: "Let's reflect on how things went. What stood out today?",
        tone: 'warm',
      },
      life: {
        message: "I'm here to help you make sense of what happened.",
        tone: 'supportive',
      },
    },
    reset: {
      gaming: {
        message: "I can tell something's up. Let's work through it together.",
        tone: 'grounding',
      },
      work: {
        message: "Feeling overwhelmed? Let's take a moment to reset.",
        tone: 'grounding',
      },
      life: {
        message: "Take a breath. I'm here. What's going on?",
        tone: 'supportive',
      },
    },
    vent: {
      gaming: {
        message: "Let it out. No judgment here. What happened?",
        tone: 'supportive',
      },
      work: {
        message: "I'm listening. Tell me what's on your mind.",
        tone: 'supportive',
      },
      life: {
        message: "This is your space. Say whatever you need to say.",
        tone: 'supportive',
      },
    },
  };
  
  const sessionOpeners = openers[sessionType || 'prepare'] || openers.prepare;
  const contextOpener = sessionOpeners[contextMode || 'gaming'] || sessionOpeners.gaming;
  
  return contextOpener;
}

function getMockEmotionalWeather(sessionType?: string): {
  trend: EmotionalTrend;
  label: string;
  tags: string[];
} {
  // In production, this comes from backend analysis
  // For mock, return reasonable defaults based on session type
  const weatherByType: Record<string, { trend: EmotionalTrend; label: string; tags: string[] }> = {
    prepare: { trend: 'stable', label: 'Focused', tags: ['focused', 'ready'] },
    debrief: { trend: 'unknown', label: 'Processing', tags: ['reflective'] },
    reset: { trend: 'declining', label: 'Stressed', tags: ['tense', 'needs-reset'] },
    vent: { trend: 'declining', label: 'Frustrated', tags: ['venting', 'release'] },
  };
  
  return weatherByType[sessionType || 'prepare'] || weatherByType.prepare;
}

function getMockUICards(sessionType?: string, contextMode?: string): UICard[] {
  const cards: UICard[] = [];
  
  // Welcome card (always)
  cards.push({
    type: 'welcome',
    content: getMockOpeningMessage(sessionType, contextMode).message,
  });
  
  // Emotional weather card (if relevant)
  const weather = getMockEmotionalWeather(sessionType);
  if (weather.trend !== 'unknown') {
    cards.push({
      type: 'emotional_weather',
      trend: weather.trend,
      label: weather.label,
    });
  }
  
  return cards;
}

function generateMockBootstrap(
  userId: string,
  sessionType?: string,
  contextMode?: string
): BootstrapResponse {
  const timeOfDay = getTimeOfDay();
  const opener = getMockOpeningMessage(sessionType, contextMode, timeOfDay);
  const weather = getMockEmotionalWeather(sessionType);
  
  return {
    user_id: userId,
    thread_id: `thread_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    opening_message: opener.message,
    opening_tone: opener.tone,
    top_memories: [], // Empty for mock - backend populates this
    suggested_ritual: null,
    suggested_preset: null,
    suggestion_reason: null,
    emotional_weather: {
      trend: weather.trend,
      label: weather.label,
    },
    ui_cards: getMockUICards(sessionType, contextMode),
    computed_at: new Date().toISOString(),
    cache_hit: false,
  };
}

// ============================================================================
// ROUTE HANDLER
// ============================================================================

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const userId = searchParams.get('user_id');
  const sessionType = searchParams.get('session_type') || undefined;
  const contextMode = searchParams.get('context_mode') || undefined;
  
  if (!userId) {
    return NextResponse.json(
      { error: 'user_id is required' },
      { status: 400 }
    );
  }
  
  // ========================================================================
  // MOCK MODE
  // ========================================================================
  if (USE_MOCK) {
    debugLog('api/session/bootstrap', 'Using mock bootstrap');
    const mockBootstrap = generateMockBootstrap(userId, sessionType, contextMode);
    
    return NextResponse.json(mockBootstrap, {
      headers: {
        'Cache-Control': 'no-store',
        'X-Mock-Response': 'true',
      },
    });
  }
  
  // ========================================================================
  // PRODUCTION MODE - Proxy to backend
  // ========================================================================
  try {
    const backendUrl = new URL('/api/v1/session/bootstrap', BACKEND_URL);
    backendUrl.searchParams.set('user_id', userId);
    if (sessionType) backendUrl.searchParams.set('session_type', sessionType);
    if (contextMode) backendUrl.searchParams.set('context_mode', contextMode);
    
    const response = await fetch(backendUrl.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        // Use per-user token from cookie, fallback to env token
        'Authorization': `Bearer ${await getServerAuthToken()}`,
      },
    });
    
    if (!response.ok) {
      debugWarn('api/session/bootstrap', 'Backend error, using mock fallback');
      const mockBootstrap = generateMockBootstrap(userId, sessionType, contextMode);
      return NextResponse.json(mockBootstrap);
    }
    
    const data = await response.json();
    return NextResponse.json(data);
    
  } catch (error) {
    logger.logError(error, { component: 'api/session/bootstrap', action: 'fetch_bootstrap' });
    // Fallback to mock on error
    const mockBootstrap = generateMockBootstrap(userId, sessionType, contextMode);
    return NextResponse.json(mockBootstrap);
  }
}
