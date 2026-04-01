import { NextRequest, NextResponse } from 'next/server'

export async function GET(_req: NextRequest) {
  return NextResponse.json(
    {
      message: 'Legacy NextAuth route disabled. Use Supabase OAuth instead.',
      hint: 'Call supabase.auth.signInWithOAuth({ provider: "discord", options: { redirectTo: "/auth/callback" } }) and handle code exchange in /auth/callback.'
    },
    { status: 410 }
  )
}

// For safety, POST behaves the same as GET here
export { GET as POST }
