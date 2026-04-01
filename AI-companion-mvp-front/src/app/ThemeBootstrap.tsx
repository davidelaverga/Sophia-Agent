"use client"

import { useEffect } from "react"
import { logger } from "./lib/error-logger"

const STORAGE_KEY = "sophia-theme"

// Themes that are considered "dark" for Tailwind's dark: classes
const DARK_THEMES = [
  "moonlit-embrace",
  "moonlit",
  "dark",
  "accessible-indigo",
  "accessible-slate",
  "accessible-charcoal",
]

/**
 * Checks if a theme is a dark theme
 */
function isDarkTheme(theme: string): boolean {
  return DARK_THEMES.includes(theme)
}

/**
 * Applies theme to document - both data-sophia-theme AND class="dark" for Tailwind
 */
function applyTheme(theme: string) {
  document.documentElement.dataset.sophiaTheme = theme
  
  // Also toggle the 'dark' class for Tailwind's dark: variant
  if (isDarkTheme(theme)) {
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
      const stored = window.localStorage.getItem(STORAGE_KEY)
      
      let theme: string
      if (stored) {
        // User has a saved preference
        theme = stored
      } else {
        // Detect system preference
        const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
        theme = prefersDark ? "moonlit-embrace" : "light"
      }
      
      applyTheme(theme)
    } catch (err) {
      logger.logError(err, { component: "ThemeBootstrap", action: "read_theme" })
      applyTheme("light")
    }
  }, [])

  return null
}

/**
 * Helper to update theme from anywhere in the client.
 */
export function setSophiaTheme(theme: string) {
  if (typeof window === "undefined") return
  applyTheme(theme)
  try {
    window.localStorage.setItem(STORAGE_KEY, theme)
  } catch (err) {
    logger.logError(err, { component: "ThemeBootstrap", action: "persist_theme" })
  }
}




