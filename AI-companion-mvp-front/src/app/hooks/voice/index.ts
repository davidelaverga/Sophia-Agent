/**
 * Index file for voice hooks
 * Re-exports voice-related hooks still in use
 */

export { useAudioPlayback } from "./useAudioPlayback"
export { useVoiceWebSocket } from "./useVoiceWebSocket"
export type { WebSocketMessage, WebSocketHandlers } from "./useVoiceWebSocket"
export * from "./voice-utils"
