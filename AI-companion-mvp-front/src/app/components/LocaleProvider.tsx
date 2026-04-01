"use client"

import { useEffect, useMemo, useState } from "react"

import type { Locale } from "../copy/config"
import { LocaleContextProvider } from "../copy/locale-context"
import { useLocaleStore } from "../stores/locale-store"

export function LocaleProvider({ initialLocale, children }: { initialLocale: Locale; children: React.ReactNode }) {
  const setLocale = useLocaleStore((s) => s.setLocale)
  const storeLocale = useLocaleStore((s) => s.locale)

  // Use the request locale for SSR and first client render.
  // This prevents React hydration mismatches when the client store initializes from <html lang>.
  const [locale, setLocaleState] = useState<Locale>(initialLocale)

  useEffect(() => {
    // Ensure client store matches SSR locale (especially on first visit).
    setLocale(initialLocale)
  }, [initialLocale, setLocale])

  useEffect(() => {
    setLocaleState(storeLocale)
  }, [storeLocale])

  const value = useMemo(
    () => ({
      locale,
      setLocale: (nextLocale: Locale) => setLocale(nextLocale),
    }),
    [locale, setLocale],
  )

  return <LocaleContextProvider value={value}>{children}</LocaleContextProvider>
}
