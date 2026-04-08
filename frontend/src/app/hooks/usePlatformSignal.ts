"use client"

import { Capacitor } from "@capacitor/core"
import { useMemo } from "react"

import { useUiStore, type FocusMode } from "../stores/ui-store"

/**
 * Sophia platform signal values — matched to backend middleware expectations.
 * See CLAUDE.md: PlatformContextMiddleware reads this from configurable.
 */
export type SophiaPlatform = "voice" | "text" | "ios_voice"

/**
 * Derive the Sophia platform signal from UI mode + native platform.
 *
 * Rules:
 *  - voice mode + iOS native → "ios_voice"
 *  - voice mode (non-iOS) → "voice"
 *  - text mode → "text"
 */
export function derivePlatform(uiMode: FocusMode, isNativeIOS: boolean): SophiaPlatform {
  if (uiMode === "voice") return isNativeIOS ? "ios_voice" : "voice"
  return "text"
}

/**
 * Hook returning the current Sophia platform signal.
 * Re-derives when UI mode changes.
 */
export function usePlatformSignal(): SophiaPlatform {
  const mode = useUiStore((s) => s.mode)
  const isNativeIOS = useMemo(
    () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios",
    [],
  )
  return useMemo(() => derivePlatform(mode, isNativeIOS), [mode, isNativeIOS])
}
