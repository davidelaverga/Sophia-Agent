"use client"

import { useEffect } from "react"

import { logger } from "./lib/error-logger"
import {
  COSMIC_THEME_ID,
  SOPHIA_THEME_STORAGE_KEY,
  isDarkSophiaTheme,
  normalizeSophiaTheme,
} from "./theme"

/**
 * Applies theme to document - both data-sophia-theme AND class="dark" for Tailwind
 */
function applyTheme(theme: string) {
  const normalizedTheme = normalizeSophiaTheme(theme)
  document.documentElement.dataset.sophiaTheme = normalizedTheme
  
  // Also toggle the 'dark' class for Tailwind's dark: variant
  if (isDarkSophiaTheme(normalizedTheme)) {
    document.documentElement.classList.add("dark")
  } else {
    document.documentElement.classList.remove("dark")
  }
}

/**
 * Small client-only component that:
 * - Reads the saved theme from localStorage (if any)
 * - If no saved preference, detects system preference (prefers-color-scheme)
 * - Applies it to <html data-sophia-theme="..."> AND class="dark" for Tailwind
 * This ensures the chosen theme persists outside of Settings.
 */
export function ThemeBootstrap() {
  useEffect(() => {
    if (typeof window === "undefined") return

    try {
      const stored = window.localStorage.getItem(SOPHIA_THEME_STORAGE_KEY)
      const theme = normalizeSophiaTheme(stored)

      applyTheme(theme)

      if (stored !== theme) {
        window.localStorage.setItem(SOPHIA_THEME_STORAGE_KEY, theme)
      }
    } catch (err) {
      logger.logError(err, { component: "ThemeBootstrap", action: "read_theme" })
      applyTheme(COSMIC_THEME_ID)
    }
  }, [])

  return null
}

/**
 * Helper to update theme from anywhere in the client.
 */
export function setSophiaTheme(theme: string) {
  if (typeof window === "undefined") return
  const normalizedTheme = normalizeSophiaTheme(theme)
  applyTheme(normalizedTheme)
  try {
    window.localStorage.setItem(SOPHIA_THEME_STORAGE_KEY, normalizedTheme)
  } catch (err) {
    logger.logError(err, { component: "ThemeBootstrap", action: "persist_theme" })
  }
}




