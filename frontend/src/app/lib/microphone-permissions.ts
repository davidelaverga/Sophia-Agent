/**
 * Microphone Permissions Helper
 * 
 * Provides utilities to check microphone permission status
 * before requesting access, allowing for better UX.
 */

import { debugWarn } from "./debug-logger"

export type MicrophonePermissionState = "granted" | "denied" | "prompt" | "unknown"

/**
 * Check current microphone permission status
 * 
 * @returns Promise resolving to permission state
 * - "granted": User has already granted permission
 * - "denied": User has denied permission (needs to change in browser settings)
 * - "prompt": Browser will show permission prompt on next getUserMedia call
 * - "unknown": Permission API not supported (fallback to direct getUserMedia)
 */
export async function checkMicrophonePermission(): Promise<MicrophonePermissionState> {
  // Check if Permissions API is supported
  if (!navigator.permissions) {
    return "unknown"
  }

  try {
    // Query microphone permission
    // Note: Some browsers may not support 'microphone' as PermissionName
    // In that case, we'll fall back to checking via getUserMedia
    const result = await navigator.permissions.query({ 
      name: "microphone" as PermissionName 
    })
    
    return result.state as MicrophonePermissionState
  } catch (error) {
    // Permission API might not support 'microphone' name in all browsers
    // Or browser doesn't support Permissions API
    debugWarn("mic-permissions", "Permission query failed", { error })
    return "unknown"
  }
}

/**
 * Check if microphone permission is already granted
 * 
 * @returns Promise resolving to true if granted, false otherwise
 */
export async function isMicrophonePermissionGranted(): Promise<boolean> {
  const state = await checkMicrophonePermission()
  return state === "granted"
}

/**
 * Check if microphone permission is denied (user must change in browser settings)
 * 
 * @returns Promise resolving to true if denied, false otherwise
 */
export async function isMicrophonePermissionDenied(): Promise<boolean> {
  const state = await checkMicrophonePermission()
  return state === "denied"
}

/**
 * Get user-friendly message based on permission state
 * 
 * @param state Permission state
 * @returns User-friendly message
 */
export function getMicrophonePermissionMessage(state: MicrophonePermissionState): string {
  switch (state) {
    case "granted":
      return "Microphone access is enabled"
    case "denied":
      return "Microphone access is blocked. Please enable it in your browser settings."
    case "prompt":
      return "Microphone permission will be requested when you start recording"
    case "unknown":
      return "Unable to check microphone permission status"
    default:
      return "Unknown permission state"
  }
}

/**
 * Listen for permission state changes
 * 
 * @param callback Function called when permission state changes
 * @returns Cleanup function to stop listening
 */
export function watchMicrophonePermission(
  callback: (state: MicrophonePermissionState) => void
): () => void {
  if (!navigator.permissions) {
    // Not supported, call with unknown and return no-op cleanup
    callback("unknown")
    return () => {}
  }

  let isActive = true

  navigator.permissions
    .query({ name: "microphone" as PermissionName })
    .then((result) => {
      if (!isActive) return
      
      // Initial state
      callback(result.state as MicrophonePermissionState)

      // Listen for changes
      result.onchange = () => {
        if (isActive) {
          callback(result.state as MicrophonePermissionState)
        }
      }
    })
    .catch((error) => {
      debugWarn("mic-permissions", "Permission watch failed", { error })
      if (isActive) {
        callback("unknown")
      }
    })

  // Return cleanup function
  return () => {
    isActive = false
  }
}


