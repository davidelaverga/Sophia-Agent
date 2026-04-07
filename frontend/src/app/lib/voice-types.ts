export type VoiceStage = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error"

export type RouterPath = "direct" | "light" | "agentic"

export type VoiceStateProps = {
  stage: VoiceStage
  partialReply: string
  finalReply: string
  error?: string
  stream?: MediaStream | null
  needsUnlock?: boolean
  path?: RouterPath
  startTalking?: () => Promise<void>
  stopTalking: () => Promise<void> | void
  bargeIn: () => void
  unlockAudio?: () => void
  resetVoiceState?: () => void
}

export type QueuedChunk = {
  url: string
  revokeOnUse: boolean
}