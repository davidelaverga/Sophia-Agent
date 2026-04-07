/**
 * Microphone Debugging Utilities
 * 
 * Helps diagnose microphone access issues across different environments
 */

import { debugLog } from './debug-logger'

export interface MicrophoneDiagnostics {
  // Browser support
  hasGetUserMedia: boolean
  hasMediaDevices: boolean
  hasPermissionsAPI: boolean
  
  // Protocol
  isSecureContext: boolean
  protocol: string
  hostname: string
  
  // Permissions
  permissionState: "granted" | "denied" | "prompt" | "unknown"
  permissionError?: string
  
  // Media devices
  hasAudioDevices: boolean
  audioDevicesCount: number
  audioDevicesError?: string
  
  // Browser info
  userAgent: string
  browserName: string
  browserVersion: string
  
  // OS info (if available)
  platform: string
  
  // Timestamp
  timestamp: string
}

type LegacyNavigator = Navigator & {
  getUserMedia?: unknown
  webkitGetUserMedia?: unknown
  mozGetUserMedia?: unknown
  msGetUserMedia?: unknown
}

/**
 * Run comprehensive microphone diagnostics
 */
export async function diagnoseMicrophoneAccess(): Promise<MicrophoneDiagnostics> {
  const diagnostics: MicrophoneDiagnostics = {
    hasGetUserMedia: false,
    hasMediaDevices: false,
    hasPermissionsAPI: false,
    isSecureContext: false,
    protocol: "unknown",
    hostname: "unknown",
    permissionState: "unknown",
    hasAudioDevices: false,
    audioDevicesCount: 0,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    browserName: "unknown",
    browserVersion: "unknown",
    platform: typeof navigator !== "undefined" ? navigator.platform : "unknown",
    timestamp: new Date().toISOString(),
  }

  if (typeof window === "undefined") {
    return diagnostics
  }

  // Check secure context (HTTPS required for getUserMedia)
  diagnostics.isSecureContext = window.isSecureContext || false
  diagnostics.protocol = window.location.protocol
  diagnostics.hostname = window.location.hostname

  // Check getUserMedia support (legacy APIs not in TypeScript types)
  const legacyNavigator = navigator as LegacyNavigator
  diagnostics.hasGetUserMedia = !!(
    legacyNavigator.getUserMedia ||
    legacyNavigator.webkitGetUserMedia ||
    legacyNavigator.mozGetUserMedia ||
    legacyNavigator.msGetUserMedia
  )
  
  // Check MediaDevices API
  diagnostics.hasMediaDevices = !!navigator.mediaDevices?.getUserMedia

  // Check Permissions API
  diagnostics.hasPermissionsAPI = !!navigator.permissions?.query

  // Try to check permission state
  if (diagnostics.hasPermissionsAPI) {
    try {
      const result = await navigator.permissions.query({ name: "microphone" as PermissionName })
      diagnostics.permissionState = result.state as "granted" | "denied" | "prompt"
    } catch (error) {
      diagnostics.permissionState = "unknown"
      diagnostics.permissionError = (error as Error).message
    }
  }

  // Try to enumerate audio devices (requires permission)
  if (diagnostics.hasMediaDevices) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const audioDevices = devices.filter(device => device.kind === "audioinput")
      diagnostics.hasAudioDevices = audioDevices.length > 0
      diagnostics.audioDevicesCount = audioDevices.length
    } catch (error) {
      diagnostics.hasAudioDevices = false
      diagnostics.audioDevicesError = (error as Error).message
    }
  }

  // Detect browser
  const ua = diagnostics.userAgent.toLowerCase()
  if (ua.includes("chrome") && !ua.includes("edg")) {
    diagnostics.browserName = "Chrome"
    const match = ua.match(/chrome\/(\d+)/)
    diagnostics.browserVersion = match ? match[1] : "unknown"
  } else if (ua.includes("firefox")) {
    diagnostics.browserName = "Firefox"
    const match = ua.match(/firefox\/(\d+)/)
    diagnostics.browserVersion = match ? match[1] : "unknown"
  } else if (ua.includes("safari") && !ua.includes("chrome")) {
    diagnostics.browserName = "Safari"
    const match = ua.match(/version\/(\d+)/)
    diagnostics.browserVersion = match ? match[1] : "unknown"
  } else if (ua.includes("edg")) {
    diagnostics.browserName = "Edge"
    const match = ua.match(/edg\/(\d+)/)
    diagnostics.browserVersion = match ? match[1] : "unknown"
  }

  return diagnostics
}

/**
 * Format diagnostics as a readable string for console/logging
 */
export function formatDiagnostics(diagnostics: MicrophoneDiagnostics): string {
  const lines = [
    "=== Microphone Diagnostics ===",
    `Timestamp: ${diagnostics.timestamp}`,
    `Browser: ${diagnostics.browserName} ${diagnostics.browserVersion}`,
    `Platform: ${diagnostics.platform}`,
    `Protocol: ${diagnostics.protocol}`,
    `Hostname: ${diagnostics.hostname}`,
    `Secure Context: ${diagnostics.isSecureContext ? "✅ Yes" : "❌ No (HTTPS required for getUserMedia)"}`,
    "",
    "API Support:",
    `  getUserMedia: ${diagnostics.hasGetUserMedia ? "✅" : "❌"}`,
    `  MediaDevices API: ${diagnostics.hasMediaDevices ? "✅" : "❌"}`,
    `  Permissions API: ${diagnostics.hasPermissionsAPI ? "✅" : "❌"}`,
    "",
    "Permissions:",
    `  State: ${diagnostics.permissionState}`,
    diagnostics.permissionError ? `  Error: ${diagnostics.permissionError}` : "",
    "",
    "Audio Devices:",
    `  Found: ${diagnostics.hasAudioDevices ? "✅" : "❌"}`,
    `  Count: ${diagnostics.audioDevicesCount}`,
    diagnostics.audioDevicesError ? `  Error: ${diagnostics.audioDevicesError}` : "",
    "",
    "=== End Diagnostics ===",
  ]

  return lines.filter(line => line !== "").join("\n")
}

/**
 * Log diagnostics to console
 */
export function logDiagnostics(diagnostics: MicrophoneDiagnostics) {
  debugLog('microphone-debug', formatDiagnostics(diagnostics))
  debugLog('microphone-debug', 'Full diagnostics object', diagnostics)
}

/**
 * Check if environment is likely to support microphone access
 */
export function isMicrophoneLikelySupported(diagnostics: MicrophoneDiagnostics): {
  supported: boolean
  issues: string[]
} {
  const issues: string[] = []

  if (!diagnostics.isSecureContext && diagnostics.hostname !== "localhost" && diagnostics.hostname !== "127.0.0.1") {
    issues.push("Not using HTTPS (required for getUserMedia except on localhost)")
  }

  if (!diagnostics.hasMediaDevices) {
    issues.push("MediaDevices API not supported")
  }

  if (diagnostics.permissionState === "denied") {
    issues.push("Microphone permission is denied")
  }

  if (!diagnostics.hasAudioDevices && diagnostics.audioDevicesCount === 0) {
    issues.push("No audio input devices found")
  }

  return {
    supported: issues.length === 0,
    issues,
  }
}

