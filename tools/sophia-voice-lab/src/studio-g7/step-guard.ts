import { VoiceLabError, labError, type OperationRecord } from "../domain.js";
import { STUDIO_G7_ACTIONS, studioG7StepId, type StudioG7Action } from "./scenarios.js";

/**
 * "A G7 step is performed at most once in a run", enforced where it cannot
 * race: both ledgers evaluate this inside the same critical section that
 * inserts the operation (the PostgreSQL run row lock; the memory ledger's
 * single synchronous insert), and the worker re-checks it before executing.
 *
 * A voice step is identified by its `_g7_step` label; a non-voice step by its
 * action (rows written before `_g7_step` was recorded on actions included).
 * `observe` is a read, not a step, and may repeat.
 */
type StepOperation = Pick<OperationRecord, "type" | "input">;
type ExistingOperation = Pick<OperationRecord, "id" | "type" | "input" | "state" | "result">;

const IN_FLIGHT = new Set(["accepted", "queued", "leased", "executing"]);

export function studioStepOf(operation: StepOperation): string | null {
  if (operation.type === "speak") return typeof operation.input._g7_step === "string" ? operation.input._g7_step : null;
  if (operation.type !== "studio_action") return null;
  if (typeof operation.input._g7_step === "string") return operation.input._g7_step;
  const action = operation.input.action;
  return typeof action === "string" && (STUDIO_G7_ACTIONS as readonly string[]).includes(action) ? studioG7StepId(action as StudioG7Action) : null;
}

function performed(operation: ExistingOperation): boolean {
  return operation.state === "succeeded" && (operation.type === "speak" || operation.result?.performed === true);
}

/**
 * The conflict a new operation of a step would create, or null. `selfId`
 * excludes the operation being checked (the worker's re-check).
 */
export function studioStepConflict(existing: ReadonlyArray<ExistingOperation>, candidate: StepOperation, selfId: string | null = null, inFlightStates: ReadonlySet<string> = IN_FLIGHT): VoiceLabError | null {
  const step = studioStepOf(candidate);
  if (step === null) return null;
  const same = existing.filter((operation) => operation.id !== selfId && (operation.type === "speak" || operation.type === "studio_action") && studioStepOf(operation) === step);
  if (same.some(performed)) {
    return new VoiceLabError(labError("STUDIO_G7_STEP_ALREADY_PERFORMED", "This G7 step was already performed in this run; it is never performed twice.", "conflict", false, { step_id: step }));
  }
  if (same.some((operation) => inFlightStates.has(operation.state))) {
    return new VoiceLabError(labError("STUDIO_G7_STEP_IN_FLIGHT", "This G7 step already has an operation in flight; inspect it or retry with its idempotency key.", "conflict", true, { step_id: step }));
  }
  return null;
}

/** The worker's re-check: only another operation that is executing (or performed) blocks this one. */
export const STUDIO_STEP_EXECUTING_STATES: ReadonlySet<string> = new Set(["leased", "executing"]);
