"use client"

import { Mic } from "lucide-react"

import { useTranslation } from "../copy"
import { useUiStore as useFocusModeStore } from "../stores/ui-store"

export function ActiveModeIndicator() {
  const { t } = useTranslation()
  const focusMode = useFocusModeStore((state) => state.mode)
  
  // Only show indicator in voice-only mode, not in full or text modes
  if (focusMode !== "voice") return null
  
  return (
    <div 
      className="group/btn relative flex h-10 w-10 items-center justify-center rounded-xl border border-sophia-surface-border bg-sophia-button shadow-md dark:shadow-lg dark:shadow-sophia-purple/20 transition-all duration-200"
      title={t("activeModeIndicator.voice")}
    >
      <Mic className="h-5 w-5 text-sophia-purple" />
      {/* Subtle pulse to indicate active voice mode */}
      <div className="absolute inset-0 rounded-xl bg-sophia-purple/10 animate-pulse pointer-events-none" />
    </div>
  )
}
