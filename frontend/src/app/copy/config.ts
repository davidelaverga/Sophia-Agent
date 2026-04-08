export const SUPPORTED_LOCALES = ["en", "es", "it"] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_LOCALE: Locale = "en"

export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Español",
  it: "Italiano",
}

export const LOCALE_COOKIE_NAME = "sophia-locale" as const

const BROWSER_LOCALE_MAP: Record<string, Locale> = {
  en: "en",
  "en-US": "en",
  "en-GB": "en",
  es: "es",
  "es-ES": "es",
  "es-MX": "es",
  "es-AR": "es",
  "es-CO": "es",
  "es-CL": "es",
  "es-PE": "es",
  "es-419": "es", // Latin America
  it: "it",
  "it-IT": "it",
  "it-CH": "it",
}

export function normalizeLocale(input: string | undefined | null): Locale | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null

  // Exact match first
  const direct = BROWSER_LOCALE_MAP[trimmed]
  if (direct) return direct

  // Try base language (es-MX -> es)
  const base = trimmed.split("-")[0]
  const baseMatch = BROWSER_LOCALE_MAP[base]
  if (baseMatch) return baseMatch

  return null
}

// Minimal Accept-Language parser: picks first supported locale by q-value order.
export function localeFromAcceptLanguage(headerValue: string | null | undefined): Locale | null {
  if (!headerValue) return null

  // Example: "es-ES,es;q=0.9,en;q=0.8"
  const parts = headerValue
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)

  const candidates = parts
    .map((part) => {
      const [tag, ...params] = part.split(";")
      const qParam = params.find((p) => p.trim().startsWith("q="))
      const q = qParam ? Number(qParam.split("=")[1]) : 1
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0 }
    })
    .sort((a, b) => b.q - a.q)

  for (const candidate of candidates) {
    const normalized = normalizeLocale(candidate.tag)
    if (normalized) return normalized
  }

  return null
}
