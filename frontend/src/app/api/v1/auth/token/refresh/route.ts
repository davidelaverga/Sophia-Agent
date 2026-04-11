import { createLegacyBridgeUserResponse, getLegacyBridgeUserFromRequest } from '../../_lib/bridge'

export async function POST(request: Request) {
  const { user, response } = getLegacyBridgeUserFromRequest(request)

  if (response) {
    return response
  }

  return createLegacyBridgeUserResponse(user)
}