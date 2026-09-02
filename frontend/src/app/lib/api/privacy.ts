"use client"

import { apiRequest, apiRequestBlob, apiRequestVoid } from "./client"

const usePrivacyMock = process.env.NEXT_PUBLIC_MOCK_PRIVACY === "true"

// =============================================================================
// Types
// =============================================================================

export type ConsentStatusResponse = {
  consent: boolean
  consent_ts?: string
}

export type PrivacyStatus = {
  export_available: boolean
  delete_available: boolean
}

export type MemoryDeletionReceipt = {
  status: "accepted_and_fenced" | "partial_failure" | "unsupported" | "failed"
  canonical_memory_fence: string
  provider_purge: string
  source_transcript: "not_deleted"
  derived_artifacts: string
  cache_invalidation: string
  other_account_data: "not_covered_by_mem00"
  memory_count: number
  fenced_count: number
  failed_count: number
  pending_candidate_count: number
  rejected_candidate_count: number
  details?: Array<{ memory_ref: string; status: string }>
}

type ConsentCheckResponse = {
  hasConsent?: boolean
  consentDate?: string
}

// =============================================================================
// API Functions
// =============================================================================

export const getConsentStatus = async (signal?: AbortSignal): Promise<ConsentStatusResponse> => {
  if (usePrivacyMock) {
    return { consent: false }
  }
  
  const data = await apiRequest<ConsentCheckResponse>("/api/consent/check", {
    method: "GET",
    signal,
  })
  
  return {
    consent: data.hasConsent ?? false,
    consent_ts: data.consentDate ?? undefined,
  }
}

export const postConsentAccept = async (): Promise<void> => {
  if (usePrivacyMock) {
    return
  }
  
  await apiRequestVoid("/api/consent/accept", {
    method: "POST",
    body: {
      userId: "current",
      timestamp: new Date().toISOString(),
    },
  })
}

export const exportPrivacyData = async (): Promise<Blob> => {
  if (usePrivacyMock) {
    return new Blob(
      [JSON.stringify({ conversations: [], exported_at: new Date().toISOString() }, null, 2)],
      { type: "application/json" }
    )
  }
  
  return apiRequestBlob("/api/privacy/export", { method: "GET" })
}

export const deleteAccountData = async (): Promise<MemoryDeletionReceipt | undefined> => {
  if (usePrivacyMock) {
    return undefined
  }

  return apiRequest<MemoryDeletionReceipt>("/api/privacy/delete", { method: "DELETE" })
}

export const getPrivacyStatus = async (signal?: AbortSignal): Promise<PrivacyStatus> => {
  if (usePrivacyMock) {
    return { export_available: true, delete_available: true }
  }
  
  return apiRequest<PrivacyStatus>("/api/privacy/status", {
    method: "GET",
    signal,
  })
}


