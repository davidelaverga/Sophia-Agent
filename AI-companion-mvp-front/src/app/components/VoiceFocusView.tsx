"use client"

import { Square } from "lucide-react"
import type { VoiceStateProps } from "../hooks/voice/voice-utils"
import { useVoiceToggle } from "../hooks/useVoiceToggle"
import { useEmotionColor } from "../hooks/useEmotionColor"
import { Waveform } from "./Waveform"
import { ChatCollapsed } from "./ChatCollapsed"
import { VoiceTranscript } from "./VoiceTranscript"
import { VoiceMicButton, VoiceStatusText } from "./VoiceMicButton"
import { UsageHint } from "./UsageHint"
import { useTranslation } from "../copy"

/**
 * VoiceFocusView
 * 
 * Minimalist voice panel in focus mode - clean, distraction-free experience.
 * Voice interaction with full conversation transcript visible.
 * 
 * IMPORTANT: Receives voice state as props to avoid multiple useVoiceLoop instances
 */

type VoiceFocusViewProps = {
  voiceState: VoiceStateProps
}

export function VoiceFocusView({ voiceState }: VoiceFocusViewProps) {
  const { t } = useTranslation()
  const { 
    stage, 
    partialReply, 
    finalReply, 
    error, 
    stream, 
    startTalking, 
    stopTalking, 
    bargeIn 
  } = voiceState
  
  // Use unified voice toggle hook (start-recording behavior for focus view)
  const { isModalOpen, handleToggle, handleKeyPress, getWaveformState } = useVoiceToggle({
    stage,
    stopTalking,
    startTalking,
    idleBehavior: "start-recording",
  })

  const emotionColor = useEmotionColor()

  const _activeReply = partialReply || finalReply
  const showInterrupt = stage === "speaking"

  return (
    <div className="space-y-4">
      {/* Chat collapsed indicator - easy switch to chat mode */}
      <ChatCollapsed />
      
      <section 
        className={`rounded-2xl bg-sophia-surface p-6 shadow-soft animate-fadeIn transition-all duration-500 ${
          stage === "thinking" 
            ? "animate-ringBreathe" 
            : ""
        }`}
      >
        {/* Voice transcript - Sophia's voice responses */}
        <VoiceTranscript partialReply={partialReply} finalReply={finalReply} />

        {/* Waveform visualization */}
        <div className={`flex justify-center ${partialReply || finalReply ? "mt-6 mb-6" : "mb-6"}`}>
          <div className="w-full max-w-md">
            <Waveform
              stream={stream ?? undefined}
              presenceState={getWaveformState()}
              emotionRgb={emotionColor.rgb}
            />
          </div>
        </div>

        {/* Main button area */}
        <div className="flex flex-col items-center gap-4">
          {/* Microphone button with status */}
          <div className="flex flex-col items-center gap-2">
            <VoiceMicButton
              stage={stage}
              isModalOpen={isModalOpen}
              onClick={handleToggle}
              onKeyDown={handleKeyPress}
              size="large"
              emotionPrimary={emotionColor.primary}
              emotionGlow={emotionColor.glow}
              ariaLabels={{
                start: t("voiceFocusView.startRecordingAriaLabel"),
                stop: t("voiceFocusView.stopRecordingAriaLabel"),
              }}
            />
            <VoiceStatusText stage={stage} size="large" />
          </div>

          {/* Interrupt button when Sophia is speaking */}
          {showInterrupt && (
            <button
              type="button"
              className="flex items-center gap-2 rounded-full border border-sophia-surface-border px-3 py-1.5 text-xs font-medium text-sophia-text hover:bg-sophia-purple/10 transition-colors duration-200"
              onClick={bargeIn}
            >
              <Square className="h-3 w-3" />
              {t("voicePanel.interrupt")}
            </button>
          )}
        </div>

        {/* Error message */}
        {error && (
          <p className="mt-4 rounded-2xl bg-sophia-error/10 px-4 py-3 text-sm text-sophia-text" role="status">
            {error}
          </p>
        )}
      </section>
      
      {/* Usage hint for voice mode */}
      <UsageHint />
    </div>
  )
}




