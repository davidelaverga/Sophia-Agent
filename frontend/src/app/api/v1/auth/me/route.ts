import { buildLegacyBackendUserResponse } from '@/server/legacy-backend-auth'

import { getLegacyBridgeUserFromRequest } from '../_lib/bridge'

export async function GET(request: Request) {
  const { user, token, response } = getLegacyBridgeUserFromRequest(request)

  if (response) {
    return response
  }

  return Response.json(buildLegacyBackendUserResponse(user, token))
}