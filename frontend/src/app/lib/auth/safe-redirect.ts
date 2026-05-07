/**
 * Same-origin redirect-back validation for Better Auth ``signIn.social``.
 *
 * Used by ``AuthGate`` to honor ``?next=`` query params (e.g. when a
 * Telegram review link lands the user at /recap/{X} but they have no
 * Better Auth session) without exposing an open-redirect vector.
 *
 * Rules:
 *   - Must start with `/`.
 *   - Must NOT begin with `//` or `/\` (protocol-relative escape).
 *   - Must NOT contain backslashes anywhere.
 *   - Length capped at 256.
 *
 * The current path is also accepted as the implicit default so that
 * cold-cache visits to /recap/{X} round-trip back through Google login
 * to the same /recap/{X} URL.
 */

const _MAX_LEN = 256

function looksSafePath(value: string): boolean {
  if (!value || value.length > _MAX_LEN) return false
  if (!value.startsWith("/")) return false
  if (value.startsWith("//") || value.startsWith("/\\")) return false
  if (value.includes("\\")) return false
  return true
}

export function isSafeReturnPath(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false
  return looksSafePath(value)
}

/**
 * Pick the post-Google-login destination, in order:
 * 1. `?next=` query param when same-origin path-only.
 * 2. Current `pathname` (no query) when not the root, so users who
 *    bookmarked a deep page round-trip back to it.
 * 3. `/` fallback.
 *
 * Stripping the query in step 2 is intentional — if the current URL
 * carried an unsafe `?next=` (e.g. `/?next=//evil.com`), echoing it
 * verbatim to Better Auth would leave the user on `/?next=//evil.com`
 * after Google auth. That URL is harmless on its own, but other parts
 * of the app might later read `next` and trust it. Drop the whole
 * search string from the fallback to avoid coupling.
 *
 * SSR-safe: returns `/` when called outside a browser.
 */
export function resolveSafeCallbackURL(): string {
  if (typeof window === "undefined") return "/"
  let next: string | null = null
  try {
    next = new URL(window.location.href).searchParams.get("next")
  } catch {
    next = null
  }
  if (isSafeReturnPath(next)) return next

  const pathname = window.location.pathname
  if (isSafeReturnPath(pathname) && pathname !== "/") return pathname

  return "/"
}
