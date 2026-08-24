import { voiceLabOrdinaryProductBoundaryResponse } from '@/server/voice-lab/ordinary-route-isolation'

import { createLegacyBridgeUserResponse, getLegacyBridgeUserFromRequest } from '../../_lib/bridge'

export async function POST(request: Request) {
  const { user, response } = getLegacyBridgeUserFromRequest(request)

  if (response) {
    return response
  }

  const voiceLabDenied = await voiceLabOrdinaryProductBoundaryResponse(user?.id)
  if (voiceLabDenied) return voiceLabDenied

  return createLegacyBridgeUserResponse(user)
}
