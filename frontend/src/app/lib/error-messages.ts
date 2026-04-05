import type { CopyStructure } from "../copy/types"

export type ErrorType = 
  | "network" 
  | "timeout" 
  | "serverError" 
  | "voiceError" 
  | "processingError" 
  | "unexpected"

export type ErrorMessage = {
  title: string
  message: string
}

/**
 * Get a personalized error message based on error type
 * Maintains Sophia's empathetic voice even in error states
 */
export function getErrorMessage(copy: CopyStructure, errorType?: ErrorType): ErrorMessage {
  if (!errorType) {
    return copy.errors.unexpected
  }
  
  return copy.errors[errorType] || copy.errors.unexpected
}

/**
 * Infer error type from error object or message
 * Helps determine the most appropriate personalized message
 */
export function inferErrorType(error?: Error | string): ErrorType {
  const errorString = typeof error === "string" 
    ? error.toLowerCase() 
    : error?.message?.toLowerCase() || ""
  
  if (errorString.includes("network") || errorString.includes("fetch")) {
    return "network"
  }
  
  if (errorString.includes("timeout") || errorString.includes("time out")) {
    return "timeout"
  }
  
  if (errorString.includes("500") || errorString.includes("server")) {
    return "serverError"
  }
  
  if (errorString.includes("voice") || errorString.includes("audio") || errorString.includes("microphone")) {
    return "voiceError"
  }
  
  if (errorString.includes("process") || errorString.includes("parse")) {
    return "processingError"
  }
  
  return "unexpected"
}

/**
 * Get a user-friendly error message from any error
 * Combines type inference with personalized messages
 */
export function formatError(copy: CopyStructure, error?: Error | string, fallbackType?: ErrorType): ErrorMessage {
  const errorType = fallbackType || inferErrorType(error)
  return getErrorMessage(copy, errorType)
}
