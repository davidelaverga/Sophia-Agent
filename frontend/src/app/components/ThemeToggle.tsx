"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Sun, Moon } from "lucide-react"
import { useTranslation } from "../copy"
import { setSophiaTheme } from "../ThemeBootstrap"

export function ThemeToggle({ dataOnboardingId }: { dataOnboardingId?: string } = {}) {
  const [theme, setTheme] = useState<string | null>(null)
  const router = useRouter()
  const { t } = useTranslation()

  useEffect(() => {
    const storedTheme = localStorage.getItem("sophia-theme")
    if (storedTheme) {
      setTheme(storedTheme)
    } else {
      // Detect system preference if no stored theme
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
      setTheme(prefersDark ? "moonlit-embrace" : "light")
    }
  }, [])

  const toggleTheme = () => {
    const newTheme = theme === "light" ? "moonlit-embrace" : "light"
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
      className="group/btn relative flex h-10 w-10 items-center justify-center rounded-xl border border-sophia-surface-border bg-sophia-button hover:border-sophia-purple/40 hover:scale-105 shadow-md dark:shadow-lg dark:shadow-sophia-purple/20 transition-all duration-200"
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
        <div className="absolute top-full mt-3 left-1/2 -translate-x-1/2 px-3 py-2 text-xs rounded-lg opacity-0 group-hover/icon:opacity-100 transition-opacity duration-300 delay-200 pointer-events-none whitespace-nowrap z-50 bg-sophia-surface text-sophia-text shadow-lg border border-sophia-surface-border">
          <div className="text-center">
            {isLight ? t("themeToggle.tooltip.light") : t("themeToggle.tooltip.moonlit")}
          </div>
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 bg-sophia-surface border-l border-t border-sophia-surface-border"></div>
        </div>
      </span>
    </button>
  )
}
