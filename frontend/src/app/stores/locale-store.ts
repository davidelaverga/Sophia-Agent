"use client"

import { create } from "zustand"

import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, normalizeLocale } from "../copy/config"
import type { Locale } from "../copy/config"

// Cookie to track if user manually selected a language (vs auto-detected)
const LOCALE_MANUAL_COOKIE = "sophia-locale-manual"

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null
  const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/([.$?*|{}()\[\]\\/+^])/g, "\\$1")}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

function writeCookie(name: string, value: string, days = 365): void {
  if (typeof document === "undefined") return
  const maxAge = days * 24 * 60 * 60
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`
}

function getInitialLocale(): Locale {
  // Prefer html lang set by the server to avoid hydration mismatches
  if (typeof document !== "undefined") {
    const fromHtml = normalizeLocale(document.documentElement.lang)
    if (fromHtml) return fromHtml

    const fromCookie = normalizeLocale(readCookie(LOCALE_COOKIE_NAME) ?? undefined)
    if (fromCookie) return fromCookie
  }

  return DEFAULT_LOCALE
}

type LocaleStore = {
  locale: Locale
  setLocale: (locale: Locale) => void
}

export const useLocaleStore = create<LocaleStore>((set) => ({
  locale: getInitialLocale(),
  setLocale: (locale) => {
    set({ locale })

    if (typeof document !== "undefined") {
      document.documentElement.lang = locale
      writeCookie(LOCALE_COOKIE_NAME, locale)
      // Mark as manually selected so middleware doesn't override it
      writeCookie(LOCALE_MANUAL_COOKIE, "true")
    }
  },
}))
