/**
 * VoiceMicButton Component
 * =========================
 * 
 * Reusable microphone button for voice recording.
 * Extracted from VoicePanel and VoiceFocusView to eliminate duplication.
 */

"use client"

import { Mic } from "lucide-react"

import { useTranslation } from "../copy"

export type VoiceStage = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error"

interface VoiceMicButtonProps {
  /** Current voice stage */
  stage: VoiceStage
  /** Whether a modal is open that should disable the button */
  isModalOpen?: boolean
  /** Click handler */
  onClick: () => void
  /** Optional keyboard handler */
  onKeyDown?: (event: React.KeyboardEvent) => void
  /** Size variant */
  size?: "default" | "large"
  /** Custom aria labels for start/stop */
  ariaLabels?: {
    start?: string
    stop?: string
  }
  /** Dynamic emotion color (CSS value, e.g. "#aa8a5c") */
  emotionPrimary?: string
  /** Dynamic emotion glow color */
  emotionGlow?: string
}

/**
 * Microphone button with visual feedback for voice recording states.
 * Handles idle, listening, thinking, and speaking states with appropriate styling.
 */
export function VoiceMicButton({
  stage,
  isModalOpen = false,
  onClick,
  onKeyDown,
  size = "default",
  ariaLabels,
  emotionPrimary,
  emotionGlow,
}: VoiceMicButtonProps) {
  const { t } = useTranslation()
  
  const isDisabled = stage === "thinking" || stage === "speaking" || isModalOpen
  
  // Size classes
  const sizeClasses = size === "large" 
    ? "h-16 w-16 sm:h-24 sm:w-24" 
    : "h-16 w-16 sm:h-20 sm:w-20"
  
  const iconSizeClasses = size === "large"
    ? "h-8 w-8 sm:h-10 sm:w-10"
    : "h-7 w-7 sm:h-8 sm:w-8"

  // When emotion colors are provided, use inline styles instead of Tailwind classes
  const hasEmotionColor = emotionPrimary && emotionGlow
  
  // State-based styling (fallback Tailwind when no emotion color)
  const stateClasses = hasEmotionColor
    ? "text-white transition-all duration-300"
    : isModalOpen
    ? "bg-gradient-to-br from-sophia-purple/40 to-sophia-glow/30 opacity-50 cursor-not-allowed"
    : stage === "listening"
    ? "bg-gradient-to-br from-sophia-purple to-sophia-glow shadow-lg shadow-sophia-purple/40 scale-105"
    : stage === "thinking"
    ? "bg-gradient-to-br from-sophia-purple/60 to-sophia-glow/40 opacity-60 cursor-not-allowed"
    : "bg-gradient-to-br from-sophia-purple to-sophia-glow/60 hover:shadow-md hover:scale-105"

  // Build inline style when emotion color is active
  const emotionStyle: React.CSSProperties | undefined = hasEmotionColor
    ? {
        background: `linear-gradient(to bottom right, ${emotionPrimary}, ${emotionGlow})`,
        boxShadow: stage === "listening" ? `0 10px 15px -3px ${emotionPrimary}66` : undefined,
        opacity: isModalOpen ? 0.5 : stage === "thinking" ? 0.6 : 1,
        transform: stage === "listening" ? "scale(1.05)" : undefined,
        cursor: isDisabled ? "not-allowed" : undefined,
      }
    : undefined

  const startLabel = ariaLabels?.start ?? t("voiceRecorder.buttons.start")
  const stopLabel = ariaLabels?.stop ?? t("voiceRecorder.buttons.stop")

  return (
    <button
      type="button"
      onClick={onClick}
      onKeyDown={onKeyDown}
      disabled={isDisabled}
      className={`group relative flex items-center justify-center rounded-2xl text-white transition-all duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${sizeClasses} ${stateClasses}`}
      style={emotionStyle}
      aria-pressed={stage === "listening"}
      aria-busy={stage === "thinking" || isModalOpen}
      aria-label={stage === "listening" ? stopLabel : startLabel}
    >
      <Mic className={iconSizeClasses} />
    </button>
  )
}

interface VoiceStatusTextProps {
  /** Current voice stage */
  stage: VoiceStage
  /** Size variant affects text size */
  size?: "default" | "large"
}

/**
 * Status text shown below the mic button.
 * Displays contextual instructions based on current stage.
 */
export function VoiceStatusText({ stage, size = "default" }: VoiceStatusTextProps) {
  const { t } = useTranslation()
  
  const textSizeClass = size === "large" ? "text-xs" : "text-[11px]"
  
  if (stage === "listening") {
    return (
      <span 
        className={`${textSizeClass} font-medium text-sophia-text2 animate-fadeIn`}
        role="status"
        aria-live="polite"
      >
        {t("voicePanel.status.clickToStopAndSend")}
      </span>
    )
  }
  
  if (stage === "thinking") {
    return (
      <span 
        className={`${textSizeClass} font-medium text-sophia-purple animate-pulse`}
        role="status"
        aria-live="polite"
      >
        {t("voicePanel.status.sophiaIsThinking")}
      </span>
    )
  }
  
  return null
}

export default VoiceMicButton
