"use client"

import { useCallback } from "react"

import type { Locale as _Locale } from "./config"
import type { CopyKey, CopyStructure, InterpolationValues } from "./types"
import { translate, getCopy } from "./core"
import { useLocaleStore } from "../stores/locale-store"
import { useLocaleContext } from "./locale-context"

export type { CopyKey } from "./types"
export type { Locale } from "./config"

export function useTranslation() {
  const ctx = useLocaleContext()
  const storeLocale = useLocaleStore((s) => s.locale)
  const storeSetLocale = useLocaleStore((s) => s.setLocale)

  const locale = ctx?.locale ?? storeLocale
  const setLocale = ctx?.setLocale ?? storeSetLocale

  const t = useCallback(
    (key: CopyKey, values?: InterpolationValues) => translate(locale, key, values),
    [locale],
  )

  return { t, locale, setLocale }
}

export function useCopy(): CopyStructure {
  const ctx = useLocaleContext()
  const storeLocale = useLocaleStore((s) => s.locale)
  const locale = ctx?.locale ?? storeLocale
  return getCopy(locale)
}

// Non-hook helper (safe for event handlers, stores, etc.)
export function t(key: CopyKey, values?: InterpolationValues): string {
  return translate(useLocaleStore.getState().locale, key, values)
}

// Back-compat export for legacy usages.
// Prefer `useCopy()` to keep components reactive.
export const copy: CopyStructure = new Proxy({} as CopyStructure, {
  get(_target, prop: string | symbol) {
    const locale = useLocaleStore.getState().locale
    const localizedCopy = getCopy(locale) as Record<PropertyKey, unknown>
    return localizedCopy[prop as PropertyKey]
  },
}) as CopyStructure
