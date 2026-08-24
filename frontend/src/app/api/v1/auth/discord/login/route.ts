import { createLegacyBridgeUserResponse, resolveLegacyBridgeUser } from '../../_lib/bridge'
import { voiceLabOrdinaryProductBoundaryResponse } from '@/server/voice-lab/ordinary-route-isolation'

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export async function POST(request: Request) {
  const voiceLabDenied = await voiceLabOrdinaryProductBoundaryResponse()
  if (voiceLabDenied) return voiceLabDenied

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null

  if (!body) {
    return Response.json({ detail: 'Invalid JSON body' }, { status: 400 })
  }

  const { user, response } = await resolveLegacyBridgeUser({
    canonical_user_id: readString(body.canonical_user_id),
    discord_id: readString(body.discord_id),
    email: readString(body.email),
    username: readString(body.username),
  })

  if (response) {
    return response
  }

  return createLegacyBridgeUserResponse(user)
}
