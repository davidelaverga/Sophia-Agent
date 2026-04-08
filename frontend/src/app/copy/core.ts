import { debugWarn } from "../lib/debug-logger"

import type { Locale } from "./config"
import { copy as enCopy } from "./locales/en"
import { copy as esCopy } from "./locales/es"
import { copy as itCopy } from "./locales/it"
import type { CopyKey, CopyStructure, InterpolationValues } from "./types"

export const TRANSLATIONS: Record<Locale, CopyStructure> = {
  en: enCopy,
  es: esCopy,
  it: itCopy,
}

export function getCopy(locale: Locale): CopyStructure {
  return TRANSLATIONS[locale]
}

function getNestedValue(obj: Record<string, unknown>, path: string): string | undefined {
  return path.split(".").reduce<unknown>((acc, segment) => {
    if (acc && typeof acc === "object" && acc !== null) return (acc as Record<string, unknown>)[segment]
    return undefined
  }, obj) as string | undefined
}

function interpolate(text: string, values?: InterpolationValues): string {
  if (!values) return text
  return text.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = values[key]
    return value === undefined || value === null ? `{${key}}` : String(value)
  })
}

export function translate(locale: Locale, key: CopyKey, values?: InterpolationValues): string {
  const primary = getNestedValue(TRANSLATIONS[locale], key)
  if (typeof primary === "string") return interpolate(primary, values)

  const fallback = getNestedValue(TRANSLATIONS.en, key)
  if (typeof fallback === "string") {
    if (process.env.NODE_ENV !== "production") {
      debugWarn("i18n", `Missing ${locale} translation for key "${key}"`)
    }
    return interpolate(fallback, values)
  }

  if (process.env.NODE_ENV !== "production") {
    debugWarn("i18n", `Missing translation for key "${key}"`)
  }

  return key
}
