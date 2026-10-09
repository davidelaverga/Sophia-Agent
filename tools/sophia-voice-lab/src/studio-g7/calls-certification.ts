import type { LabEvent } from "../domain.js";
import { canonicalJson } from "./contract.js";

/**
 * Certification of a G7 voice step from the exchange's calls (A15
 * getExchangeCalls, docs/plans/voice-qualification-g7.md "The calls that
 * made each step").
 *
 * The product records each of the principal's own voice tool calls in an
 * exchange (`seq`, increasing; a replayed call stays its one entry) and
 * links to it only the command the transaction inserted for that call. The
 * Lab:
 * 1. reads the calls before each voice step's write-ahead and keeps the
 *    highest `seq` (the baseline, durable before the step acts);
 * 2. after the step, takes only calls with a higher `seq`, and no later than
 *    the next voice step's baseline read (that read is the last one made
 *    before the next step acts);
 * 3. certifies only if exactly one of them carries a command, of the step's
 *    kind (`native_task` for create, with its task; `steer`, `hold`,
 *    `resume`, `stop` on the goal of the task the run's create step made);
 * 4. checks the effect: the command is not denied, superseded or of unknown
 *    outcome; its id was never certified by an earlier step; a control's
 *    authority epoch is strictly above the previous certified control's;
 *    hold, resume and stop see that task's status match in the snapshot; the
 *    created task names the run's exchange in the snapshot.
 *
 * Anything else is never a pass: no new call, a call with no command (a
 * refusal: e.g. a Hold on work already held), another kind or goal, two
 * command-bearing calls, a call at or below the baseline, a command certified
 * before, or a task or command seen only elsewhere (another exchange, or the
 * principal's own HTTP request, which the product never lists as a call's
 * command). A read the product refused (422 `not_found`) or does not serve
 * (404: voice qualification off) is typed unavailable.
 */
export const STUDIO_CALLS_READ_KIND = "studio.exchange.calls_read" as const;
export const STUDIO_CALLS_READ_SCHEMA = "sophia_voice_lab_studio_exchange_calls_v1" as const;

export const STUDIO_VOICE_STEP_COMMAND_KIND: Readonly<Record<string, string>> = Object.freeze({
  "g7.create": "native_task", "g7.steer": "steer", "g7.hold": "hold", "g7.resume": "resume", "g7.stop": "stop",
});
/** The created task's status in the snapshot that shows each control's effect. */
export const STUDIO_VOICE_STEP_GOAL_STATUS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "g7.hold": ["holding", "held"], "g7.resume": ["running"], "g7.stop": ["stopping", "stopped"],
});
const UNCERTIFIABLE_STATES: ReadonlySet<string> = new Set(["denied", "superseded", "outcome_unknown"]);

type Event = Pick<LabEvent, "kind" | "source" | "seq" | "payload">;

interface RecordedCommand { command_id: string; kind: string; goal_id: string | null; authority_epoch: number | null; goal_revision: number | null; state: string }
interface RecordedCall { seq: number; tool: string; input_epoch: number; task_id: string | null; command: RecordedCommand | null }

export interface StudioStepCertification {
  step_id: string;
  operation_id: string;
  outcome: "pass" | "fail" | "uncertain" | "unavailable";
  reason: string | null;
  baseline_seq: number | null;
  candidate_seqs: number[];
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
  /** The task the certified create step made, and its goal; null unless certified. */
  createdTaskId: string | null;
  createdGoalId: string | null;
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
      command: command && typeof command.command_id === "string" && typeof command.kind === "string" && typeof command.state === "string" ? {
        command_id: command.command_id, kind: command.kind, state: command.state,
        goal_id: typeof command.goal_id === "string" ? command.goal_id : null,
        authority_epoch: typeof command.authority_epoch === "number" ? command.authority_epoch : null,
        goal_revision: typeof command.goal_revision === "number" ? command.goal_revision : null,
      } : null,
    }];
  });
}

/** The parts of an entry that never change once recorded (a command's state may progress). */
function stableIdentity(call: RecordedCall): string {
  return canonicalJson({ seq: call.seq, tool: call.tool, input_epoch: call.input_epoch, task_id: call.task_id, command: call.command ? { ...call.command, state: null } : null });
}

export function certifyStudioVoiceSteps(input: {
  events: ReadonlyArray<Event>;
  /** The run's voice-step operations: id and G7 step id. */
  steps: ReadonlyArray<{ operationId: string; stepId: string }>;
  /** The run's joined exchange, and whether its ownership is proven. */
  runExchangeId: string | null;
  ownershipProven: boolean;
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
  let lastControlEpoch: number | null = null;
  const results = new Map<string, StudioStepCertification>();

  ordering.forEach(({ step, baseline }, index) => {
    const result: StudioStepCertification = { step_id: step.stepId, operation_id: step.operationId, outcome: "unavailable", reason: null, baseline_seq: null, candidate_seqs: [], command_id: null, command_kind: null, goal_id: null, authority_epoch: null, task_id: null, evidence_seqs: [] };
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
    const baselineSeq = typeof baseline.payload.max_seq === "number" ? baseline.payload.max_seq : null;
    if (baselineSeq === null) return settle("unavailable", "calls_baseline_malformed");
    result.baseline_seq = baselineSeq;
    // After the step: reads up to (and including) the next voice step's baseline read.
    const next = ordering[index + 1]?.baseline ?? null;
    const upper = next?.seq ?? Number.MAX_SAFE_INTEGER;
    const after = answeredReads.filter((event) => event.seq > baseline.seq && event.seq <= upper);
    if (after.length === 0) {
      const refused = reads.filter((event) => event.seq > baseline.seq && event.seq <= upper).at(-1);
      return settle("unavailable", refused ? `calls_after_${String(refused.payload.reason ?? "unavailable")}` : "no_calls_read_after_step");
    }
    const latest = after.at(-1)!;
    result.evidence_seqs.push(latest.seq);
    if (typeof latest.payload.max_seq !== "number" || latest.payload.max_seq < baselineSeq) return settle("uncertain", "calls_read_regressed");
    // Out of order: a call at or below the baseline never counts.
    const candidates = callsOf(latest).filter((call) => call.seq > baselineSeq);
    result.candidate_seqs = candidates.map((call) => call.seq);
    if (candidates.some((call) => conflicting.has(call.seq))) return settle("uncertain", "calls_entry_conflict");
    if (candidates.length === 0) return settle("uncertain", "no_call_after_baseline");
    const bearing = candidates.filter((call) => call.command !== null);
    if (bearing.length === 0) return settle("uncertain", "call_admitted_no_command");
    if (bearing.length > 1) return settle("uncertain", "multiple_command_bearing_calls");
    const call = bearing[0]!;
    const command = call.command!;
    Object.assign(result, { command_id: command.command_id, command_kind: command.kind, goal_id: command.goal_id, authority_epoch: command.authority_epoch, task_id: call.task_id });
    if (command.kind !== expectedKind) return settle("fail", "command_kind_mismatch");
    if (certifiedCommands.has(command.command_id)) return settle("uncertain", "command_already_certified");
    if (command.state === "denied") return settle("fail", "command_denied");
    if (UNCERTIFIABLE_STATES.has(command.state)) return settle("uncertain", `command_${command.state}`);
    // The snapshot's view of the run's task, seen after this step's baseline and before the next step.
    const stepObservations = observations.filter((event) => event.seq > baseline.seq && event.seq <= upper);
    const taskSeen = (taskId: string) => [...stepObservations, ...observations.filter((event) => event.seq > upper)].reverse()
      .flatMap((event) => (Array.isArray(event.payload.tasks) ? event.payload.tasks as unknown[] : []).map((value) => ({ event, task: record(value) ?? {} })))
      .find((item) => item.task.task_id === taskId) ?? null;
    if (step.stepId === "g7.create") {
      if (call.task_id === null) return settle("uncertain", "create_command_without_task");
      const seen = taskSeen(call.task_id);
      if (seen === null || typeof seen.task.exchange_id !== "string") return settle("uncertain", "created_task_exchange_unconfirmed");
      result.evidence_seqs.push(seen.event.seq);
      if (seen.task.exchange_id.toLowerCase() !== runExchange) return settle("fail", "created_task_bound_to_another_exchange");
      const taskGoal = typeof seen.task.goal_id === "string" ? seen.task.goal_id : null;
      if (taskGoal !== null && command.goal_id !== null && taskGoal !== command.goal_id) return settle("fail", "create_goal_mismatch");
      const goal = taskGoal ?? command.goal_id;
      if (goal === null) return settle("uncertain", "created_task_goal_unknown");
      certifiedCommands.add(command.command_id);
      createdTaskId = call.task_id;
      createdGoalId = goal;
      return settle("pass", null);
    }
    if (createdGoalId === null || createdTaskId === null) return settle("uncertain", "create_step_not_certified");
    if (command.goal_id !== createdGoalId) return settle("fail", "command_goal_mismatch");
    if (command.authority_epoch === null) return settle("uncertain", "authority_epoch_missing");
    if (lastControlEpoch !== null && command.authority_epoch <= lastControlEpoch) return settle("fail", "authority_epoch_not_increasing");
    const statuses = STUDIO_VOICE_STEP_GOAL_STATUS[step.stepId];
    if (statuses) {
      // The step's own observation (its `observe` action) decides; else the
      // first one after the step. A much later observation (e.g. the final
      // read after End) is never this step's effect.
      const sightings = stepObservations.flatMap((event) => (Array.isArray(event.payload.tasks) ? event.payload.tasks as unknown[] : []).map((value) => ({ event, task: record(value) ?? {} })))
        .filter((item) => item.task.task_id === createdTaskId);
      const seen = sightings.filter((item) => item.event.payload.purpose === step.stepId).at(-1) ?? sightings[0] ?? null;
      if (seen === null) return settle("uncertain", "goal_status_not_observed");
      result.evidence_seqs.push(seen.event.seq);
      if (!statuses.includes(String(seen.task.phase))) return settle("uncertain", "goal_status_not_matching_step");
    }
    certifiedCommands.add(command.command_id);
    lastControlEpoch = command.authority_epoch;
    return settle("pass", null);
  });

  return {
    steps: input.steps.map((step) => results.get(step.operationId)!),
    createdTaskId,
    createdGoalId,
    answered: answeredReads.length > 0,
  };
}
