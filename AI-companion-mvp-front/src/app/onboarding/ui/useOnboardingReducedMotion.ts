"use client"

import { useEffect } from "react"
import { useOnboardingStore } from "../../stores/onboarding-store"

export function useOnboardingReducedMotion(): boolean {
  const reducedMotion = useOnboardingStore((state) => state.preferences.reducedMotion)
  const setReducedMotion = useOnboardingStore((state) => state.setReducedMotion)

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)")

    setReducedMotion(mediaQuery.matches)

    const handleChange = (event: MediaQueryListEvent) => {
      setReducedMotion(event.matches)
    }

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange)

      return () => {
        mediaQuery.removeEventListener("change", handleChange)
      }
    }

    mediaQuery.addListener(handleChange)

    return () => {
      mediaQuery.removeListener(handleChange)
    }
  }, [setReducedMotion])

  return reducedMotion
}