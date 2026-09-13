import { z } from "zod";
import type { LabEvent, RunRecord } from "./domain.js";
import { canonicalRequestHash, sha256 } from "./security.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const coreSchema = z.object({
  schema: z.literal("sophia.voice-lab.execution-ownership.v1"),
  runIdSha256: digest, cleanupObligationIdSha256: digest,
  processIdSha256: digest, browserBootIdSha256: digest, executionEpochSha256: digest,
  workerIdSha256: digest, browserLeaseEpoch: positive,
  processAcquiredSeq: positive, runtimeAcquiredSeq: positive,
}).strict().refine(value => value.runtimeAcquiredSeq > value.processAcquiredSeq);
export type ExecutionOwnership = z.infer<typeof coreSchema> & { proofSha256: string };

/** Retained proof ordinals must address one unambiguous ledger event each. */
export function executionEventSequencesValid(events: ReadonlyArray<Pick<LabEvent, "seq">>): boolean {
  return events.every(event => Number.isSafeInteger(event.seq) && event.seq > 0)
    && new Set(events.map(event => event.seq)).size === events.length;
}

export function parseExecutionOwnership(input: unknown): ExecutionOwnership {
  const { proofSha256, ...core } = z.object({ proofSha256: digest }).passthrough().parse(input);
  const parsed = coreSchema.parse(core);
  if (canonicalRequestHash(parsed) !== proofSha256) throw new Error("Execution ownership digest mismatch");
  return { ...parsed, proofSha256 };
}

/** Ownership only, never process-death, provider cleanup or resource-zero proof. */
export function deriveExecutionOwnership(run: Pick<RunRecord, "id" | "cleanupObligationId">, events: LabEvent[]): ExecutionOwnership {
  if (events.some(event => event.runId !== run.id)) throw new Error("Execution ownership event run binding mismatch");
  if (!executionEventSequencesValid(events)) throw new Error("Execution ownership event sequence invalid");
  const acquisitions = events.filter(e => e.kind === "harness.browser_process_acquired" && e.source === "browser");
  const runtimes = events.filter(e => e.kind === "harness.browser_runtime_acquired" && e.source === "canonical");
  if (acquisitions.length !== 1 || runtimes.length !== 1) throw new Error("Exact execution acquisition pair required");
  const acquired = acquisitions[0]!;
  const runtime = runtimes[0]!;
  const p = acquired.payload;
  if (p.schema !== "sophia_voice_lab_browser_process_ownership_v1" || p.one_process_per_run !== true || p.raw_process_id_excluded !== true
    || p.voice_lab_run_id_sha256 !== sha256(run.id) || p.cleanup_obligation_id_sha256 !== sha256(run.cleanupObligationId)) throw new Error("Execution ownership run binding mismatch");
  const core = coreSchema.parse({ schema: "sophia.voice-lab.execution-ownership.v1",
    runIdSha256: sha256(run.id), cleanupObligationIdSha256: sha256(run.cleanupObligationId),
    processIdSha256: p.process_id_sha256, browserBootIdSha256: p.browser_boot_id_sha256,
    executionEpochSha256: p.execution_epoch_sha256, workerIdSha256: runtime.payload.worker_id_sha256,
    browserLeaseEpoch: runtime.payload.browser_lease_epoch, processAcquiredSeq: acquired.seq, runtimeAcquiredSeq: runtime.seq });
  return { ...core, proofSha256: canonicalRequestHash(core) };
}
