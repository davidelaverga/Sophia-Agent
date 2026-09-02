import { type NextRequest, NextResponse } from "next/server"

import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, localeFromAcceptLanguage } from "./src/app/copy/config"
import {
  VOICE_LAB_CONTEXT_COOKIE_NAME,
  VOICE_LAB_RUN_BINDING_COOKIE_NAME,
} from "./src/app/lib/synthetic-isolation-policy"

// Cookie to track if user manually selected a language (vs auto-detected)
const LOCALE_MANUAL_COOKIE = "sophia-locale-manual"

const VOICE_LAB_GOVERNED_API_ROUTES: ReadonlyArray<{
  methods: ReadonlySet<string>
  path: RegExp
}> = [
  { methods: new Set(['GET']), path: /^\/api\/(?:app-version|health)$/ },
  { methods: new Set(['GET', 'POST']), path: /^\/api\/voice-lab\/auth\/(?:grant|provision|continue|refresh|cleanup|readiness)$/ },
  { methods: new Set(['POST']), path: /^\/api\/voice-lab\/control\/(?:session-start|voice-start)$/ },
  { methods: new Set(['GET']), path: /^\/api\/auth\/(?:get-session|session)$/ },
  { methods: new Set(['POST']), path: /^\/api\/auth\/sign-out$/ },
  { methods: new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), path: /^\/api\/sessions(?:\/.*)?$/ },
  { methods: new Set(['POST']), path: /^\/api\/sophia\/[^/]+\/voice\/connect$/ },
  { methods: new Set(['GET']), path: /^\/api\/sophia\/voice\/gemini\/events$/ },
  { methods: new Set(['POST']), path: /^\/api\/sophia\/voice\/gemini\/(?:relay|disconnect|activate|continuation-bootstrap)$/ },
  { methods: new Set(['POST']), path: /^\/api\/sophia\/end-session$/ },
  { methods: new Set(['GET', 'POST']), path: /^\/api\/sophia\/builder\/threads\/[^/]+\/canvas(?:\/.*)?$/ },
  { methods: new Set(['GET']), path: /^\/api\/threads\/[^/]+\/builder-events(?:\/last)?$/ },
  { methods: new Set(['GET']), path: /^\/api\/threads\/[^/]+\/artifacts(?:\/.*)?$/ },
]

export function voiceLabFrontendApiAccessAllowed(method: string, pathname: string): boolean {
  return VOICE_LAB_GOVERNED_API_ROUTES.some(
    (entry) => entry.methods.has(method.toUpperCase()) && entry.path.test(pathname),
  )
}

export function middleware(request: NextRequest) {
  // 🔒 SECURITY: Block /debug route in production
  if (request.nextUrl.pathname === '/debug' || request.nextUrl.pathname.startsWith('/debug/')) {
    if (process.env.NODE_ENV !== 'development') {
      return NextResponse.redirect(new URL('/', request.url))
    }
  }

  const voiceLabContextPresent = request.cookies.has(VOICE_LAB_CONTEXT_COOKIE_NAME)
    || request.cookies.has(VOICE_LAB_RUN_BINDING_COOKIE_NAME)
  if (
    voiceLabContextPresent
    && request.nextUrl.pathname.startsWith('/api/')
    && !voiceLabFrontendApiAccessAllowed(request.method, request.nextUrl.pathname)
  ) {
    return NextResponse.json(
      { error: 'voice_lab_ordinary_product_route_forbidden' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const response = NextResponse.next()

  const existingLocale = request.cookies.get(LOCALE_COOKIE_NAME)?.value
  const wasManuallySet = request.cookies.get(LOCALE_MANUAL_COOKIE)?.value === "true"
  
  const acceptLanguage = request.headers.get("accept-language")
  const detectedLocale = localeFromAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE

  // If user manually selected a language, always respect their choice
  if (wasManuallySet && existingLocale) {
    return response
  }

  // Auto-detect: always sync with browser language
  // This handles both first visit AND when browser language changes
  if (existingLocale !== detectedLocale) {
    response.cookies.set({
      name: LOCALE_COOKIE_NAME,
      value: detectedLocale,
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365, // 1 year
    })
    // Clear manual flag since we're auto-detecting
    response.cookies.delete(LOCALE_MANUAL_COOKIE)
  }

  return response
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.png|icon-192.png|icon-512.png|apple-icon.png|manifest.json).*)",
  ],
}
