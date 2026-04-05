import { NextRequest, NextResponse } from "next/server"

import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, localeFromAcceptLanguage } from "./src/app/copy/config"

// Cookie to track if user manually selected a language (vs auto-detected)
const LOCALE_MANUAL_COOKIE = "sophia-locale-manual"

export function middleware(request: NextRequest) {
  // 🔒 SECURITY: Block /debug route in production
  if (request.nextUrl.pathname === '/debug' || request.nextUrl.pathname.startsWith('/debug/')) {
    if (process.env.NODE_ENV !== 'development') {
      return NextResponse.redirect(new URL('/', request.url))
    }
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
