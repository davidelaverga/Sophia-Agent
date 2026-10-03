import type { BuilderCompletionEventV1 } from "../types/builder-completion"
import type { BuilderTaskV1 } from "../types/builder-task"

import { isMemoryContextRecoveryError, MEMORY_CONTEXT_RECOVERY_REQUIRED } from "./memory-context-error"

/**
 * Voice Builder lifecycle, owned by the browser.
 *
 * Gemini voice cannot start or update a Builder run itself: for governed
 * owners LangGraph only accepts a Builder run carrying a handoff proof that the
 * text companion mints inside its own start_builder_task tool boundary. So
 * every voice Builder action that changes work (start, update, edit) is sent
 * to the companion as one chat turn through the ordinary text send path, and
 * the companion picks its own tool exactly as it does in text mode. Status and
 * cancel read the same session Builder state the progress panel shows.
 *
 * A tool result only reports a started or updated build after a new running
 * task or run was actually observed in that session state.
 */

export const VOICE_BUILDER_START_TOOL_NAME = "start_builder_task"
export const VOICE_BUILDER_UPDATE_TOOL_NAME = "update_async_task"
export const VOICE_BUILDER_EDIT_TOOL_NAME = "edit_builder_artifact"
export const VOICE_BUILDER_CHECK_TOOL_NAME = "check_async_task"
export const VOICE_BUILDER_LIST_TOOL_NAME = "list_async_tasks"
export const VOICE_BUILDER_CANCEL_TOOL_NAME = "cancel_async_task"

export const VOICE_BUILDER_TOOL_NAMES = [
  VOICE_BUILDER_START_TOOL_NAME,
  VOICE_BUILDER_UPDATE_TOOL_NAME,
  VOICE_BUILDER_EDIT_TOOL_NAME,
  VOICE_BUILDER_CHECK_TOOL_NAME,
  VOICE_BUILDER_LIST_TOOL_NAME,
  VOICE_BUILDER_CANCEL_TOOL_NAME,
] as const

export type VoiceBuilderToolName = typeof VOICE_BUILDER_TOOL_NAMES[number]

export const VOICE_BUILDER_CONFIRMATION_TIMEOUT_MS = 25_000
const VOICE_BUILDER_POLL_INTERVAL_MS = 250
// A voice build is usually confirmed a turn or two after the request, once
// Sophia has asked her clarifying questions.
const EXPLICIT_REQUEST_WINDOW_MS = 3 * 60 * 1000
const EXPLICIT_REQUEST_MAX_UTTERANCES = 4
// A start the browser has not yet seen running (the confirmation window is
// shorter than a governed launch) still gives a correction something to change:
// the companion tracks that build in its own state.
const PENDING_START_CORRECTION_WINDOW_MS = 5 * 60 * 1000

export interface VoiceBuilderUserUtterance {
  text: string
  atMs: number
}

export interface VoiceBuilderToolCallInput {
  id: string | null
  name: VoiceBuilderToolName
  args: Record<string, unknown>
  recentUserUtterances: VoiceBuilderUserUtterance[]
}

export type VoiceBuilderToolResult = Record<string, unknown> & { ok: boolean }

export interface VoiceBuilderToolBridge {
  execute: (call: VoiceBuilderToolCallInput) => Promise<VoiceBuilderToolResult>
  knownTaskIds: () => string[]
}

export interface VoiceBuilderCancelResponse {
  status?: string | null
  task_id?: string | null
  run_id?: string | null
  detail?: string | null
}

/** The turn failed after it may already have acted; delivery is unknown. */
export const COMPANION_TURN_UNCONFIRMED = "companion_turn_unconfirmed"
/** The chat route's code for LangGraph refusing to create the run at all. */
export const MEMORY_SOURCE_SEND_REFUSED = "memory_source_send_refused"
const MAX_RECORDED_TURN_FAILURES = 32

function isMemoryContextRefusalText(errorText: string): boolean {
  if (isMemoryContextRecoveryError(errorText)) return true
  try {
    return isMemoryContextRecoveryError(JSON.parse(errorText))
  } catch {
    return false
  }
}

function isRunRefusalText(errorText: string): boolean {
  if (errorText === MEMORY_SOURCE_SEND_REFUSED) return true
  try {
    const parsed: unknown = JSON.parse(errorText)
    return typeof parsed === "object" && parsed !== null
      && (parsed as { error?: unknown }).error === MEMORY_SOURCE_SEND_REFUSED
  } catch {
    return false
  }
}

/**
 * A short fixed code for a failed companion turn; backend text never passes.
 * Only a refusal that arrived before the turn did anything is definitive:
 * LangGraph refusing to create the run, or memory governance refusing entry.
 * Nothing ran, so it was not sent. Any other failure (a broken or unparseable
 * stream, another error, or a refusal after the companion had started
 * working) may come after a Builder was already launched, so it stays
 * unconfirmed and must never invite a retry.
 */
export function companionTurnFailureCode(errorText: string, afterActivity: boolean): string {
  if (afterActivity) return COMPANION_TURN_UNCONFIRMED
  if (isMemoryContextRefusalText(errorText)) return MEMORY_CONTEXT_RECOVERY_REQUIRED
  if (isRunRefusalText(errorText)) return MEMORY_SOURCE_SEND_REFUSED
  return COMPANION_TURN_UNCONFIRMED
}

export interface CompanionTurnFailures {
  /** Record the terminal error of the turn started by messageId. */
  record: (messageId: string | null, errorText: string, afterActivity: boolean) => void
  /** Return and forget the failure code recorded for messageId, if any. */
  take: (messageId: string) => string | null
}

/**
 * The AI SDK resolves sendMessage even when the companion turn ends in a
 * stream error; it reports the error through onError instead. Without this a
 * refused companion turn looked like a send still in flight, and the voice
 * bridge waited for its confirmation timeout. Failures are keyed by the id of
 * the message that started the turn, so another send's error (a concurrent
 * typed turn, another voice call, an earlier session) is never attributed to
 * this one.
 */
export function createCompanionTurnFailures(): CompanionTurnFailures {
  const failures = new Map<string, string>()
  return {
    record: (messageId, errorText, afterActivity) => {
      if (!messageId) return
      failures.delete(messageId)
      failures.set(messageId, companionTurnFailureCode(errorText, afterActivity))
      while (failures.size > MAX_RECORDED_TURN_FAILURES) {
        const oldest = failures.keys().next().value
        if (oldest === undefined) break
        failures.delete(oldest)
      }
    },
    take: (messageId) => {
      const code = failures.get(messageId) ?? null
      failures.delete(messageId)
      return code
    },
  }
}

export interface VoiceBuilderSessionAdapter {
  /**
   * Send one companion chat turn through the governed text send path. Rejects
   * with a short error code when the turn could not be sent or ended in error.
   */
  sendCompanionMessage: (text: string) => Promise<unknown>
  getBuilderTask: () => BuilderTaskV1 | null
  getBuilderCompletion: () => BuilderCompletionEventV1 | null
  cancelBuilderTask: () => Promise<VoiceBuilderCancelResponse | null>
  /**
   * The active conversation (thread) this adapter currently serves. One
   * handler can outlive a session switch, so a pending start is kept only for
   * the conversation it was sent in.
   */
  getSessionKey?: () => string | null
  /** The path of the delivered Builder artifact shown in this session, if any. */
  getBuilderArtifactPath?: () => string | null
}

export interface VoiceBuilderHandlerOptions {
  confirmationTimeoutMs?: number
  pollIntervalMs?: number
  nowMs?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Receives one content-free outcome record per tool call. */
  logOutcome?: (outcome: VoiceBuilderOutcomeLog) => void
}

/** Fixed codes, statuses and a short task id only; never briefs or corrections. */
export interface VoiceBuilderOutcomeLog {
  tool: string
  ok: boolean
  reason: string | null
  send_error: string | null
  status: string | null
  task_id: string | null
  waited_ms: number
}

function logVoiceBuilderOutcome(outcome: VoiceBuilderOutcomeLog): void {
  console.warn("[voice-builder]", "outcome", outcome)
}

function outcomeCode(result: VoiceBuilderToolResult, key: string): string | null {
  const value = result[key]
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/u.test(value) ? value : null
}

let activeVoiceBuilderBridge: VoiceBuilderToolBridge | null = null

export function registerVoiceBuilderToolBridge(bridge: VoiceBuilderToolBridge): () => void {
  activeVoiceBuilderBridge = bridge
  return () => {
    if (activeVoiceBuilderBridge === bridge) {
      activeVoiceBuilderBridge = null
    }
  }
}

export function hasVoiceBuilderToolBridge(): boolean {
  return activeVoiceBuilderBridge !== null
}

export function voiceBuilderKnownTaskIds(): string[] {
  return activeVoiceBuilderBridge?.knownTaskIds() ?? []
}

export function clearVoiceBuilderToolBridgeForTests(): void {
  activeVoiceBuilderBridge = null
}

export function isVoiceBuilderToolName(name: string | null | undefined): name is VoiceBuilderToolName {
  return typeof name === "string" && (VOICE_BUILDER_TOOL_NAMES as readonly string[]).includes(name)
}

export async function executeVoiceBuilderToolBridgeCall(
  call: VoiceBuilderToolCallInput,
): Promise<VoiceBuilderToolResult> {
  const bridge = activeVoiceBuilderBridge
  if (!bridge) {
    return notStartedResult(call.name, {
      reason: "voice_builder_unavailable",
      result_summary: "Builder actions are unavailable in this voice session.",
      recovery_guidance: "Tell the user the build could not be started from voice right now. Do not say it started.",
    })
  }
  try {
    return await bridge.execute(call)
  } catch {
    return notStartedResult(call.name, {
      reason: "voice_builder_failed",
      result_summary: "The Builder action failed before it could be confirmed.",
      recovery_guidance: "Tell the user it did not go through. Do not say it started or changed.",
    })
  }
}

// Ported from voice/realtime/gemini_tool_loop.py is_explicit_builder_request so
// the browser keeps the same launch guard the voice backend applied.
const BUILDER_DIRECT_REQUEST_RE = new RegExp(
  "(?:\\bplease\\b|\\b(?:can|could|would|will)\\s+you\\b|"
  + "\\bi\\s+(?:want|need|would\\s+like)\\s+you\\s+to\\b|"
  + "\\blet(?:'|’)s\\b|"
  + "^\\s*(?:build|create|make|prepare|generate|draft|write|design|produce|assemble|"
  + "research|investigate|look\\s+up|find\\s+out|search|verify|fact[- ]check)\\b)",
  "i",
)
const BUILDER_CREATION_ACTION_RE = /\b(?:build|create|make|prepare|generate|draft|write|design|produce|assemble|update|revise|edit|rework)\b/i
const BUILDER_DELIVERABLE_RE = new RegExp(
  "\\b(?:deck|presentation|slides?|document|report|file|pdf|pptx?|spreadsheet|"
  + "workbook|website|webpage|web\\s+page|frontend|visual\\s+report|artifact|brief|memo|"
  + "one[- ]pager|plan|proposal)\\b",
  "i",
)
const BUILDER_RESEARCH_ACTION_RE = /\b(?:research|investigate|look\s+up|find\s+out|search(?:\s+the)?\s+web|verify|fact[- ]check)\b/i
const BUILDER_DIRECT_DELIVERABLE_RE = new RegExp(
  "\\bi\\s+(?:want|need|would\\s+like)\\s+(?:a|an|the|some|\\d+)?\\s*"
  + "(?:deck|presentation|slides?|document|report|pdf|pptx?|spreadsheet|workbook|"
  + "website|webpage|artifact|brief|memo|one[- ]pager|proposal)\\b",
  "i",
)

export function isExplicitVoiceBuilderRequest(utterance: string | null | undefined): boolean {
  if (typeof utterance !== "string") {
    return false
  }
  const normalized = utterance.split(/\s+/u).filter(Boolean).join(" ").trim()
  if (!normalized) {
    return false
  }
  if (BUILDER_DIRECT_DELIVERABLE_RE.test(normalized)) {
    return true
  }
  if (!BUILDER_DIRECT_REQUEST_RE.test(normalized)) {
    return false
  }
  if (BUILDER_RESEARCH_ACTION_RE.test(normalized)) {
    return true
  }
  return BUILDER_CREATION_ACTION_RE.test(normalized) && BUILDER_DELIVERABLE_RE.test(normalized)
}

export function hasRecentExplicitVoiceBuilderRequest(
  utterances: VoiceBuilderUserUtterance[],
  nowMs: number = Date.now(),
): boolean {
  return utterances
    .filter((utterance) => nowMs - utterance.atMs <= EXPLICIT_REQUEST_WINDOW_MS)
    .slice(-EXPLICIT_REQUEST_MAX_UTTERANCES)
    .some((utterance) => isExplicitVoiceBuilderRequest(utterance.text))
}

export function buildVoiceBuilderStartMessage(input: { description: string; taskType: string | null }): string {
  return [
    "[Voice build request]",
    "I asked for this by voice and already answered any clarifying questions there.",
    "Start it now with start_builder_task using the brief below. Do not ask me further questions first.",
    input.taskType ? `Task type: ${input.taskType}` : null,
    `Brief: ${input.description}`,
  ].filter((line): line is string => Boolean(line)).join("\n")
}

export function buildVoiceBuilderChangeMessage(input: {
  toolName: typeof VOICE_BUILDER_UPDATE_TOOL_NAME | typeof VOICE_BUILDER_EDIT_TOOL_NAME
  message: string
  taskId: string | null
  artifactPath: string | null
}): string {
  return [
    "[Voice build correction]",
    "I gave this correction by voice. Apply it now with your own builder tools, exactly as you would for a typed request. Do not ask me further questions first.",
    input.taskId ? `Build task: ${input.taskId}` : null,
    input.artifactPath ? `Artifact: ${input.artifactPath}` : null,
    `Correction: ${input.message}`,
  ].filter((line): line is string => Boolean(line)).join("\n")
}

export function createVoiceBuilderToolHandler(
  adapter: VoiceBuilderSessionAdapter,
  options: VoiceBuilderHandlerOptions = {},
): VoiceBuilderToolBridge {
  const confirmationTimeoutMs = options.confirmationTimeoutMs ?? VOICE_BUILDER_CONFIRMATION_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? VOICE_BUILDER_POLL_INTERVAL_MS
  const nowMs = options.nowMs ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const logOutcome = options.logOutcome ?? logVoiceBuilderOutcome
  // A start that was sent but never seen running, the run present before it,
  // and the conversation it was sent in.
  let pendingStart: { atMs: number; baseline: string | null; sessionKey: string | null } | null = null
  const sessionKey = () => adapter.getSessionKey?.() ?? null

  const knownTaskIds = () => uniqueStrings([
    adapter.getBuilderTask()?.taskId,
    adapter.getBuilderCompletion()?.task_id,
  ])

  // Send one companion turn, then wait for a running task or run that differs
  // from the one present before the send. A rejected send ends the wait early.
  // If the wait times out first, `settled` reports how the send ended later.
  const sendAndConfirm = async (text: string): Promise<
    | { kind: "confirmed"; task: BuilderTaskV1 }
    | { kind: "send_failed"; reason: string }
    | { kind: "unconfirmed"; deliveryUnknown?: boolean; settled?: Promise<string | null> }
  > => {
    const baseline = runKey(adapter.getBuilderTask())
    const send: { error: string | null } = { error: null }
    const settled = Promise.resolve()
      .then(() => adapter.sendCompanionMessage(text))
      .then(() => null, (error: unknown) => {
        // Only short error codes reach the model; never raw validation text.
        const message = error instanceof Error ? error.message : ""
        send.error = /^[a-z0-9_]{1,64}$/u.test(message) ? message : "send_failed"
        return send.error
      })
    const deadline = nowMs() + confirmationTimeoutMs
    for (;;) {
      const task = adapter.getBuilderTask()
      if (task?.phase === "running" && task.taskId && runKey(task) !== baseline) {
        return { kind: "confirmed", task }
      }
      if (send.error === COMPANION_TURN_UNCONFIRMED) {
        // The turn may already have launched a build, or may never have been
        // delivered; report it as unconfirmed at once, never as sent or not sent.
        return { kind: "unconfirmed", deliveryUnknown: true }
      }
      if (send.error) {
        return { kind: "send_failed", reason: send.error }
      }
      if (nowMs() >= deadline) {
        return { kind: "unconfirmed", settled }
      }
      await sleep(pollIntervalMs)
    }
  }

  const start = async (call: VoiceBuilderToolCallInput): Promise<VoiceBuilderToolResult> => {
    const description = stringArg(call.args, "description", "task", "brief", "request")
    if (!description) {
      return notStartedResult(call.name, {
        reason: "missing_brief",
        result_summary: "No build brief was provided.",
        recovery_guidance: "Ask the user what to build or research, then call start_builder_task with a complete description.",
      })
    }
    if (!hasRecentExplicitVoiceBuilderRequest(call.recentUserUtterances, nowMs())) {
      return notStartedResult(call.name, {
        reason: "explicit_builder_request_required",
        error_type: "explicit_builder_request_required",
        result_summary: "The user has not explicitly asked for a build or research task.",
        recovery_guidance: "Ask one short question to confirm exactly what the user wants built or researched. Do not say anything started.",
      })
    }
    const active = adapter.getBuilderTask()
    if (active?.phase === "running" && active.taskId) {
      return notStartedResult(call.name, {
        reason: "builder_already_running",
        duplicate_guard: true,
        task_id: active.taskId,
        run_id: active.runId ?? null,
        status: "running",
        result_summary: "A build is already running in this session.",
        recovery_guidance: "Tell the user a build is already running. Offer to wait, update it with update_async_task, or cancel it.",
      })
    }
    const baseline = runKey(adapter.getBuilderTask())
    const startSessionKey = sessionKey()
    const outcome = await sendAndConfirm(buildVoiceBuilderStartMessage({
      description,
      taskType: stringArg(call.args, "task_type", "taskType"),
    }))
    // A confirmed start is visible as a task from now on; only an unconfirmed
    // one needs the pending window.
    const pending = outcome.kind === "unconfirmed" ? { atMs: nowMs(), baseline, sessionKey: startSessionKey } : null
    pendingStart = pending
    if (pending && outcome.kind === "unconfirmed") {
      // The send can still fail after the wait. A failure that means it was not
      // sent (any code but COMPANION_TURN_UNCONFIRMED, as during the wait)
      // leaves nothing to correct.
      void outcome.settled?.then((error) => {
        if (error && error !== COMPANION_TURN_UNCONFIRMED && pendingStart === pending) {
          pendingStart = null
        }
      })
    }
    if (outcome.kind === "confirmed") {
      return {
        ok: true,
        started: true,
        builder_task_started: true,
        task_id: outcome.task.taskId,
        run_id: outcome.task.runId ?? null,
        status: "running",
        result_summary: "Builder task started.",
      }
    }
    return unconfirmedResult(call.name, outcome, "start")
  }

  const change = async (call: VoiceBuilderToolCallInput): Promise<VoiceBuilderToolResult> => {
    const toolName = call.name === VOICE_BUILDER_EDIT_TOOL_NAME ? VOICE_BUILDER_EDIT_TOOL_NAME : VOICE_BUILDER_UPDATE_TOOL_NAME
    const message = stringArg(call.args, "message", "user_update_request", "correction", "description", "instructions")
    if (!message) {
      return notStartedResult(call.name, {
        reason: "missing_correction",
        result_summary: "No correction was provided.",
        recovery_guidance: "Ask the user what they want changed, then call the tool again with the correction.",
      })
    }
    // A correction needs something to change. Forwarding one with no build
    // would spend a companion turn, and its recorded source, on a request it
    // cannot act on, and would keep the chat busy when the real start arrives.
    if (!hasChangeTarget()) {
      return notStartedResult(call.name, {
        reason: "no_build_to_change",
        error_type: "no_build_to_change",
        result_summary: "There is no build or delivered artifact in this session to change. Nothing was sent.",
        recovery_guidance: "Do not say anything was changed. If the user asked for something new to be built or researched, call start_builder_task with the complete brief.",
      })
    }
    const outcome = await sendAndConfirm(buildVoiceBuilderChangeMessage({
      toolName,
      message,
      taskId: stringArg(call.args, "task_id", "taskId"),
      artifactPath: stringArg(call.args, "artifact_path", "artifactPath"),
    }))
    if (outcome.kind === "confirmed") {
      return {
        ok: true,
        updated: true,
        builder_task_started: true,
        task_id: outcome.task.taskId,
        run_id: outcome.task.runId ?? null,
        status: "running",
        result_summary: "The correction was accepted and a build is running with it.",
      }
    }
    return unconfirmedResult(call.name, outcome, "change")
  }

  const hasChangeTarget = (): boolean => {
    const task = adapter.getBuilderTask()
    if (task?.taskId && task.phase === "running") {
      return true
    }
    // A finished build is only correctable through its delivered artifact; a
    // completed task without one has nothing to change.
    if (adapter.getBuilderCompletion()?.artifact_path || adapter.getBuilderArtifactPath?.()) {
      return true
    }
    if (pendingStart && (pendingStart.sessionKey !== sessionKey() || runKey(task) !== pendingStart.baseline)) {
      // Another conversation is active, or the pending start has materialized
      // and is no longer running without an artifact: nothing here to correct.
      pendingStart = null
    }
    return pendingStart !== null && nowMs() - pendingStart.atMs <= PENDING_START_CORRECTION_WINDOW_MS
  }

  const describeTasks = (): Record<string, unknown>[] => {
    const task = adapter.getBuilderTask()
    const completion = adapter.getBuilderCompletion()
    const entries: Record<string, unknown>[] = []
    if (task?.taskId) {
      entries.push(describeTask(task, completion?.task_id === task.taskId ? completion : null))
    }
    if (completion?.task_id && completion.task_id !== task?.taskId) {
      entries.push(describeCompletion(completion))
    }
    return entries
  }

  const check = (call: VoiceBuilderToolCallInput): VoiceBuilderToolResult => {
    const tasks = describeTasks()
    const requestedTaskId = stringArg(call.args, "task_id", "taskId")
    if (tasks.length === 0) {
      return {
        ok: true,
        status: "none",
        tasks: [],
        builder_task_started: false,
        result_summary: "There is no build in this session.",
      }
    }
    const match = requestedTaskId
      ? tasks.find((entry) => entry.task_id === requestedTaskId)
      : tasks[0]
    if (!match) {
      return {
        ok: false,
        error_type: "task_not_found",
        known_task_ids: tasks.map((entry) => entry.task_id),
        result_summary: "That build is not in this session.",
        recovery_guidance: "Use list_async_tasks to find the real task, then check it. Do not invent task ids.",
      }
    }
    return { ok: true, ...match }
  }

  const list = (): VoiceBuilderToolResult => {
    const tasks = describeTasks()
    return {
      ok: true,
      tasks,
      count: tasks.length,
      result_summary: tasks.length ? `${tasks.length} build(s) in this session.` : "There is no build in this session.",
    }
  }

  const cancel = async (call: VoiceBuilderToolCallInput): Promise<VoiceBuilderToolResult> => {
    const task = adapter.getBuilderTask()
    const requestedTaskId = stringArg(call.args, "task_id", "taskId")
    if (!task?.taskId || task.phase !== "running") {
      return {
        ok: false,
        reason: "no_active_builder_task",
        result_summary: "There is no running build to cancel.",
      }
    }
    if (requestedTaskId && requestedTaskId !== task.taskId) {
      return {
        ok: false,
        error_type: "task_not_found",
        known_task_ids: [task.taskId],
        result_summary: "That build is not the one running in this session.",
        recovery_guidance: "Use list_async_tasks to find the running build. Do not invent task ids.",
      }
    }
    const response = await adapter.cancelBuilderTask()
    if (!response) {
      return {
        ok: false,
        reason: "builder_cancel_unavailable",
        task_id: task.taskId,
        result_summary: "The build could not be cancelled right now.",
      }
    }
    const status = response.status ?? "cancel_requested"
    return {
      ok: status !== "failed",
      task_id: response.task_id ?? task.taskId,
      run_id: response.run_id ?? task.runId ?? null,
      status,
      result_summary: response.detail ?? (status === "cancelled" ? "The build was cancelled." : "Cancellation was requested."),
    }
  }

  const dispatch = async (call: VoiceBuilderToolCallInput): Promise<VoiceBuilderToolResult> => {
    switch (call.name) {
      case VOICE_BUILDER_START_TOOL_NAME:
        return start(call)
      case VOICE_BUILDER_UPDATE_TOOL_NAME:
      case VOICE_BUILDER_EDIT_TOOL_NAME:
        return change(call)
      case VOICE_BUILDER_CHECK_TOOL_NAME:
        return check(call)
      case VOICE_BUILDER_LIST_TOOL_NAME:
        return list()
      case VOICE_BUILDER_CANCEL_TOOL_NAME:
        return cancel(call)
      default:
        return notStartedResult(call.name, { reason: "unsupported_voice_builder_tool" })
    }
  }

  return {
    knownTaskIds,
    execute: async (call) => {
      const startedAtMs = nowMs()
      const result = await dispatch(call)
      try {
        const taskId = typeof result.task_id === "string" ? result.task_id.slice(0, 12) : null
        logOutcome({
          tool: call.name,
          ok: result.ok,
          reason: outcomeCode(result, "reason") ?? outcomeCode(result, "error_type"),
          send_error: outcomeCode(result, "send_error"),
          status: outcomeCode(result, "status"),
          task_id: taskId,
          waited_ms: Math.max(0, nowMs() - startedAtMs),
        })
      } catch {
        // Diagnostics never change a tool result.
      }
      return result
    },
  }
}

function describeTask(task: BuilderTaskV1, completion: BuilderCompletionEventV1 | null): Record<string, unknown> {
  if (task.phase === "completed" && completion) {
    return describeCompletion(completion)
  }
  const status = task.phase === "running"
    ? "running"
    : task.phase === "failed"
      ? "error"
      : task.phase === "timed_out"
        ? "timeout"
        : task.phase === "cancelled"
          ? "cancelled"
          : "completed_without_artifact"
  return {
    task_id: task.taskId,
    run_id: task.runId ?? null,
    status,
    detail: task.detail ?? null,
    artifact_path: null,
    ready: false,
  }
}

function describeCompletion(completion: BuilderCompletionEventV1): Record<string, unknown> {
  const artifactPath = completion.artifact_path || null
  const status = completion.status === "success"
    ? (artifactPath ? "success" : "completed_without_artifact")
    : completion.status === "timeout"
      ? "timeout"
      : completion.status
  return {
    task_id: completion.task_id,
    run_id: completion.run_id ?? null,
    status,
    artifact_path: artifactPath,
    artifact_title: completion.artifact_title ?? null,
    ready: status === "success",
  }
}

function unconfirmedResult(
  toolName: VoiceBuilderToolName,
  outcome: { kind: "send_failed"; reason: string } | { kind: "unconfirmed"; deliveryUnknown?: boolean },
  action: "start" | "change",
): VoiceBuilderToolResult {
  if (outcome.kind === "send_failed") {
    // A rotation refusal holds for this conversation. A run-creation refusal
    // is certain for this attempt only, so it claims no permanence.
    const scope = outcome.reason === MEMORY_CONTEXT_RECOVERY_REQUIRED ? " in this conversation" : ""
    const refused = outcome.reason === MEMORY_CONTEXT_RECOVERY_REQUIRED
      || outcome.reason === MEMORY_SOURCE_SEND_REFUSED
    return notStartedResult(toolName, {
      reason: "builder_request_not_sent",
      send_error: outcome.reason,
      result_summary: action === "start"
        ? "The build request did not go through."
        : "The correction did not go through.",
      recovery_guidance: !refused
        ? "Tell the user it did not go through and offer to try again. Do not say it started or changed."
        : action === "start"
          ? `Tell the user it could not be started${scope}, so no new build is running. Do not retry it yourself. Do not say it started.`
          // A refused correction never reached the companion. The existing work is
          // untouched, whether it is still running or already finished.
          : `Tell the user the correction could not be sent${scope}, so the existing build or artifact was left unchanged. Do not retry it yourself. Do not say it changed.`,
    })
  }
  if (outcome.deliveryUnknown) {
    return notStartedResult(toolName, {
      reason: action === "start" ? "builder_start_unconfirmed" : "builder_update_unconfirmed",
      status: "unconfirmed",
      delivery: "unknown",
      result_summary: action === "start"
        ? "It is not known whether the request reached Sophia, and no running build was confirmed."
        : "It is not known whether the correction reached Sophia, and no updated build was confirmed.",
      recovery_guidance: "Tell the user it is not confirmed and may still appear in the progress panel. Do not say it started or changed.",
    })
  }
  return notStartedResult(toolName, {
    reason: action === "start" ? "builder_start_unconfirmed" : "builder_update_unconfirmed",
    status: "unconfirmed",
    result_summary: action === "start"
      ? "The request was sent, but no running build was confirmed yet."
      : "The correction was sent, but no updated build was confirmed yet.",
    recovery_guidance: "Tell the user it is not confirmed yet and may still appear in the progress panel. Do not say it started or changed.",
  })
}

function notStartedResult(toolName: string, fields: Record<string, unknown>): VoiceBuilderToolResult {
  return {
    ok: false,
    started: false,
    updated: false,
    builder_task_started: false,
    tool_name: toolName,
    ...fields,
  }
}

function runKey(task: BuilderTaskV1 | null): string | null {
  if (!task?.taskId) {
    return null
  }
  return `${task.taskId}::${task.runId ?? ""}`
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
  return null
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0)))
}
