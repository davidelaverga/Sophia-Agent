import { TERMINAL_RUN_STATES, type LabEvent, type RunRecord } from "./domain.js";

/**
 * C077: bounded re-verification of retained canonical evidence for a terminal,
 * cleanup-complete run whose latest canonical recovery receipt reported the
 * canonical_evidence component failed or pending (J6: a Gateway reader defect).
 * Only the existing session:recover authority is reused; nothing is allocated.
 * Each attempt is a durable worker event, so the bound survives restarts.
 */
export const CANONICAL_EVIDENCE_REFRESH_EVENT = "cleanup.canonical_evidence_refresh";
export const CANONICAL_EVIDENCE_REFRESH_MAX_ATTEMPTS = 3;
export const CANONICAL_EVIDENCE_REFRESH_BASE_BACKOFF_MS = 10 * 60_000;

/** The ledger's local hard deadline (postgres purgeExpiredRetention mirror). */
export function localRetentionDeadline(run: Pick<RunRecord, "retentionPurgeDueAt" | "updatedAt" | "capturePolicy">): Date {
  if (run.retentionPurgeDueAt !== null) return run.retentionPurgeDueAt;
  const hours = Math.max(1, Math.min(168, Number.isInteger(run.capturePolicy.retentionHours) ? run.capturePolicy.retentionHours : 24));
  return new Date(run.updatedAt.getTime() + hours * 3_600_000);
}

export type CanonicalEvidenceRefreshDecision =
  | { due: true; attempt: number; status: "failed" | "pending"; code: string | null }
  | { due: false; reason: string };

export function canonicalEvidenceRefreshDue(run: RunRecord, events: LabEvent[], now: Date): CanonicalEvidenceRefreshDecision {
  if (!TERMINAL_RUN_STATES.has(run.state) || !run.cleanupComplete) return { due: false, reason: "not_terminal_cleanup_complete" };
  if (run.evidencePurgedAt !== null || run.retentionPurgeVerifiedAt !== null || run.retentionPurgePending) return { due: false, reason: "retention_already_owned" };
  if (localRetentionDeadline(run) <= now) return { due: false, reason: "local_deadline_reached" };
  const latest = [...events].reverse().find((event) => event.kind === "cleanup.recovery" && event.source === "canonical");
  const component = ((latest?.payload.receipt as Record<string, unknown> | undefined)?.components as Record<string, Record<string, unknown>> | undefined)?.canonical_evidence;
  const status = component?.status;
  if (status !== "failed" && status !== "pending") return { due: false, reason: "canonical_evidence_not_failed_or_pending" };
  const attempts = events.filter((event) => event.kind === CANONICAL_EVIDENCE_REFRESH_EVENT && event.source === "worker");
  if (attempts.length >= CANONICAL_EVIDENCE_REFRESH_MAX_ATTEMPTS) return { due: false, reason: "attempts_exhausted" };
  const last = attempts.at(-1);
  if (last && last.at.getTime() + CANONICAL_EVIDENCE_REFRESH_BASE_BACKOFF_MS * 2 ** (attempts.length - 1) > now.getTime()) return { due: false, reason: "backoff" };
  return { due: true, attempt: attempts.length + 1, status, code: typeof component?.code === "string" ? component.code : null };
}
