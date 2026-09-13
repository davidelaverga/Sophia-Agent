import { TERMINAL_RUN_STATES } from "./domain.js";

/** Fixed campaign limits shared by submission schema, collector and verifier. */
export const P01_LIMITS = Object.freeze({
  semanticCalls: 10,
  pollsPerOperation: 10,
  pollsTotal: 20,
  pollTimeoutMs: 10_000,
} as const);
export const P01_MAX_CHRONOLOGICAL_CALLS = P01_LIMITS.semanticCalls + P01_LIMITS.pollsTotal;

/** Shared collector/verifier operation-observation topology (zero-based spine indices). */
export const P01_OPERATION_OBSERVATIONS = [
  { mutationIndex: 1, boundaryIndex: 2, settlementAtBoundary: true, waitCondition: "operation_terminal" },
  { mutationIndex: 3, boundaryIndex: 4, settlementAtBoundary: false, waitCondition: "operation_terminal" },
  { mutationIndex: 5, boundaryIndex: 6, settlementAtBoundary: false, waitCondition: "operation_terminal" },
  { mutationIndex: 8, boundaryIndex: 9, settlementAtBoundary: false, waitCondition: "finalization_complete" },
] as const;

/** Assistant-result waits share their speech operation's total polling budget. */
export const P01_ASSISTANT_OBSERVATIONS = [
  { mutationIndex: 3, boundaryIndex: 4 },
  { mutationIndex: 5, boundaryIndex: 6 },
] as const;

export function p01EndNeedsFinalization(data: Record<string, unknown>): boolean {
  return data.operation_state !== "succeeded" || data.cleanup_complete !== true || data.evidence_state !== "available"
    || ![...TERMINAL_RUN_STATES].some((state) => state === data.run_state);
}
