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

export async function getRequestLocale(): Promise<Locale> {
  // 1) Cookie wins
  const cookieValue = (await cookies()).get(LOCALE_COOKIE_NAME)?.value
  const fromCookie = normalizeLocale(cookieValue)
  if (fromCookie) return fromCookie

  // 2) Accept-Language fallback
  const acceptLanguage = (await headers()).get("accept-language")
  const fromHeader = localeFromAcceptLanguage(acceptLanguage)
  if (fromHeader) return fromHeader

  return DEFAULT_LOCALE
}

export async function getServerCopy(locale?: Locale): Promise<CopyStructure> {
  return getCopy(locale ?? await getRequestLocale())
}

export async function tServer(key: CopyKey, values?: InterpolationValues, locale?: Locale): Promise<string> {
  return translate(locale ?? await getRequestLocale(), key, values)
}
