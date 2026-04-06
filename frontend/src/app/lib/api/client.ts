"use client"

import { debugWarn } from "../debug-logger"
import { authBypassEnabled } from "../auth/dev-bypass"

/**
 * Unified API Client
 * ==================
 * 
 * Centralized fetch wrapper with:
 * - Consistent error handling
 * - Automatic auth header injection
 * - Type-safe responses
 * - Abort signal support
 */

// =============================================================================
// Types
// =============================================================================

export interface ApiError extends Error {
  status: number
  statusText: string
  data?: unknown
}

export interface RequestOptions extends Omit<RequestInit, "body"> {
  /** Request body - will be JSON.stringify'd */
  body?: unknown
  /** Skip auth header injection */
  skipAuth?: boolean
  /** Custom error message */
  errorMessage?: string
}

// =============================================================================
// Error Factory
// =============================================================================

function createApiError(
  message: string,
  status: number,
  statusText: string,
  data?: unknown
): ApiError {
  const error = new Error(message) as ApiError
  error.name = "ApiError"
  error.status = status
  error.statusText = statusText
  error.data = data
  return error
}

// =============================================================================
// Auth Headers
// =============================================================================

async function getAuthHeaders(): Promise<Record<string, string>> {
  // Better Auth uses httpOnly cookies — sent automatically with same-origin requests.
  // Dev bypass preserved for consistency.
  if (authBypassEnabled) {
    return {}
  }
  return {}
}

// =============================================================================
// Core Request Function
// =============================================================================

/**
 * Make a type-safe API request with automatic error handling
 * 
 * @example
 * // GET request
 * const data = await apiRequest<UserData>("/api/user")
 * 
 * @example
 * // POST request with body
 * const result = await apiRequest<Response>("/api/feedback", {
 *   method: "POST",
 *   body: { turnId: "123", helpful: true }
 * })
 * 
 * @example
 * // With abort signal
 * const controller = new AbortController()
 * const data = await apiRequest<Data>("/api/data", { signal: controller.signal })
 */
export async function apiRequest<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const {
    body,
    skipAuth = false,
    errorMessage,
    headers: customHeaders = {},
    ...fetchOptions
  } = options

  // Build headers
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...customHeaders as Record<string, string>,
  }

  // Add Content-Type for requests with body
  if (body !== undefined) {
    headers["Content-Type"] = "application/json"
  }

  // Add auth headers unless skipped
  if (!skipAuth) {
    const authHeaders = await getAuthHeaders()
    Object.assign(headers, authHeaders)
  }

  // Make request
  const response = await fetch(endpoint, {
    ...fetchOptions,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  // Handle errors
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    const message = 
      (data as { error?: string }).error ??
      (data as { detail?: string }).detail ??
      errorMessage ??
      `${response.status} ${response.statusText}`
    
    throw createApiError(message, response.status, response.statusText, data)
  }

  // Return JSON response
  return response.json() as Promise<T>
}

/**
 * Make a request that returns a Blob (for file downloads)
 */
export async function apiRequestBlob(
  endpoint: string,
  options: Omit<RequestOptions, "body"> = {}
): Promise<Blob> {
  const { skipAuth = false, errorMessage, headers: customHeaders = {}, ...fetchOptions } = options

  const headers: Record<string, string> = {
    ...customHeaders as Record<string, string>,
  }

  if (!skipAuth) {
    const authHeaders = await getAuthHeaders()
    Object.assign(headers, authHeaders)
  }

  const response = await fetch(endpoint, {
    ...fetchOptions,
    headers,
  })

  if (!response.ok) {
    throw createApiError(
      errorMessage ?? `${response.status} ${response.statusText}`,
      response.status,
      response.statusText
    )
  }

  return response.blob()
}

/**
 * Make a request that doesn't return a body (204 No Content, etc.)
 */
export async function apiRequestVoid(
  endpoint: string,
  options: RequestOptions = {}
): Promise<void> {
  const {
    body,
    skipAuth = false,
    errorMessage,
    headers: customHeaders = {},
    ...fetchOptions
  } = options

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...customHeaders as Record<string, string>,
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json"
  }

  if (!skipAuth) {
    const authHeaders = await getAuthHeaders()
    Object.assign(headers, authHeaders)
  }

  const response = await fetch(endpoint, {
    ...fetchOptions,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    const message =
      (data as { error?: string }).error ??
      (data as { detail?: string }).detail ??
      errorMessage ??
      `${response.status} ${response.statusText}`

    throw createApiError(message, response.status, response.statusText, data)
  }
}

// =============================================================================
// Type Guards
// =============================================================================

export function isApiError(error: unknown): error is ApiError {
  return error instanceof Error && error.name === "ApiError"
}

export function isNotFoundError(error: unknown): boolean {
  return isApiError(error) && error.status === 404
}

export function isUnauthorizedError(error: unknown): boolean {
  return isApiError(error) && error.status === 401
}

export function isRateLimitError(error: unknown): boolean {
  return isApiError(error) && error.status === 429
}
