import type { LabEvent } from "../domain.js";
import { canonicalJson } from "./contract.js";

/**
 * Certification of a G7 voice step from the exchange's calls (A15
 * getExchangeCalls, docs/plans/voice-qualification-g7.md "The calls that
 * made each step").
 *
 * The product records each voice tool call of the grant's principal in an
 * exchange opened under the grant, links to it only the command the
 * transaction inserted for that call, and answers it (`answeredAt`, set only
 * once anything it admitted committed; `outcome`). A read carries `readAt`;
 * given back verbatim as `after`, only calls whose recording began after that
 * read are listed, so a call already on its way at that read (inserted but not
 * yet committed, which a `seq` baseline would wrongly admit) never is.
 *
 * The worker, for each voice step:
 * 1. once the previous step settled (its reply ended, and its own calls read
 *    `?after=` its baseline until every one is answered), reads the calls
 *    until every listed call is answered and keeps `readAt` as the step's
 *    baseline, durable before the step's write-ahead (a retry keeps the
 *    first);
 * 2. after the step (before the next step's baseline, or at End) reads
 *    `?after=<baseline readAt>` until every listed call is answered.
 * A step passes only if, in that after-read, every call is answered and
 * exactly one carries a command, of the step's kind and target, with the
 * expected outcome: `native_task` with its task, answered `admitted`, for
 * create (the task naming the run's ownership-proven exchange in the
 * snapshot), and likewise for the Stop sub-episode's own create on a task
 * and goal of its own; `steer`, `hold`, `resume` on the created task's goal
 * and `stop` on the sub-episode's goal (never without the sub-episode's
 * certified create), answered `ok`. Its state is not denied, superseded or outcome_unknown; its
 * id was never certified by an earlier step; hold, resume and stop (which
 * take a new authority epoch; a steer does not) carry an epoch above the
 * previous of those on their goal; hold and resume see the status match on
 * a task of the created task's goal, Stop on its own live target, in the
 * step's own observation.
 *
 * Anything else is never a pass: an unsettled read, no new call, an
 * unanswered call, no command or more than one, another kind, goal or
 * outcome, a repeated command, or a task or command seen only elsewhere
 * (another exchange, or the principal's own HTTP request, which the product
 * never lists). A read the product refused (422 `not_found` or
 * `invalid_request`) or does not serve (404: voice qualification off) is
 * typed unavailable. `readAt` is never parsed into a time here.
 */
export const STUDIO_CALLS_READ_KIND = "studio.exchange.calls_read" as const;
export const STUDIO_CALLS_READ_SCHEMA = "sophia_voice_lab_studio_exchange_calls_v1" as const;
/** The step id of End's read of every call (a baseline of no step: it bounds the last step's window and lists every later call). */
export const STUDIO_CALLS_END_STEP = "final" as const;

/**
 * The Stop sub-episode's own create: a second, bounded voice-created task of
 * the run's own, distinct from the episode's create (its own task and goal),
 * whose work Stop then ends. Steer, hold and resume join the episode's create;
 * Stop joins only this one: without it, Stop is `stop_target_not_certified`.
 */
export const STUDIO_STOP_TARGET_STEP = "g7.create_stop_target" as const;
const CREATE_STEPS: ReadonlySet<string> = new Set(["g7.create", STUDIO_STOP_TARGET_STEP]);

export const STUDIO_VOICE_STEP_COMMAND_KIND: Readonly<Record<string, string>> = Object.freeze({
  "g7.create": "native_task", [STUDIO_STOP_TARGET_STEP]: "native_task", "g7.steer": "steer", "g7.hold": "hold", "g7.resume": "resume", "g7.stop": "stop",
});
/** The outcome each step's command must be answered with. */
export const STUDIO_VOICE_STEP_OUTCOME: Readonly<Record<string, string>> = Object.freeze({
  "g7.create": "admitted", [STUDIO_STOP_TARGET_STEP]: "admitted", "g7.steer": "ok", "g7.hold": "ok", "g7.resume": "ok", "g7.stop": "ok",
});
/** A task state or phase that says its work already ended (nothing left for a control to act on). */
const ENDED_TASK_STATES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "outcome_unknown"]);
const ENDED_TASK_PHASES: ReadonlySet<string> = new Set(["stopping", "stopped", "denied", "failed", "outcome_unknown", "result_ready"]);
/** Steps whose command takes a new authority epoch (a steer does not). */
const EPOCH_STEPS: ReadonlySet<string> = new Set(["g7.hold", "g7.resume", "g7.stop"]);
/** Outcomes that say the product refused or failed the step's call. */
const FAILING_OUTCOMES: ReadonlySet<string> = new Set(["refused", "error", "denied", "conflict"]);
/** The created task's status in the snapshot that shows each control's effect. */
export const STUDIO_VOICE_STEP_GOAL_STATUS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "g7.hold": ["holding", "held"], "g7.resume": ["running"], "g7.stop": ["stopping", "stopped"],
});
const UNCERTIFIABLE_STATES: ReadonlySet<string> = new Set(["denied", "superseded", "outcome_unknown"]);

type Event = Pick<LabEvent, "kind" | "source" | "seq" | "payload">;

interface RecordedCommand { command_id: string; kind: string; goal_id: string | null; authority_epoch: number | null; goal_revision: number | null; state: string }
interface RecordedCall { seq: number; tool: string; input_epoch: number; task_id: string | null; answered_at: string | null; outcome: string | null; command: RecordedCommand | null }

export interface StudioStepCertification {
  step_id: string;
  operation_id: string;
  outcome: "pass" | "fail" | "uncertain" | "unavailable";
  reason: string | null;
  /** The baseline read's readAt, exactly as the product sent it. */
  baseline_read_at: string | null;
  candidate_seqs: number[];
  call_outcome: string | null;
  command_id: string | null;
  command_kind: string | null;
  goal_id: string | null;
  authority_epoch: number | null;
  task_id: string | null;
  /** Ledger seqs of the reads (and observation) the decision rests on. */
  evidence_seqs: number[];
}

export interface StudioCallsCertification {
  steps: StudioStepCertification[];
  /**
   * Command-bearing calls some read listed that fall in no step's window
   * (made between a step's window read and the next baseline, or before the
   * first): the run's calls are then not all accounted for.
   */
  unattributed_seqs: number[];
  /** The task the certified create step made, and its goal; null unless certified. */
  createdTaskId: string | null;
  createdGoalId: string | null;
  /** The Stop sub-episode's own certified task and goal (STUDIO_STOP_TARGET_STEP); null unless certified. */
  stopTargetTaskId: string | null;
  stopTargetGoalId: string | null;
  /** Whether any read of the calls was answered (false: the product never served it to the principal). */
  answered: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function callsOf(event: Event): RecordedCall[] {
  return (Array.isArray(event.payload.calls) ? event.payload.calls as unknown[] : []).flatMap((value) => {
    const call = record(value);
    if (!call || typeof call.seq !== "number" || typeof call.tool !== "string" || typeof call.input_epoch !== "number") return [];
    const command = record(call.command);
    return [{
      seq: call.seq, tool: call.tool, input_epoch: call.input_epoch, task_id: typeof call.task_id === "string" ? call.task_id : null,
      answered_at: typeof call.answered_at === "string" ? call.answered_at : null, outcome: typeof call.outcome === "string" ? call.outcome : null,
      command: command && typeof command.command_id === "string" && typeof command.kind === "string" && typeof command.state === "string" ? {
        command_id: command.command_id, kind: command.kind, state: command.state,
        goal_id: typeof command.goal_id === "string" ? command.goal_id : null,
        authority_epoch: typeof command.authority_epoch === "number" ? command.authority_epoch : null,
        goal_revision: typeof command.goal_revision === "number" ? command.goal_revision : null,
      } : null,
    }];
  });
}

/**
 * The parts of an answered entry that never change (a command's state may
 * progress). An unanswered entry may still gain its command, so only answered
 * entries are compared.
 */
function stableIdentity(call: RecordedCall): string {
  return canonicalJson({ seq: call.seq, tool: call.tool, input_epoch: call.input_epoch, task_id: call.task_id, outcome: call.outcome, command: call.command ? { ...call.command, state: null } : null });
}

/**
 * A step's own window read, as certification selects it: after its baseline
 * (available, of the run's exchange, with a readAt), its after-reads with
 * `after` = that readAt taken before any later baseline; the window is the
 * first of them answered for the run's exchange and settled.
 */
function ownWindow(reads: ReadonlyArray<Event>, baseline: Event, operationId: string, readAt: string, runExchange: string | null): { stepReads: Event[]; after: Event[]; window: Event | null } {
  const upper = reads.find((event) => event.payload.purpose === "baseline" && event.seq > baseline.seq)?.seq ?? Number.MAX_SAFE_INTEGER;
  const stepReads = reads.filter((event) => event.payload.purpose === "after" && event.payload.operation_id === operationId && event.payload.after === readAt && event.seq > baseline.seq && event.seq < upper);
  const after = stepReads.filter((event) => event.payload.status === "available" && typeof event.payload.exchange_id === "string" && event.payload.exchange_id.toLowerCase() === runExchange);
  return { stepReads, after, window: after.find((event) => event.payload.settled === true) ?? null };
}

/**
 * Each voice step's own calls (its own settled window read, as
 * certifyStudioVoiceSteps selects it): how many calls it lists and whether
 * one carries a command; null when the step has no such read. The evaluator
 * cross-checks the ordinal join of the bridge's input windows with them.
 */
export function studioStepOwnCalls(events: ReadonlyArray<Event>, steps: ReadonlyArray<{ operationId: string }>, runExchangeId: string | null): Map<string, { calls: number; commandBearing: boolean } | null> {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const runExchange = runExchangeId?.toLowerCase() ?? null;
  const reads = ordered.filter((event) => event.kind === STUDIO_CALLS_READ_KIND && event.source === "canonical");
  return new Map(steps.map((step) => {
    const baseline = reads.find((event) => event.payload.purpose === "baseline" && event.payload.operation_id === step.operationId) ?? null;
    const readAt = baseline !== null && typeof baseline.payload.read_at === "string" ? baseline.payload.read_at : null;
    if (runExchange === null || baseline === null || readAt === null || baseline.payload.status !== "available" || baseline.payload.settled !== true
      || typeof baseline.payload.exchange_id !== "string" || baseline.payload.exchange_id.toLowerCase() !== runExchange) return [step.operationId, null];
    const { window } = ownWindow(reads, baseline, step.operationId, readAt, runExchange);
    if (window === null) return [step.operationId, null];
    const calls = callsOf(window);
    return [step.operationId, { calls: calls.length, commandBearing: calls.some((call) => call.command !== null) }];
  }));
}

type CertificationInput = {
  events: ReadonlyArray<Event>;
  /** The run's voice-step operations: id and G7 step id. */
  steps: ReadonlyArray<{ operationId: string; stepId: string }>;
  /** The run's joined exchange, and whether its ownership is proven. */
  runExchangeId: string | null;
  ownershipProven: boolean;
  /** The input epoch the principal held for each step (its input window's bridge receipt); null when unknown. */
  stepInputEpochs: ReadonlyMap<string, number | null>;
};

/** The run-wide state certification reads and the chain it builds, step by step in baseline order. */
interface CertificationContext {
  input: CertificationInput;
  runExchange: string | null;
  reads: Event[];
  answeredReads: Event[];
  observations: Event[];
  /** Answered entries two reads show differently (apart from a command's state). */
  conflicting: Set<number>;
  certifiedCommands: Set<string>;
  /** Authority epochs rise per goal (the sub-episode's goal has its own). */
  lastControlEpoch: Map<string, number>;
  /** Every call each step's window read listed. */
  windowSeqs: Set<number>;
  createdTaskId: string | null;
  createdGoalId: string | null;
  stopTargetTaskId: string | null;
  stopTargetGoalId: string | null;
}

type Settled = { outcome: StudioStepCertification["outcome"]; reason: string | null };
const settled = (outcome: Settled["outcome"], reason: string | null): Settled => ({ outcome, reason });
type TaskSighting = { event: Event; task: Record<string, unknown> };

export function certifyStudioVoiceSteps(input: CertificationInput): StudioCallsCertification {
  const ordered = [...input.events].sort((left, right) => left.seq - right.seq);
  const runExchange = input.runExchangeId?.toLowerCase() ?? null;
  const reads = ordered.filter((event) => event.kind === STUDIO_CALLS_READ_KIND && event.source === "canonical");
  const answeredReads = reads.filter((event) => event.payload.status === "available" && typeof event.payload.exchange_id === "string" && event.payload.exchange_id.toLowerCase() === runExchange);
  const ctx: CertificationContext = {
    input, runExchange, reads, answeredReads,
    observations: ordered.filter((event) => event.kind === "studio.outcome.observed" && event.source === "canonical"),
    conflicting: conflictingCallSeqs(answeredReads),
    certifiedCommands: new Set<string>(), lastControlEpoch: new Map<string, number>(), windowSeqs: new Set<number>(),
    createdTaskId: null, createdGoalId: null, stopTargetTaskId: null, stopTargetGoalId: null,
  };
  // Each step's baseline: its FIRST baseline read (a re-executed operation keeps it).
  const baselines = input.steps.map((step) => ({ step, baseline: reads.find((event) => event.payload.purpose === "baseline" && event.payload.operation_id === step.operationId) ?? null }));
  const ordering = [...baselines].sort((left, right) => (left.baseline?.seq ?? Number.MAX_SAFE_INTEGER) - (right.baseline?.seq ?? Number.MAX_SAFE_INTEGER));
  const results = new Map<string, StudioStepCertification>();
  for (const { step, baseline } of ordering) {
    const result: StudioStepCertification = { step_id: step.stepId, operation_id: step.operationId, outcome: "unavailable", reason: null, baseline_read_at: null, candidate_seqs: [], call_outcome: null, command_id: null, command_kind: null, goal_id: null, authority_epoch: null, task_id: null, evidence_seqs: [] };
    results.set(step.operationId, result);
    const verdict = certifyVoiceStep(ctx, step, baseline, result);
    result.outcome = verdict.outcome;
    result.reason = verdict.reason;
  }
  // A command-bearing call a later read listed (a baseline, or the End read)
  // that no step's window holds was never examined by any step.
  const bearing = new Set(answeredReads.flatMap(callsOf).filter((call) => call.command !== null).map((call) => call.seq));
  const unattributed = [...bearing].filter((seq) => !ctx.windowSeqs.has(seq)).sort((left, right) => left - right);
  return {
    steps: input.steps.map((step) => results.get(step.operationId)!),
    unattributed_seqs: unattributed,
    createdTaskId: ctx.createdTaskId,
    createdGoalId: ctx.createdGoalId,
    stopTargetTaskId: ctx.stopTargetTaskId,
    stopTargetGoalId: ctx.stopTargetGoalId,
    answered: answeredReads.length > 0,
  };
}

/**
 * A recorded entry that two reads show differently (apart from its
 * command's progressing state) is not one stable call: it certifies nothing.
 */
function conflictingCallSeqs(answeredReads: ReadonlyArray<Event>): Set<number> {
  const identities = new Map<number, string>();
  const conflicting = new Set<number>();
  for (const read of answeredReads) for (const call of callsOf(read)) {
    if (call.answered_at === null) continue;
    const identity = stableIdentity(call);
    const prior = identities.get(call.seq);
    if (prior !== undefined && prior !== identity) conflicting.add(call.seq);
    identities.set(call.seq, identity);
  }
  return conflicting;
}

/** One voice step, in baseline order: its baseline, its own window, its one command-bearing call, then its effect. */
function certifyVoiceStep(ctx: CertificationContext, step: { operationId: string; stepId: string }, baseline: Event | null, result: StudioStepCertification): Settled {
  const expectedKind = STUDIO_VOICE_STEP_COMMAND_KIND[step.stepId];
  if (!expectedKind) return settled("unavailable", "not_a_voice_step");
  const gate = stepBaselineGate(ctx, baseline, result);
  if (gate !== null) return gate;
  const window = stepWindowCall(ctx, step, baseline!, result);
  if ("outcome" in window) return window;
  const { call, command } = window;
  const rejected = stepCommandGate(ctx, step.stepId, expectedKind, call, command, window.window);
  if (rejected !== null) return rejected;
  // The snapshot's view of the run's task, seen after this step's baseline and before the next step.
  const upper = ctx.reads.find((event) => event.payload.purpose === "baseline" && event.seq > baseline!.seq)?.seq ?? Number.MAX_SAFE_INTEGER;
  const stepObservations = ctx.observations.filter((event) => event.seq > baseline!.seq && event.seq <= upper);
  const later = ctx.observations.filter((event) => event.seq > upper);
  if (CREATE_STEPS.has(step.stepId)) return certifyCreateStep(ctx, step.stepId, call, command, latestTaskSighting([...stepObservations, ...later], call.task_id), result);
  return certifyControlStep(ctx, step.stepId, command, baseline!, stepObservations, result);
}

/** The step's baseline: of the run's proven exchange, available, well formed and settled. */
function stepBaselineGate(ctx: CertificationContext, baseline: Event | null, result: StudioStepCertification): Settled | null {
  if (ctx.runExchange === null) return settled("unavailable", "no_exchange_joined_to_run");
  if (!ctx.input.ownershipProven) return settled("unavailable", "run_exchange_ownership_unproven");
  if (!baseline) return settled("unavailable", "no_calls_baseline");
  result.evidence_seqs.push(baseline.seq);
  if (baseline.payload.status !== "available") return settled("unavailable", `calls_baseline_${String(baseline.payload.reason ?? "unavailable")}`);
  if (typeof baseline.payload.exchange_id !== "string" || baseline.payload.exchange_id.toLowerCase() !== ctx.runExchange) return settled("unavailable", "calls_baseline_not_of_run_exchange");
  const readAt = typeof baseline.payload.read_at === "string" ? baseline.payload.read_at : null;
  if (readAt === null) return settled("unavailable", "calls_baseline_malformed");
  result.baseline_read_at = readAt;
  // The baseline is taken only once every call listed so far was answered.
  if (baseline.payload.settled !== true) return settled("uncertain", "calls_baseline_unsettled");
  return null;
}

/** A command-bearing call one read of the window listed and a later read of the same window no longer lists. */
function windowEntryDropped(after: ReadonlyArray<Event>): boolean {
  for (const [position, earlier] of after.entries()) {
    for (const later of after.slice(position + 1)) {
      const listed = new Set(callsOf(later).map((call) => call.seq));
      if (callsOf(earlier).some((call) => call.command !== null && !listed.has(call.seq))) return true;
    }
  }
  return false;
}

/**
 * The step's own window: its own settled read with after = this baseline's
 * readAt (verbatim), taken before any later voice step's baseline (of any
 * operation, performed or not). That read's readAt bounds the window; the
 * next step's baseline never does. Its calls: none listed at the baseline,
 * all stable and answered, all at the step's input epoch, exactly one
 * bearing a command.
 */
function stepWindowCall(ctx: CertificationContext, step: { operationId: string; stepId: string }, baseline: Event, result: StudioStepCertification): Settled | { window: Event; call: RecordedCall; command: RecordedCommand } {
  const { stepReads, after, window } = ownWindow(ctx.reads, baseline, step.operationId, result.baseline_read_at!, ctx.runExchange);
  if (after.length === 0) {
    const refused = stepReads.at(-1);
    return settled("unavailable", refused ? `calls_after_${String(refused.payload.reason ?? "unavailable")}` : "no_calls_read_after_step");
  }
  if (window === null) return settled("uncertain", "call_unanswered");
  result.evidence_seqs.push(window.seq);
  for (const call of callsOf(window)) ctx.windowSeqs.add(call.seq);
  if (windowEntryDropped(after)) return settled("uncertain", "calls_entry_conflict");
  const candidates = callsOf(window);
  // Defensive: an entry the baseline already listed is never the step's.
  const listedAtBaseline = new Set(callsOf(baseline).map((call) => call.seq));
  if (candidates.some((call) => listedAtBaseline.has(call.seq))) return settled("uncertain", "call_listed_at_baseline");
  result.candidate_seqs = candidates.map((call) => call.seq);
  if (candidates.some((call) => ctx.conflicting.has(call.seq))) return settled("uncertain", "calls_entry_conflict");
  if (candidates.length === 0) return settled("uncertain", "no_call_after_baseline");
  // Every call in the window answered; one still unanswered is never a pass.
  if (candidates.some((call) => call.answered_at === null)) return settled("uncertain", "call_unanswered");
  // Every call in the window made at the input epoch the principal held for this step.
  const stepEpoch = ctx.input.stepInputEpochs.get(step.operationId) ?? null;
  if (stepEpoch === null) return settled("uncertain", "step_input_epoch_unknown");
  if (candidates.some((call) => call.input_epoch !== stepEpoch)) return settled("uncertain", "call_input_epoch_mismatch");
  const bearing = candidates.filter((call) => call.command !== null);
  if (bearing.length === 0) return settled("uncertain", "call_admitted_no_command");
  if (bearing.length > 1) return settled("uncertain", "multiple_command_bearing_calls");
  const call = bearing[0]!;
  const command = call.command!;
  Object.assign(result, { command_id: command.command_id, command_kind: command.kind, goal_id: command.goal_id, authority_epoch: command.authority_epoch, task_id: call.task_id, call_outcome: call.outcome });
  return { window, call, command };
}

/** The call's command: of the step's kind, answered as the step expects, not yet certified, not denied or of unknown outcome, then or later. */
function stepCommandGate(ctx: CertificationContext, stepId: string, expectedKind: string, call: RecordedCall, command: RecordedCommand, window: Event): Settled | null {
  if (command.kind !== expectedKind) return settled("fail", "command_kind_mismatch");
  const expectedOutcome = STUDIO_VOICE_STEP_OUTCOME[stepId]!;
  if (call.outcome !== expectedOutcome) return settled(call.outcome !== null && FAILING_OUTCOMES.has(call.outcome) ? "fail" : "uncertain", `call_outcome_${String(call.outcome)}`);
  if (ctx.certifiedCommands.has(command.command_id)) return settled("uncertain", "command_already_certified");
  if (command.state === "denied") return settled("fail", "command_denied");
  if (UNCERTIFIABLE_STATES.has(command.state)) return settled("uncertain", `command_${command.state}`);
  // The command's state as every LATER answered read shows it: denied, or of
  // unknown outcome, after the window is never a pass.
  const laterStates = new Set(ctx.answeredReads.filter((event) => event.seq > window.seq).flatMap(callsOf)
    .filter((later) => later.command !== null && later.command.command_id === command.command_id).map((later) => later.command!.state));
  if (laterStates.has("denied")) return settled("fail", "command_denied_later");
  if (laterStates.has("outcome_unknown")) return settled("uncertain", "command_outcome_unknown_later");
  return null;
}

/** Every task an observation lists, with the observation. */
function taskSightings(events: ReadonlyArray<Event>): TaskSighting[] {
  return events.flatMap((event) => (Array.isArray(event.payload.tasks) ? event.payload.tasks as unknown[] : []).map((value) => ({ event, task: record(value) ?? {} })));
}

/** The latest sighting of `taskId` in `observations` (the step's own, then later ones), or null. */
function latestTaskSighting(observations: ReadonlyArray<Event>, taskId: string | null): TaskSighting | null {
  if (taskId === null) return null;
  return taskSightings([...observations].reverse()).find((item) => item.task.task_id === taskId) ?? null;
}

/** A create (the episode's, or the Stop sub-episode's own): its task bound to the run's exchange, on its command's goal. */
function certifyCreateStep(ctx: CertificationContext, stepId: string, call: RecordedCall, command: RecordedCommand, seen: TaskSighting | null, result: StudioStepCertification): Settled {
  if (call.task_id === null) return settled("uncertain", "create_command_without_task");
  if (seen === null || typeof seen.task.exchange_id !== "string") return settled("uncertain", "created_task_exchange_unconfirmed");
  result.evidence_seqs.push(seen.event.seq);
  if (seen.task.exchange_id.toLowerCase() !== ctx.runExchange) return settled("fail", "created_task_bound_to_another_exchange");
  const taskGoal = typeof seen.task.goal_id === "string" ? seen.task.goal_id : null;
  if (taskGoal !== null && command.goal_id !== null && taskGoal !== command.goal_id) return settled("fail", "create_goal_mismatch");
  const goal = taskGoal ?? command.goal_id;
  if (goal === null) return settled("uncertain", "created_task_goal_unknown");
  if (stepId === STUDIO_STOP_TARGET_STEP) {
    // Explicit, distinct joins: the sub-episode's own task and goal, never the episode's.
    if (ctx.createdTaskId === null) return settled("uncertain", "create_step_not_certified");
    if (call.task_id === ctx.createdTaskId || goal === ctx.createdGoalId) return settled("uncertain", "stop_target_not_distinct");
    ctx.certifiedCommands.add(command.command_id);
    ctx.stopTargetTaskId = call.task_id;
    ctx.stopTargetGoalId = goal;
    return settled("pass", null);
  }
  ctx.certifiedCommands.add(command.command_id);
  ctx.createdTaskId = call.task_id;
  ctx.createdGoalId = goal;
  return settled("pass", null);
}

/**
 * A control (steer, hold, resume, stop) on its target: the episode's created
 * task, or for Stop the sub-episode's own; a new authority epoch where the
 * step takes one; Stop only on work still live before it; then the step's
 * goal status.
 */
function certifyControlStep(ctx: CertificationContext, stepId: string, command: RecordedCommand, baseline: Event, stepObservations: Event[], result: StudioStepCertification): Settled {
  const target = controlTarget(ctx, stepId);
  if ("outcome" in target) return target;
  const { taskId: targetTaskId, goalId: targetGoalId } = target;
  if (command.goal_id !== targetGoalId) return settled("fail", "command_goal_mismatch");
  // Hold, resume and stop take a new authority epoch on their goal; a steer does not.
  const takesEpoch = EPOCH_STEPS.has(stepId);
  const priorEpoch = ctx.lastControlEpoch.get(targetGoalId) ?? null;
  if (takesEpoch && command.authority_epoch === null) return settled("uncertain", "authority_epoch_missing");
  if (takesEpoch && priorEpoch !== null && command.authority_epoch! <= priorEpoch) return settled("fail", "authority_epoch_not_increasing");
  if (stepId === "g7.stop") {
    const live = stopTargetLiveBeforeStop(ctx, targetTaskId, baseline, result);
    if (live !== null) return live;
  }
  const status = stepGoalStatus(ctx, stepId, targetTaskId, targetGoalId, stepObservations, result);
  if (status !== null) return status;
  ctx.certifiedCommands.add(command.command_id);
  if (takesEpoch) ctx.lastControlEpoch.set(targetGoalId, command.authority_epoch!);
  return settled("pass", null);
}

/**
 * The control's target task and goal. Stop acts only on the Stop
 * sub-episode's own task, certified by its own create before Stop; without
 * one, Stop is never credited on the episode's created task (labrev6
 * Nit-1). Every other control acts on the episode's created task.
 */
function controlTarget(ctx: CertificationContext, stepId: string): Settled | { taskId: string; goalId: string } {
  if (ctx.createdGoalId === null || ctx.createdTaskId === null) return settled("uncertain", "create_step_not_certified");
  if (stepId === "g7.stop" && (ctx.stopTargetTaskId === null || ctx.stopTargetGoalId === null)) return settled("uncertain", "stop_target_not_certified");
  const stopsSubEpisode = stepId === "g7.stop";
  return { taskId: stopsSubEpisode ? ctx.stopTargetTaskId! : ctx.createdTaskId, goalId: stopsSubEpisode ? ctx.stopTargetGoalId! : ctx.createdGoalId };
}

/**
 * Stop is credited only on work still live just before it: the target's
 * latest sighting before Stop's baseline. Never on work already ended.
 */
function stopTargetLiveBeforeStop(ctx: CertificationContext, targetTaskId: string, baseline: Event, result: StudioStepCertification): Settled | null {
  const before = taskSightings(ctx.observations.filter((event) => event.seq < baseline.seq)).filter((item) => item.task.task_id === targetTaskId).at(-1) ?? null;
  if (before === null) return settled("uncertain", "stop_target_not_observed_before_stop");
  result.evidence_seqs.push(before.event.seq);
  if (ENDED_TASK_STATES.has(String(before.task.state)) || ENDED_TASK_PHASES.has(String(before.task.phase))) return settled("uncertain", "stop_target_already_ended");
  return null;
}

/**
 * The step's own observation (its `observe` action) decides; else the
 * first one after the step. A much later observation (e.g. the final read
 * after End) is never this step's effect. Hold and resume act on the goal's
 * live work (the product holds the design under way while the research
 * reads result_ready): a task of the run's goal shows it. Stop is read on
 * its target task.
 */
function stepGoalStatus(ctx: CertificationContext, stepId: string, targetTaskId: string, targetGoalId: string, stepObservations: Event[], result: StudioStepCertification): Settled | null {
  const statuses = STUDIO_VOICE_STEP_GOAL_STATUS[stepId];
  if (!statuses) return null;
  const isStop = stepId === "g7.stop";
  const sightings = taskSightings(stepObservations).filter((item) => isStop ? item.task.task_id === targetTaskId : item.task.goal_id === targetGoalId);
  const own = (items: TaskSighting[]) => items.filter((item) => item.event.payload.purpose === stepId);
  const matching = sightings.filter((item) => statuses.includes(String(item.task.phase)));
  const seen = own(matching).at(-1) ?? own(sightings).at(-1) ?? matching[0] ?? sightings[0] ?? null;
  if (seen === null) return settled("uncertain", "goal_status_not_observed");
  result.evidence_seqs.push(seen.event.seq);
  if (!statuses.includes(String(seen.task.phase))) return settled("uncertain", "goal_status_not_matching_step");
  return isStop ? stopEffectSettled(ctx, targetTaskId, seen, result) : null;
}

/**
 * Stop's target ended by Stop's command, not by anything else (never by a
 * withdrawal of a source it drew on), and its job cancelled for the stop
 * (reason `stopped`), in this or a later observation.
 */
function stopEffectSettled(ctx: CertificationContext, targetTaskId: string, seen: TaskSighting, result: StudioStepCertification): Settled | null {
  const withdrawn = Array.isArray(seen.task.withdrawn_source_ids) ? seen.task.withdrawn_source_ids.length : 0;
  if (withdrawn > 0 || seen.task.reason_class === "revoked_source_withdrawn") return settled("uncertain", "stop_target_ended_by_withdrawal");
  const cancelled = taskSightings(ctx.observations.filter((event) => event.seq >= seen.event.seq))
    .find((item) => item.task.task_id === targetTaskId && item.task.state === "cancelled" && item.task.reason_class === "stopped") ?? null;
  if (cancelled === null) return settled("uncertain", "stop_effect_not_settled");
  if (cancelled.event.seq !== seen.event.seq) result.evidence_seqs.push(cancelled.event.seq);
  return null;
}
