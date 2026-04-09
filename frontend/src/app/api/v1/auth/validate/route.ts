import { getLegacyBridgeUserFromRequest } from '../_lib/bridge'

export async function GET(request: Request) {
  const { user, response } = getLegacyBridgeUserFromRequest(request)

  if (response) {
    return response
  }

  return Response.json({
    valid: true,
    user_id: user.id,
    email: user.email,
    is_active: user.is_active,
  })
}