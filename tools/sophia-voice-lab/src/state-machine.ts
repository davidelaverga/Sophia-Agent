import { TERMINAL_RUN_STATES, VoiceLabError, labError, type RunRecord, type RunState } from "./domain.js";
import type { RunPatch, VoiceLabLedger } from "./ledger.js";

const TRANSITIONS: Readonly<Record<RunState, ReadonlySet<RunState>>> = {
  reserved: new Set(["validating_target", "cancelled", "expired", "authorization_failed"]),
  validating_target: new Set(["browser_queued", "exporting", "deployment_mismatch", "authorization_failed", "failed_harness", "cancelled"]),
  browser_queued: new Set(["browser_leased", "failed_harness", "expired", "cancelled"]),
  browser_leased: new Set(["authenticating", "aborted_driver_restart", "failed_harness", "cancelled"]),
  authenticating: new Set(["opening_app", "authorization_failed", "failed_harness", "cancelled"]),
  opening_app: new Set(["ready", "failed_harness", "product_failed", "cancelled"]),
  ready: new Set(["active", "ending", "failed_harness", "product_failed", "inconclusive_provider", "expired", "cancelled", "aborted_driver_restart"]),
  active: new Set(["ending", "failed_harness", "product_failed", "inconclusive_provider", "expired", "cancelled", "aborted_driver_restart"]),
  ending: new Set(["finalizing", "failed_harness", "product_failed", "aborted_driver_restart"]),
  finalizing: new Set(["exporting", "product_failed", "inconclusive_provider", "failed_harness"]),
  exporting: new Set(["pending_external_evidence", "completed", "product_failed", "failed_harness", "authorization_failed", "inconclusive_provider"]),
  pending_external_evidence: new Set(["completed", "product_failed", "failed_harness", "authorization_failed", "inconclusive_provider"]),
  completed: new Set(),
  product_failed: new Set(),
  invalid_test: new Set(),
  inconclusive_provider: new Set(),
  failed_harness: new Set(),
  authorization_failed: new Set(),
  deployment_mismatch: new Set(),
  aborted_driver_restart: new Set(),
  expired: new Set(),
  cancelled: new Set(),
};

export function assertTransition(from: RunState, to: RunState): void {
  if (from === to) return;
  if (!TRANSITIONS[from].has(to)) {
    throw new VoiceLabError(labError("INVALID_RUN_TRANSITION", `Run cannot transition from ${from} to ${to}.`, "conflict", false, { from, to }));
  }
}

export async function transitionRun(ledger: VoiceLabLedger, run: RunRecord, state: RunState, patch: Omit<RunPatch, "state"> = {}): Promise<RunRecord> {
  assertTransition(run.state, state);
  return ledger.updateRun(run.id, run.version, { ...patch, state });
}

export function assertRunAcceptsOperation(run: RunRecord, operation: "speak" | "barge_in" | "force_socket_rotation" | "end"): void {
  if (TERMINAL_RUN_STATES.has(run.state)) throw new VoiceLabError(labError("RUN_TERMINAL", `Run is already terminal in state ${run.state}.`, "conflict"));
  if (operation === "end") {
    if (!["ready", "active", "ending", "finalizing", "exporting"].includes(run.state)) throw new VoiceLabError(labError("RUN_NOT_READY", `Run in state ${run.state} cannot end yet.`, "conflict", true));
    return;
  }
  if (!["ready", "active"].includes(run.state)) throw new VoiceLabError(labError("RUN_NOT_READY", `Run in state ${run.state} cannot accept ${operation}.`, "conflict", true));
}
