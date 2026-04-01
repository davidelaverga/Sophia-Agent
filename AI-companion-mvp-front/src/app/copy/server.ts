import { cookies, headers } from "next/headers"

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  localeFromAcceptLanguage,
  normalizeLocale,
  type Locale,
} from "./config"

import type { CopyKey, CopyStructure, InterpolationValues } from "./types"
import { getCopy, translate } from "./core"

export function getRequestLocale(): Locale {
  // 1) Cookie wins
  const cookieValue = cookies().get(LOCALE_COOKIE_NAME)?.value
  const fromCookie = normalizeLocale(cookieValue)
  if (fromCookie) return fromCookie

  // 2) Accept-Language fallback
  const acceptLanguage = headers().get("accept-language")
  const fromHeader = localeFromAcceptLanguage(acceptLanguage)
  if (fromHeader) return fromHeader

  return DEFAULT_LOCALE
}

export function getServerCopy(locale?: Locale): CopyStructure {
  return getCopy(locale ?? getRequestLocale())
}

export function tServer(key: CopyKey, values?: InterpolationValues, locale?: Locale): string {
  return translate(locale ?? getRequestLocale(), key, values)
}
