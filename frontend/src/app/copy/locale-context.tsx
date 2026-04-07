"use client"

import { createContext, useContext } from "react"

import type { Locale } from "./config"

type LocaleContextValue = {
  locale: Locale
  setLocale: (locale: Locale) => void
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleContextProvider({
  value,
  children,
}: {
  value: LocaleContextValue
  children: React.ReactNode
}) {
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocaleContext(): LocaleContextValue | null {
  return useContext(LocaleContext)
}
