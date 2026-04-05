import { describe, expect, it, vi } from "vitest"
import {
  buildSpeakTextCommand,
  handleStopTalkingCommandFailure,
  sendStopTalkingCommands,
} from "../../../app/onboarding/voice-legacy/voice-loop-command-helpers"

describe("voice-loop-command-helpers", () => {
  it("returns no-audio when wav buffer is absent", async () => {
    const result = await sendStopTalkingCommands({
      wavBuffer: null,
      isConnected: () => true,
      sendBinary: () => true,
      sendText: () => true,
    })

    expect(result).toBe("no-audio")
  })

  it("returns disconnected when websocket is not connected", async () => {
    const result = await sendStopTalkingCommands({
      wavBuffer: new ArrayBuffer(16),
      isConnected: () => false,
      sendBinary: () => true,
      sendText: () => true,
    })

    expect(result).toBe("disconnected")
  })

  it("sends audio and END_OF_SPEECH in order", async () => {
    const sendBinary = vi.fn(() => true)
    const sendText = vi.fn(() => true)

    const result = await sendStopTalkingCommands({
      wavBuffer: new ArrayBuffer(32),
      isConnected: () => true,
      sendBinary,
      sendText,
      waitMs: 0,
    })

    expect(result).toBe("sent")
    expect(sendBinary).toHaveBeenCalledTimes(1)
    expect(sendText).toHaveBeenCalledWith("END_OF_SPEECH")
  })

  it("builds SPEAK_TEXT payload with trace id", () => {
    const payload = buildSpeakTextCommand("hola", "trace-123")
    expect(JSON.parse(payload)).toEqual({
      type: "SPEAK_TEXT",
      text: "hola",
      trace_id: "trace-123",
    })
  })

  it("handles disconnected stop command as session-ended without disconnect", () => {
    const setErrorMessage = vi.fn()
    const toIdleSettled = vi.fn()
    const disconnect = vi.fn()

    const handled = handleStopTalkingCommandFailure({
      commandResult: "disconnected",
      sessionEndedMessage: "session-ended",
      setErrorMessage,
      toIdleSettled,
      disconnect,
    })

    expect(handled).toBe(true)
    expect(setErrorMessage).toHaveBeenCalledWith("session-ended")
    expect(toIdleSettled).toHaveBeenCalledTimes(1)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it("handles send-failed stop command and disconnects", () => {
    const setErrorMessage = vi.fn()
    const toIdleSettled = vi.fn()
    const disconnect = vi.fn()
    const onSendFailed = vi.fn()

    const handled = handleStopTalkingCommandFailure({
      commandResult: "send-failed",
      sessionEndedMessage: "session-ended",
      setErrorMessage,
      toIdleSettled,
      disconnect,
      onSendFailed,
    })

    expect(handled).toBe(true)
    expect(onSendFailed).toHaveBeenCalledTimes(1)
    expect(setErrorMessage).toHaveBeenCalledWith("session-ended")
    expect(toIdleSettled).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
