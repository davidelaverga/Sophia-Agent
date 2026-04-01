type StopTalkingCommandParams = {
  wavBuffer: ArrayBuffer | null
  isConnected: () => boolean
  sendBinary: (data: ArrayBuffer | Blob) => boolean
  sendText: (text: string) => boolean
  waitMs?: number
}

export type StopTalkingCommandResult = "no-audio" | "disconnected" | "sent" | "send-failed"

type HandleStopTalkingCommandFailureParams = {
  commandResult: StopTalkingCommandResult
  sessionEndedMessage: string
  setErrorMessage: (message: string) => void
  toIdleSettled: () => void
  disconnect?: () => void
  onSendFailed?: () => void
}

export async function sendStopTalkingCommands(params: StopTalkingCommandParams): Promise<StopTalkingCommandResult> {
  const {
    wavBuffer,
    isConnected,
    sendBinary,
    sendText,
    waitMs = 100,
  } = params

  if (!wavBuffer || wavBuffer.byteLength <= 0) {
    return "no-audio"
  }

  if (!isConnected()) {
    return "disconnected"
  }

  const sentAudio = sendBinary(wavBuffer)
  if (!sentAudio) {
    return "send-failed"
  }

  await new Promise((resolve) => setTimeout(resolve, waitMs))

  const sentEndSignal = sendText("END_OF_SPEECH")
  if (!sentEndSignal) {
    return "send-failed"
  }

  return "sent"
}

export function handleStopTalkingCommandFailure({
  commandResult,
  sessionEndedMessage,
  setErrorMessage,
  toIdleSettled,
  disconnect,
  onSendFailed,
}: HandleStopTalkingCommandFailureParams) {
  if (commandResult === "disconnected") {
    setErrorMessage(sessionEndedMessage)
    toIdleSettled()
    return true
  }

  if (commandResult === "send-failed") {
    onSendFailed?.()
    setErrorMessage(sessionEndedMessage)
    toIdleSettled()
    disconnect?.()
    return true
  }

  return false
}

export function buildSpeakTextCommand(text: string, traceId: string) {
  return JSON.stringify({ type: "SPEAK_TEXT", text, trace_id: traceId })
}
