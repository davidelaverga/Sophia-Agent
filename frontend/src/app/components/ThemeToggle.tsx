"use client"

import { Sun, Moon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"

import { useTranslation } from "../copy"
import {
  COSMIC_THEME_ID,
  SOPHIA_THEME_STORAGE_KEY,
  getThemeToggleTarget,
  normalizeSophiaTheme,
} from "../theme"
import { setSophiaTheme } from "../ThemeBootstrap"

export function ThemeToggle({ dataOnboardingId }: { dataOnboardingId?: string } = {}) {
  const [theme, setTheme] = useState<string | null>(null)
  const router = useRouter()
  const { t } = useTranslation()

  useEffect(() => {
    const storedTheme = localStorage.getItem(SOPHIA_THEME_STORAGE_KEY)
    setTheme(normalizeSophiaTheme(storedTheme))
  }, [])

  const toggleTheme = () => {
    const newTheme = getThemeToggleTarget(theme ?? COSMIC_THEME_ID)
    setTheme(newTheme)
    setSophiaTheme(newTheme) // Use centralized function
    router.refresh()
  }

  // Don't render until we know the theme (avoid hydration mismatch)
  if (!theme) return null

  const isLight = theme === "light"

  return (
    <button
      type="button"
      onClick={toggleTheme}
      data-onboarding={dataOnboardingId}
      className="cosmic-chrome-button group/btn relative flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200 hover:scale-105"
      aria-label={
        isLight
          ? t("themeToggle.aria.switchToMoonlitEmbrace")
          : t("themeToggle.aria.switchToLightMode")
      }
    >
      {/* Icon with its own hover group for tooltip */}
      <span className="group/icon relative flex items-center justify-center">
        {isLight ? (
          <Sun className="h-5 w-5 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />
        ) : (
          <Moon className="h-5 w-5 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />
        )}
        
        {/* Tooltip - only shows when hovering the icon center */}
        <div className="cosmic-surface-panel absolute top-full left-1/2 z-50 mt-3 -translate-x-1/2 whitespace-nowrap rounded-lg px-3 py-2 text-xs opacity-0 transition-opacity duration-300 delay-200 pointer-events-none group-hover/icon:opacity-100">
          <div className="text-center">
            {isLight ? t("themeToggle.tooltip.light") : t("themeToggle.tooltip.moonlit")}
          </div>
          <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-l border-t" style={{ background: 'var(--cosmic-panel-strong)', borderColor: 'var(--cosmic-border-soft)' }}></div>
        </div>
      </span>
    </button>
  )
}
