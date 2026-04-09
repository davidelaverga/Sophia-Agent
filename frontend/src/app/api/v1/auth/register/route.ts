import { createLegacyBridgeUserResponse, resolveLegacyBridgeUser } from '../_lib/bridge'

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null

  if (!body) {
    return Response.json({ detail: 'Invalid JSON body' }, { status: 400 })
  }

  const { user, response } = await resolveLegacyBridgeUser({
    canonical_user_id: readString(body.canonical_user_id),
    discord_id: readString(body.discord_id),
    email: readString(body.email),
    provider_user_id: readString(body.provider_user_id),
    username: readString(body.username),
  })

  if (response) {
    return response
  }

  return createLegacyBridgeUserResponse(user)
}