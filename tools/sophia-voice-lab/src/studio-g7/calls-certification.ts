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
 * snapshot); `steer`, `hold`, `resume`, `stop` on the created task's goal,
 * answered `ok`. Its state is not denied, superseded or outcome_unknown; its
 * id was never certified by an earlier step; hold, resume and stop (which
 * take a new authority epoch; a steer does not) carry an epoch above the
 * previous of those; hold, resume and stop see the created task's status
 * match in the step's own observation.
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
 * Stop joins this one when the run made it.
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

export function certifyStudioVoiceSteps(input: {
  events: ReadonlyArray<Event>;
  /** The run's voice-step operations: id and G7 step id. */
  steps: ReadonlyArray<{ operationId: string; stepId: string }>;
  /** The run's joined exchange, and whether its ownership is proven. */
  runExchangeId: string | null;
  ownershipProven: boolean;
  /** The input epoch the principal held for each step (its input window's bridge receipt); null when unknown. */
  stepInputEpochs: ReadonlyMap<string, number | null>;
}): StudioCallsCertification {
  const ordered = [...input.events].sort((left, right) => left.seq - right.seq);
  const runExchange = input.runExchangeId?.toLowerCase() ?? null;
  const reads = ordered.filter((event) => event.kind === STUDIO_CALLS_READ_KIND && event.source === "canonical");
  const answeredReads = reads.filter((event) => event.payload.status === "available" && typeof event.payload.exchange_id === "string" && event.payload.exchange_id.toLowerCase() === runExchange);
  const observations = ordered.filter((event) => event.kind === "studio.outcome.observed" && event.source === "canonical");
  // A recorded entry that two reads show differently (apart from its
  // command's progressing state) is not one stable call: it certifies nothing.
  const identities = new Map<number, string>();
  const conflicting = new Set<number>();
  for (const read of answeredReads) for (const call of callsOf(read)) {
    if (call.answered_at === null) continue;
    const identity = stableIdentity(call);
    const prior = identities.get(call.seq);
    if (prior !== undefined && prior !== identity) conflicting.add(call.seq);
    identities.set(call.seq, identity);
  }
  // Each step's baseline: its FIRST baseline read (a re-executed operation keeps it).
  const baselines = input.steps.map((step) => ({ step, baseline: reads.find((event) => event.payload.purpose === "baseline" && event.payload.operation_id === step.operationId) ?? null }));
  const ordering = [...baselines].sort((left, right) => (left.baseline?.seq ?? Number.MAX_SAFE_INTEGER) - (right.baseline?.seq ?? Number.MAX_SAFE_INTEGER));
  const certifiedCommands = new Set<string>();
  let createdTaskId: string | null = null;
  let createdGoalId: string | null = null;
  let stopTargetTaskId: string | null = null;
  let stopTargetGoalId: string | null = null;
  // Authority epochs rise per goal (the sub-episode's goal has its own).
  const lastControlEpoch = new Map<string, number>();
  const results = new Map<string, StudioStepCertification>();

  // Every call each step's window read listed (attributed to that step's window, whatever its outcome).
  const windowSeqs = new Set<number>();
  ordering.forEach(({ step, baseline }, index) => {
    const result: StudioStepCertification = { step_id: step.stepId, operation_id: step.operationId, outcome: "unavailable", reason: null, baseline_read_at: null, candidate_seqs: [], call_outcome: null, command_id: null, command_kind: null, goal_id: null, authority_epoch: null, task_id: null, evidence_seqs: [] };
    results.set(step.operationId, result);
    const settle = (outcome: StudioStepCertification["outcome"], reason: string | null) => { result.outcome = outcome; result.reason = reason; };
    const expectedKind = STUDIO_VOICE_STEP_COMMAND_KIND[step.stepId];
    if (!expectedKind) return settle("unavailable", "not_a_voice_step");
    if (runExchange === null) return settle("unavailable", "no_exchange_joined_to_run");
    if (!input.ownershipProven) return settle("unavailable", "run_exchange_ownership_unproven");
    if (!baseline) return settle("unavailable", "no_calls_baseline");
    result.evidence_seqs.push(baseline.seq);
    if (baseline.payload.status !== "available") return settle("unavailable", `calls_baseline_${String(baseline.payload.reason ?? "unavailable")}`);
    if (typeof baseline.payload.exchange_id !== "string" || baseline.payload.exchange_id.toLowerCase() !== runExchange) return settle("unavailable", "calls_baseline_not_of_run_exchange");
    const readAt = typeof baseline.payload.read_at === "string" ? baseline.payload.read_at : null;
    if (readAt === null) return settle("unavailable", "calls_baseline_malformed");
    result.baseline_read_at = readAt;
    // The baseline is taken only once every call listed so far was answered.
    if (baseline.payload.settled !== true) return settle("uncertain", "calls_baseline_unsettled");
    // The step's own window: its own settled read with after = this
    // baseline's readAt (verbatim), taken before any later voice step's
    // baseline (of any operation, performed or not). That read's readAt bounds
    // the window; the next step's baseline never does.
    const upper = reads.find((event) => event.payload.purpose === "baseline" && event.seq > baseline.seq)?.seq ?? Number.MAX_SAFE_INTEGER;
    const stepReads = reads.filter((event) => event.payload.purpose === "after" && event.payload.operation_id === step.operationId && event.payload.after === readAt && event.seq > baseline.seq && event.seq < upper);
    const after = stepReads.filter((event) => event.payload.status === "available" && typeof event.payload.exchange_id === "string" && event.payload.exchange_id.toLowerCase() === runExchange);
    if (after.length === 0) {
      const refused = stepReads.at(-1);
      return settle("unavailable", refused ? `calls_after_${String(refused.payload.reason ?? "unavailable")}` : "no_calls_read_after_step");
    }
    const window = after.find((event) => event.payload.settled === true) ?? null;
    if (window === null) return settle("uncertain", "call_unanswered");
    result.evidence_seqs.push(window.seq);
    for (const call of callsOf(window)) windowSeqs.add(call.seq);
    // A command-bearing call one read listed and a later read of the same window no longer lists: not one stable record.
    for (const [position, earlier] of after.entries()) {
      for (const later of after.slice(position + 1)) {
        const listed = new Set(callsOf(later).map((call) => call.seq));
        if (callsOf(earlier).some((call) => call.command !== null && !listed.has(call.seq))) return settle("uncertain", "calls_entry_conflict");
      }
    }
    const candidates = callsOf(window);
    // Defensive: an entry the baseline already listed is never the step's.
    const listedAtBaseline = new Set(callsOf(baseline).map((call) => call.seq));
    if (candidates.some((call) => listedAtBaseline.has(call.seq))) return settle("uncertain", "call_listed_at_baseline");
    result.candidate_seqs = candidates.map((call) => call.seq);
    if (candidates.some((call) => conflicting.has(call.seq))) return settle("uncertain", "calls_entry_conflict");
    if (candidates.length === 0) return settle("uncertain", "no_call_after_baseline");
    // Every call in the window answered; one still unanswered is never a pass.
    if (candidates.some((call) => call.answered_at === null)) return settle("uncertain", "call_unanswered");
    // Every call in the window made at the input epoch the principal held for this step.
    const stepEpoch = input.stepInputEpochs.get(step.operationId) ?? null;
    if (stepEpoch === null) return settle("uncertain", "step_input_epoch_unknown");
    if (candidates.some((call) => call.input_epoch !== stepEpoch)) return settle("uncertain", "call_input_epoch_mismatch");
    const bearing = candidates.filter((call) => call.command !== null);
    if (bearing.length === 0) return settle("uncertain", "call_admitted_no_command");
    if (bearing.length > 1) return settle("uncertain", "multiple_command_bearing_calls");
    const call = bearing[0]!;
    const command = call.command!;
    Object.assign(result, { command_id: command.command_id, command_kind: command.kind, goal_id: command.goal_id, authority_epoch: command.authority_epoch, task_id: call.task_id, call_outcome: call.outcome });
    if (command.kind !== expectedKind) return settle("fail", "command_kind_mismatch");
    const expectedOutcome = STUDIO_VOICE_STEP_OUTCOME[step.stepId]!;
    if (call.outcome !== expectedOutcome) return settle(call.outcome !== null && FAILING_OUTCOMES.has(call.outcome) ? "fail" : "uncertain", `call_outcome_${String(call.outcome)}`);
    if (certifiedCommands.has(command.command_id)) return settle("uncertain", "command_already_certified");
    if (command.state === "denied") return settle("fail", "command_denied");
    if (UNCERTIFIABLE_STATES.has(command.state)) return settle("uncertain", `command_${command.state}`);
    // The command's state as every LATER answered read shows it: denied, or of
    // unknown outcome, after the window is never a pass.
    const laterStates = new Set(answeredReads.filter((event) => event.seq > window.seq).flatMap(callsOf)
      .filter((later) => later.command !== null && later.command.command_id === command.command_id).map((later) => later.command!.state));
    if (laterStates.has("denied")) return settle("fail", "command_denied_later");
    if (laterStates.has("outcome_unknown")) return settle("uncertain", "command_outcome_unknown_later");
    // The snapshot's view of the run's task, seen after this step's baseline and before the next step.
    const stepObservations = observations.filter((event) => event.seq > baseline.seq && event.seq <= upper);
    const taskSeen = (taskId: string) => [...stepObservations, ...observations.filter((event) => event.seq > upper)].reverse()
      .flatMap((event) => (Array.isArray(event.payload.tasks) ? event.payload.tasks as unknown[] : []).map((value) => ({ event, task: record(value) ?? {} })))
      .find((item) => item.task.task_id === taskId) ?? null;
    if (CREATE_STEPS.has(step.stepId)) {
      if (call.task_id === null) return settle("uncertain", "create_command_without_task");
      const seen = taskSeen(call.task_id);
      if (seen === null || typeof seen.task.exchange_id !== "string") return settle("uncertain", "created_task_exchange_unconfirmed");
      result.evidence_seqs.push(seen.event.seq);
      if (seen.task.exchange_id.toLowerCase() !== runExchange) return settle("fail", "created_task_bound_to_another_exchange");
      const taskGoal = typeof seen.task.goal_id === "string" ? seen.task.goal_id : null;
      if (taskGoal !== null && command.goal_id !== null && taskGoal !== command.goal_id) return settle("fail", "create_goal_mismatch");
      const goal = taskGoal ?? command.goal_id;
      if (goal === null) return settle("uncertain", "created_task_goal_unknown");
      if (step.stepId === STUDIO_STOP_TARGET_STEP) {
        // Explicit, distinct joins: the sub-episode's own task and goal, never the episode's.
        if (createdTaskId === null) return settle("uncertain", "create_step_not_certified");
        if (call.task_id === createdTaskId || goal === createdGoalId) return settle("uncertain", "stop_target_not_distinct");
        certifiedCommands.add(command.command_id);
        stopTargetTaskId = call.task_id;
        stopTargetGoalId = goal;
        return settle("pass", null);
      }
      certifiedCommands.add(command.command_id);
      createdTaskId = call.task_id;
      createdGoalId = goal;
      return settle("pass", null);
    }
    if (createdGoalId === null || createdTaskId === null) return settle("uncertain", "create_step_not_certified");
    // Stop acts on the sub-episode's task when the run made one (certified
    // before Stop); every other control on the episode's created task.
    const stopsSubEpisode = step.stepId === "g7.stop" && stopTargetTaskId !== null;
    const targetTaskId = stopsSubEpisode ? stopTargetTaskId! : createdTaskId;
    const targetGoalId = stopsSubEpisode ? stopTargetGoalId! : createdGoalId;
    if (command.goal_id !== targetGoalId) return settle("fail", "command_goal_mismatch");
    // Hold, resume and stop take a new authority epoch on their goal; a steer does not.
    const takesEpoch = EPOCH_STEPS.has(step.stepId);
    const priorEpoch = lastControlEpoch.get(targetGoalId) ?? null;
    if (takesEpoch && command.authority_epoch === null) return settle("uncertain", "authority_epoch_missing");
    if (takesEpoch && priorEpoch !== null && command.authority_epoch! <= priorEpoch) return settle("fail", "authority_epoch_not_increasing");
    const sightingsOf = (events: Event[]) => events.flatMap((event) => (Array.isArray(event.payload.tasks) ? event.payload.tasks as unknown[] : []).map((value) => ({ event, task: record(value) ?? {} })))
      .filter((item) => item.task.task_id === targetTaskId);
    if (step.stepId === "g7.stop") {
      // Stop is credited only on work still live just before it: the target's
      // latest sighting before Stop's baseline. Never on work already ended.
      const before = sightingsOf(observations.filter((event) => event.seq < baseline.seq)).at(-1) ?? null;
      if (before === null) return settle("uncertain", "stop_target_not_observed_before_stop");
      result.evidence_seqs.push(before.event.seq);
      if (ENDED_TASK_STATES.has(String(before.task.state)) || ENDED_TASK_PHASES.has(String(before.task.phase))) return settle("uncertain", "stop_target_already_ended");
    }
    const statuses = STUDIO_VOICE_STEP_GOAL_STATUS[step.stepId];
    if (statuses) {
      // The step's own observation (its `observe` action) decides; else the
      // first one after the step. A much later observation (e.g. the final
      // read after End) is never this step's effect. Hold and resume act on
      // the goal's live work (the product holds the design under way while
      // the research reads result_ready): a task of the run's goal shows it.
      // Stop is read on its target task.
      const onGoal = (events: Event[]) => events.flatMap((event) => (Array.isArray(event.payload.tasks) ? event.payload.tasks as unknown[] : []).map((value) => ({ event, task: record(value) ?? {} })))
        .filter((item) => item.task.goal_id === targetGoalId);
      const own = (items: Array<{ event: Event; task: Record<string, unknown> }>) => items.filter((item) => item.event.payload.purpose === step.stepId);
      const isStop = step.stepId === "g7.stop";
      const sightings = isStop ? sightingsOf(stepObservations) : onGoal(stepObservations);
      const matching = sightings.filter((item) => statuses.includes(String(item.task.phase)));
      const seen = own(matching).at(-1) ?? own(sightings).at(-1) ?? matching[0] ?? sightings[0] ?? null;
      if (seen === null) return settle("uncertain", "goal_status_not_observed");
      result.evidence_seqs.push(seen.event.seq);
      if (!statuses.includes(String(seen.task.phase))) return settle("uncertain", "goal_status_not_matching_step");
      if (isStop) {
        // Ended by Stop's command, not by anything else: never by a withdrawal of a source it drew on.
        const withdrawn = Array.isArray(seen.task.withdrawn_source_ids) ? seen.task.withdrawn_source_ids.length : 0;
        if (withdrawn > 0 || seen.task.reason_class === "revoked_source_withdrawn") return settle("uncertain", "stop_target_ended_by_withdrawal");
        // And its job cancelled for the stop (reason `stopped`), in this or a later observation.
        const cancelled = sightingsOf(observations.filter((event) => event.seq >= seen.event.seq)).find((item) => item.task.state === "cancelled" && item.task.reason_class === "stopped") ?? null;
        if (cancelled === null) return settle("uncertain", "stop_effect_not_settled");
        if (cancelled.event.seq !== seen.event.seq) result.evidence_seqs.push(cancelled.event.seq);
      }
    }
    certifiedCommands.add(command.command_id);
    if (takesEpoch) lastControlEpoch.set(targetGoalId, command.authority_epoch!);
    return settle("pass", null);
  });

  // A command-bearing call a later read listed (a baseline, or the End read)
  // that no step's window holds was never examined by any step.
  const bearing = new Set(answeredReads.flatMap(callsOf).filter((call) => call.command !== null).map((call) => call.seq));
  const unattributed = [...bearing].filter((seq) => !windowSeqs.has(seq)).sort((left, right) => left - right);
  return {
    steps: input.steps.map((step) => results.get(step.operationId)!),
    unattributed_seqs: unattributed,
    createdTaskId,
    createdGoalId,
    stopTargetTaskId,
    stopTargetGoalId,
    answered: answeredReads.length > 0,
  };
}
