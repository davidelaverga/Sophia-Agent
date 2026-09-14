import { z } from "zod";
import type { LabEvent, RunRecord } from "./domain.js";
import { deriveExecutionEpochCleanupProof } from "./execution-cleanup.js";
import { deriveExecutionOwnership, parseExecutionOwnership } from "./execution-ownership.js";
import { executionMatchesRecoveryAllocation, type RecoveryControlRecord } from "./recovery-control.js";
import { canonicalRequestHash, sha256 } from "./security.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const BrowserProcessTerminationSchema = z.object({
  schema: z.literal("sophia_voice_lab_browser_process_termination_v1"),
  run_id_sha256: hash, test_run_id_sha256: hash, cleanup_obligation_id_sha256: hash,
  provider_session_id_sha256: hash, provider_connection_epoch: positive,
  execution_ownership_sha256: hash, process_id_sha256: hash, browser_boot_id_sha256: hash,
  execution_epoch_sha256: hash, worker_id_sha256: hash, browser_lease_epoch: positive,
  process_acquired_seq: positive, runtime_acquired_seq: positive, process_closed_seq: positive,
  process_closed_at: z.string().datetime().refine(value => new Date(value).toISOString() === value),
  process_closed_event_sha256: hash,
  one_process_per_run: z.literal(true), browser_process_disconnected: z.literal(true),
  browser_registry_absent: z.literal(true), receipt_sha256: hash,
}).strict().superRefine((value, ctx) => {
  const { receipt_sha256, ...core } = value;
  if (canonicalRequestHash(core) !== receipt_sha256
    || value.process_acquired_seq >= value.runtime_acquired_seq
    || value.runtime_acquired_seq >= value.process_closed_seq) ctx.addIssue({ code: "custom", message: "Process termination digest or order mismatch" });
});
export type BrowserProcessTermination = z.infer<typeof BrowserProcessTerminationSchema>;

/** Internal worker recovery evidence, never accepted as an installed-tool input.
 * Proves only the exact run-owned browser process has terminated. Provider,
 * auth, Builder and whole-resource settlement still require owning callbacks.
 */
export function deriveBrowserProcessTermination(
  run: RunRecord, control: RecoveryControlRecord, events: LabEvent[], browserPresent: boolean,
): BrowserProcessTermination | null {
  if (browserPresent || run.scenarioId === "V-D02" || control.binding.scenarioId === "V-D02"
    || run.id !== control.binding.runId || run.testRunId !== control.binding.testRunId
    || run.cleanupObligationId !== control.binding.cleanupObligationId
    || !run.providerSessionId || !run.providerEpoch || !control.executionOwnership) return null;
  try {
    const ownership = deriveExecutionOwnership(run, events);
    if (canonicalRequestHash(ownership) !== canonicalRequestHash(parseExecutionOwnership(control.executionOwnership))) return null;
    const proof = deriveExecutionEpochCleanupProof(run, events);
    if ((!proof.ready && proof.reason !== "provider_or_auth_cleanup_unconfirmed")
      || !executionMatchesRecoveryAllocation(control, proof)) return null;
    const close = events.find(event => event.seq === proof.eventSeqs.processClosed);
    const acquired = events.find(event => event.seq === proof.eventSeqs.processAcquired);
    const runtime = events.find(event => event.seq === proof.eventSeqs.runtimeAcquired);
    if (!close || !acquired || !runtime || acquired.at > runtime.at || runtime.at > close.at
      || close.at < run.createdAt || close.at.getTime() > Date.now() + 5000) return null;
    const core = {
      schema: "sophia_voice_lab_browser_process_termination_v1" as const,
      run_id_sha256: sha256(run.id), test_run_id_sha256: sha256(run.testRunId),
      cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
      provider_session_id_sha256: sha256(run.providerSessionId), provider_connection_epoch: run.providerEpoch,
      execution_ownership_sha256: ownership.proofSha256, process_id_sha256: ownership.processIdSha256,
      browser_boot_id_sha256: ownership.browserBootIdSha256, execution_epoch_sha256: ownership.executionEpochSha256,
      worker_id_sha256: ownership.workerIdSha256, browser_lease_epoch: ownership.browserLeaseEpoch,
      process_acquired_seq: acquired.seq, runtime_acquired_seq: runtime.seq, process_closed_seq: close.seq,
      process_closed_at: close.at.toISOString(), process_closed_event_sha256: canonicalRequestHash(close.payload),
      one_process_per_run: true as const, browser_process_disconnected: true as const, browser_registry_absent: true as const,
    };
    return BrowserProcessTerminationSchema.parse({ ...core, receipt_sha256: canonicalRequestHash(core) });
  } catch { return null; }
}
