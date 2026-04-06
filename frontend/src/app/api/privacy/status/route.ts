/**
 * Privacy Status Route - V4 Backend Adaptation
 * ==============================================
 * 
 * Note: The V4 backend does not have a /api/privacy/status endpoint.
 * This route returns sensible defaults - no backend call needed.
 * 
 * Graceful Degradation:
 * - Returns default privacy settings
 * - Allows UI to function without backend support
 */

import { type NextRequest, NextResponse } from "next/server";

// Default privacy status - backend endpoint does not exist
const DEFAULT_PRIVACY_STATUS = {
  anonymity_level: "partial",
  data_collection: {
    conversations: true,
    voice_recordings: false,
    emotional_insights: true,
  },
  retention_days: 30,
  export_available: true,
  delete_available: false,
  last_updated: new Date().toISOString(),
};

export async function GET(_request: NextRequest) {
  // Return defaults - backend does not have this endpoint
  return NextResponse.json({
    ...DEFAULT_PRIVACY_STATUS,
    last_updated: new Date().toISOString(),
  });
}

