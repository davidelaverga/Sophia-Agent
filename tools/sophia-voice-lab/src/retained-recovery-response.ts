import { z } from "zod";
import { canonicalRequestHash } from "./security.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const RetainedRecoveryResponseSchema = z.object({
  contract_version: z.literal("sophia.voice-lab.v1"),
  request_id: z.string().uuid(),
  run_id: z.null(), test_run_id: z.null(), event_cursor: z.null(),
  status: z.literal("ok"),
  data: z.object({
    proof_status: z.literal("retained_recovery_facts_only"),
    signed_claim_sha256: digest,
    raw_evidence_purged: z.literal(true), certification_available: z.literal(false),
    control_binding_sha256: digest, owner_death_proof_sha256: digest,
    provider_settlement_proof_sha256: digest,
    live_cleanup_complete: z.boolean(), remote_purge_complete: z.boolean(),
  }).strict(),
}).passthrough();

export const RetainedRecoveryCheckpointSchema = z.object({
  response_sha256: digest,
  facts: RetainedRecoveryResponseSchema.shape.data,
}).strict();

/** An authenticated response observation, never an attestation/evidence pass. */
export class RetainedRecoveryOnlyError extends Error {
  readonly code = "RETAINED_RECOVERY_ONLY_NOT_CERTIFIED";
  constructor(readonly responseSha256: string, readonly facts: z.infer<typeof RetainedRecoveryResponseSchema>["data"]) {
    super("Retained D02 recovery facts are available, but raw scenario evidence was purged; certification remains unavailable.");
    this.name = "RetainedRecoveryOnlyError";
  }
}

export function classifyRetainedRecoveryResponse(raw: unknown, claim: { evidence: { kind: string } }, responseSha256: string): RetainedRecoveryOnlyError | null {
  if (!raw || typeof raw !== "object" || (raw as { data?: { proof_status?: unknown } }).data?.proof_status !== "retained_recovery_facts_only") return null;
  const response = RetainedRecoveryResponseSchema.parse(raw);
  if (claim.evidence.kind !== "d02_browser_worker_loss" || response.data.signed_claim_sha256 !== canonicalRequestHash(claim))
    throw new Error("Retained recovery response does not bind the exact signed D02 worker-loss claim.");
  return new RetainedRecoveryOnlyError(digest.parse(responseSha256), response.data);
}
