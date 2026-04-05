"use client"

import { Square, Zap } from "lucide-react"
import type { VoiceStateProps } from "../lib/voice-types"
import { useVoiceToggle } from "../hooks/useVoiceToggle"
import { useEmotionColor } from "../hooks/useEmotionColor"
import { Waveform } from "./Waveform"
import { VoiceTranscript } from "./VoiceTranscript"
import { VoiceMicButton, VoiceStatusText } from "./VoiceMicButton"
import { useTranslation } from "../copy"
import { haptic } from "../hooks/useHaptics"

type VoicePanelProps = {
  voiceState: VoiceStateProps
}

export function VoicePanel({ voiceState }: VoicePanelProps) {
  const { t } = useTranslation()

  const { stage, partialReply, finalReply, error, path, needsUnlock, stream, stopTalking, bargeIn, unlockAudio } =
    voiceState
  
  // Use unified voice toggle hook (switch-mode behavior for panel)
  const { isModalOpen, handleToggle, handleKeyPress, getWaveformState } = useVoiceToggle({
    stage,
    stopTalking,
    idleBehavior: "switch-mode",
  })

  const emotionColor = useEmotionColor()

  const activeReply = partialReply || finalReply
  const showInterrupt = stage === "speaking"

  const stageText: Record<string, string> = {
    idle: t("voicePanel.stageHint.idle"),
    connecting: t("voicePanel.stageHint.connecting"),
    listening: t("presence.listening"),
    thinking: t("presence.thinking"),
    speaking: t("presence.speaking"),
    error: t("voicePanel.stageHint.error"),
  }

  return (
    <section 
      className={`rounded-2xl bg-sophia-surface p-5 pb-6 shadow-soft transition-all duration-500 ${
        stage === "thinking" 
          ? "animate-ringBreathe" 
          : ""
      }`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-sophia-text">{t("voicePanel.title")}</p>
          <p className="text-sm text-sophia-text2 sm:text-sm text-xs">{stageText[stage] ?? ""}</p>
        </div>
        {path && (
          <span className="inline-flex w-fit rounded-full bg-sophia-reply px-3 py-1 text-xs font-medium text-sophia-text2 uppercase tracking-wide">
            {path}
          </span>
        )}
      </div>

      {/* Voice transcript - Sophia's voice responses */}
      <div className="mt-4">
        <VoiceTranscript partialReply={partialReply} finalReply={finalReply} />
      </div>

      <div className="mt-6 flex flex-col items-center gap-4">
        {/* Waveform visualization - ABOVE the button for better visibility */}
        <div className="w-full max-w-xs">
          <Waveform
            stream={stream ?? undefined}
            presenceState={getWaveformState()}
            emotionRgb={emotionColor.rgb}
          />
        </div>

        {/* Button with hint text below */}
        <div className="flex flex-col items-center gap-2">
          <VoiceMicButton
            stage={stage}
            isModalOpen={isModalOpen}
            onClick={handleToggle}
            onKeyDown={handleKeyPress}
            size="large"
            emotionPrimary={emotionColor.primary}
            emotionGlow={emotionColor.glow}
          />
          <VoiceStatusText stage={stage} />
        </div>

        {showInterrupt && (
          <button
            type="button"
            className="flex items-center gap-2 rounded-full border border-sophia-surface-border px-3 py-1 text-xs font-medium text-sophia-text"
            onClick={() => {
              haptic('light')
              bargeIn()
            }}
          >
            <Square className="h-3 w-3" />
            {t("voicePanel.interrupt")}
          </button>
        )}
      </div>

        {needsUnlock && (
        <div className="mt-4 w-full rounded-2xl border border-sophia-surface-border bg-sophia-reply/70 px-4 py-3 text-xs text-sophia-text">
          <p>{t("voicePanel.safariUnlock.message")}</p>
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1 rounded-full bg-sophia-button px-3 py-1 text-xs font-medium text-sophia-text"
            onClick={unlockAudio}
          >
            <Zap className="h-3 w-3" />
            {t("voicePanel.safariUnlock.button")}
          </button>
        </div>
      )}

      {activeReply && (
        <div className="mt-6 rounded-2xl bg-sophia-bubble px-4 py-3 text-sm text-sophia-text">
          {activeReply}
        </div>
      )}

      {error && (
        <p className="mt-4 rounded-2xl bg-sophia-error/10 px-4 py-3 text-sm text-sophia-text" role="status">
          {error}
        </p>
      )}
    </section>
  )
}

