import { afterEach, describe, expect, it, vi } from "vitest"

import {
  clearVoiceBuilderToolBridgeForTests,
  COMPANION_TURN_UNCONFIRMED,
  companionTurnFailureCode,
  createCompanionTurnFailures,
  createVoiceBuilderToolHandler,
  executeVoiceBuilderToolBridgeCall,
  hasRecentExplicitVoiceBuilderRequest,
  isExplicitVoiceBuilderRequest,
  registerVoiceBuilderToolBridge,
  voiceBuilderKnownTaskIds,
  type VoiceBuilderSessionAdapter,
  type VoiceBuilderToolCallInput,
  type VoiceBuilderToolName,
} from "../../app/lib/voice-builder-actions"
import type { BuilderCompletionEventV1 } from "../../app/types/builder-completion"
import type { BuilderTaskV1 } from "../../app/types/builder-task"

const NOW = 1_000_000

function call(
  name: VoiceBuilderToolName,
  args: Record<string, unknown>,
  utterances: string[] = [],
): VoiceBuilderToolCallInput {
  return {
    id: `${name}-1`,
    name,
    args,
    recentUserUtterances: utterances.map((text) => ({ text, atMs: NOW - 1_000 })),
  }
}

function createSession(initial: { task?: BuilderTaskV1 | null; completion?: BuilderCompletionEventV1 | null } = {}) {
  const state = {
    task: initial.task ?? null,
    completion: initial.completion ?? null,
  }
  const sent: string[] = []
  const onSend: { next: (() => void) | null; reject: Error | null } = { next: null, reject: null }
  const cancelBuilderTask = vi.fn(async () => ({ status: "cancelled", task_id: state.task?.taskId ?? null, run_id: state.task?.runId ?? null }))
  const adapter: VoiceBuilderSessionAdapter = {
    sendCompanionMessage: async (text) => {
      sent.push(text)
      if (onSend.reject) {
        throw onSend.reject
      }
      onSend.next?.()
    },
    getBuilderTask: () => state.task,
    getBuilderCompletion: () => state.completion,
    cancelBuilderTask,
  }
  let clock = NOW
  const handler = createVoiceBuilderToolHandler(adapter, {
    confirmationTimeoutMs: 1_000,
    pollIntervalMs: 100,
    nowMs: () => clock,
    sleep: async (ms) => { clock += ms },
  })
  return { state, sent, onSend, cancelBuilderTask, handler }
}

describe("companion turn failures", () => {
  it("attributes a failure only to the message that started the turn, once", () => {
    const failures = createCompanionTurnFailures()
    failures.record("message-a", "memory_context_rotation_required", false)

    expect(failures.take("message-b")).toBeNull()
    expect(failures.take("message-a")).toBe("memory_context_rotation_required")
    expect(failures.take("message-a")).toBeNull()
  })

  it("treats only a refusal before any activity as definitive", () => {
    const failures = createCompanionTurnFailures()
    failures.record(null, "memory_context_rotation_required", false)
    failures.record("json-body", JSON.stringify({ error: "memory_context_rotation_required" }), false)
    failures.record("refused-late", "memory_context_rotation_required", true)
    failures.record("other", "Upstream said: something with user text", false)

    expect(failures.take("json-body")).toBe("memory_context_rotation_required")
    // A refusal after the companion started working may follow a launched build.
    expect(failures.take("refused-late")).toBe(COMPANION_TURN_UNCONFIRMED)
    expect(failures.take("other")).toBe(COMPANION_TURN_UNCONFIRMED)
    expect(companionTurnFailureCode("", false)).toBe(COMPANION_TURN_UNCONFIRMED)
  })

  it("keeps only a bounded number of unclaimed failures", () => {
    const failures = createCompanionTurnFailures()
    for (let index = 0; index < 40; index += 1) failures.record(`message-${index}`, "boom", true)

    expect(failures.take("message-0")).toBeNull()
    expect(failures.take("message-39")).toBe(COMPANION_TURN_UNCONFIRMED)
  })
})

describe("voice builder explicit-request guard", () => {
  it("matches the voice backend's explicit builder request rules", () => {
    expect(isExplicitVoiceBuilderRequest("Can you research the EU AI Act and write me a report?")).toBe(true)
    expect(isExplicitVoiceBuilderRequest("research the latest battery prices")).toBe(true)
    expect(isExplicitVoiceBuilderRequest("I want a deck about our Q3 results")).toBe(true)
    expect(isExplicitVoiceBuilderRequest("please make a one-pager on onboarding")).toBe(true)
    expect(isExplicitVoiceBuilderRequest("I'm trying to understand how batteries work")).toBe(false)
    expect(isExplicitVoiceBuilderRequest("yes, markdown is fine")).toBe(false)
    expect(isExplicitVoiceBuilderRequest("")).toBe(false)
    expect(isExplicitVoiceBuilderRequest(null)).toBe(false)
  })

  it("accepts a recent explicit request followed by a clarifying answer, but not a stale one", () => {
    const utterances = [
      { text: "Can you research EV charging in Europe?", atMs: NOW - 60_000 },
      { text: "Markdown, and focus on Germany", atMs: NOW - 5_000 },
    ]
    expect(hasRecentExplicitVoiceBuilderRequest(utterances, NOW)).toBe(true)
    expect(hasRecentExplicitVoiceBuilderRequest(utterances, NOW + 10 * 60_000)).toBe(false)
    expect(hasRecentExplicitVoiceBuilderRequest([{ text: "sounds good", atMs: NOW }], NOW)).toBe(false)
  })
})

describe("voice builder tool handler", () => {
  afterEach(() => {
    clearVoiceBuilderToolBridgeForTests()
  })

  it("starts a build through one companion turn and reports it only after a new running task appears", async () => {
    const session = createSession()
    session.onSend.next = () => {
      session.state.task = { phase: "running", taskId: "task-new", runId: "run-new" }
    }

    const result = await session.handler.execute(call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    ))

    expect(result).toMatchObject({
      ok: true,
      started: true,
      builder_task_started: true,
      task_id: "task-new",
      run_id: "run-new",
    })
    expect(session.sent).toHaveLength(1)
    expect(session.sent[0]).toContain("start_builder_task")
    expect(session.sent[0]).toContain("Task type: research")
    expect(session.sent[0]).toContain("Research EV charging in Germany; deliver Markdown.")
  })

  it("never reports a start without an observed task", async () => {
    const session = createSession()

    const result = await session.handler.execute(call(
      "start_builder_task",
      { description: "Research EV charging." },
      ["please research EV charging"],
    ))

    expect(result).toMatchObject({
      ok: false,
      started: false,
      builder_task_started: false,
      reason: "builder_start_unconfirmed",
    })
    expect(result).not.toHaveProperty("task_id")
    expect(session.sent).toHaveLength(1)
  })

  it("ignores an older finished task when confirming a new start", async () => {
    const session = createSession({ task: { phase: "completed", taskId: "task-old", runId: "run-old" } })

    const result = await session.handler.execute(call(
      "start_builder_task",
      { description: "Write a brief." },
      ["can you write a brief about solar"],
    ))

    expect(result).toMatchObject({ ok: false, reason: "builder_start_unconfirmed" })
  })

  it("refuses a start without an explicit user request and sends nothing", async () => {
    const session = createSession()

    const result = await session.handler.execute(call(
      "start_builder_task",
      { description: "Research batteries." },
      ["I'm curious how batteries work"],
    ))

    expect(result).toMatchObject({ ok: false, error_type: "explicit_builder_request_required", builder_task_started: false })
    expect(session.sent).toHaveLength(0)
  })

  it("reports a running build instead of starting a duplicate", async () => {
    const session = createSession({ task: { phase: "running", taskId: "task-1", runId: "run-1" } })

    const result = await session.handler.execute(call(
      "start_builder_task",
      { description: "Research batteries." },
      ["please research batteries"],
    ))

    expect(result).toMatchObject({ ok: false, reason: "builder_already_running", task_id: "task-1", duplicate_guard: true })
    expect(session.sent).toHaveLength(0)
  })

  it("reports a failed send without waiting for the timeout", async () => {
    const session = createSession()
    session.onSend.reject = new Error("memory_source_dispatch_busy")

    const result = await session.handler.execute(call(
      "start_builder_task",
      { description: "Research batteries." },
      ["please research batteries"],
    ))

    expect(result).toMatchObject({ ok: false, reason: "builder_request_not_sent", send_error: "memory_source_dispatch_busy" })
  })

  it("reports a memory governance refusal as not started, without retrying", async () => {
    const session = createSession()
    session.onSend.reject = new Error("memory_context_rotation_required")

    const result = await session.handler.execute(call(
      "start_builder_task",
      { description: "Research batteries." },
      ["please research batteries"],
    ))

    expect(result).toMatchObject({
      ok: false,
      started: false,
      builder_task_started: false,
      reason: "builder_request_not_sent",
      send_error: "memory_context_rotation_required",
    })
    expect(String(result.recovery_guidance)).toContain("could not be started in this conversation")
    expect(String(result.recovery_guidance)).toContain("Do not retry it yourself")
    expect(session.sent).toHaveLength(1)
  })

  it("keeps a running build's status when a correction is refused", async () => {
    const session = createSession({ task: { phase: "running", taskId: "task-1", runId: "run-1" } })
    session.onSend.reject = new Error("memory_context_rotation_required")

    const result = await session.handler.execute(call(
      "update_async_task",
      { task_id: "task-1", message: "Focus on Germany." },
    ))

    expect(result).toMatchObject({
      ok: false,
      updated: false,
      reason: "builder_request_not_sent",
      send_error: "memory_context_rotation_required",
    })
    const guidance = String(result.recovery_guidance)
    expect(guidance).toContain("the existing build or artifact was left unchanged")
    expect(guidance).not.toMatch(/nothing is running|no new build is running|keeps running/)
    expect(session.cancelBuilderTask).not.toHaveBeenCalled()
  })

  it("keeps a completed artifact's status when an edit is refused", async () => {
    const session = createSession({ completion: {
      task_id: "task-1",
      run_id: "run-1",
      status: "success",
      artifact_path: "mnt/user-data/outputs/report.md",
      artifact_title: "report.md",
    } as BuilderCompletionEventV1 })
    session.onSend.reject = new Error("memory_context_rotation_required")

    const result = await session.handler.execute(call(
      "edit_builder_artifact",
      { artifact_path: "mnt/user-data/outputs/report.md", instructions: "Shorten the intro." },
    ))

    expect(result).toMatchObject({ ok: false, reason: "builder_request_not_sent", send_error: "memory_context_rotation_required" })
    expect(String(result.recovery_guidance)).toContain("left unchanged")
    expect(String(result.recovery_guidance)).not.toMatch(/running/)
  })

  it("reports an ambiguous companion failure as unconfirmed at once, never as not sent", async () => {
    const session = createSession()
    session.onSend.reject = new Error(COMPANION_TURN_UNCONFIRMED)

    const result = await session.handler.execute(call(
      "start_builder_task",
      { description: "Research batteries." },
      ["please research batteries"],
    ))

    expect(result).toMatchObject({
      ok: false,
      builder_task_started: false,
      reason: "builder_start_unconfirmed",
      status: "unconfirmed",
    })
    expect(result).not.toHaveProperty("send_error")
    expect(String(result.recovery_guidance)).not.toMatch(/try again|retry/i)
    // Delivery is unknown (it may have failed before dispatch), so never claim it was sent.
    expect(result).toMatchObject({ delivery: "unknown" })
    expect(String(result.result_summary)).not.toMatch(/was sent/)
    expect(session.sent).toHaveLength(1)
  })

  it("still says a request was sent when only the confirmation timed out", async () => {
    const session = createSession()

    const result = await session.handler.execute(call(
      "start_builder_task",
      { description: "Research batteries." },
      ["please research batteries"],
    ))

    expect(result).toMatchObject({ reason: "builder_start_unconfirmed", status: "unconfirmed" })
    expect(result).not.toHaveProperty("delivery")
    expect(String(result.result_summary)).toContain("The request was sent")
  })

  it("sends a voice correction to the companion and confirms it by a new run", async () => {
    const session = createSession({ task: { phase: "running", taskId: "task-1", runId: "run-1" } })
    session.onSend.next = () => {
      session.state.task = { phase: "running", taskId: "task-1", runId: "run-2" }
    }

    const result = await session.handler.execute(call(
      "update_async_task",
      { task_id: "task-1", message: "Stop this section about pricing and focus on Germany." },
    ))

    expect(result).toMatchObject({ ok: true, updated: true, task_id: "task-1", run_id: "run-2" })
    expect(session.sent).toHaveLength(1)
    expect(session.sent[0]).toContain("Build task: task-1")
    expect(session.sent[0]).toContain("Correction: Stop this section about pricing and focus on Germany.")
    expect(session.cancelBuilderTask).not.toHaveBeenCalled()
  })

  it("confirms an edit of a delivered artifact by the new build it starts", async () => {
    const session = createSession({ task: { phase: "completed", taskId: "task-1", runId: "run-1" } })
    session.onSend.next = () => {
      session.state.task = { phase: "running", taskId: "task-2", runId: "run-3" }
    }

    const result = await session.handler.execute(call(
      "edit_builder_artifact",
      { artifact_path: "mnt/user-data/outputs/report.md", message: "Add a summary table." },
    ))

    expect(result).toMatchObject({ ok: true, updated: true, task_id: "task-2" })
    expect(session.sent[0]).toContain("Artifact: mnt/user-data/outputs/report.md")
  })

  it("reports an unconfirmed correction truthfully", async () => {
    const session = createSession({ task: { phase: "running", taskId: "task-1", runId: "run-1" } })

    const result = await session.handler.execute(call("update_async_task", { task_id: "task-1", message: "Shorter." }))

    expect(result).toMatchObject({ ok: false, updated: false, reason: "builder_update_unconfirmed" })
  })

  it("reads status from session Builder state and calls a build ready only with an artifact path", async () => {
    const running = createSession({ task: { phase: "running", taskId: "task-1", runId: "run-1", detail: "Searching sources" } })
    expect(await running.handler.execute(call("check_async_task", { task_id: "task-1" }))).toMatchObject({
      ok: true,
      task_id: "task-1",
      status: "running",
      ready: false,
    })

    const completion = {
      thread_id: "thread-1",
      task_id: "task-1",
      run_id: "run-1",
      status: "success",
      artifact_path: "mnt/user-data/outputs/report.md",
      artifact_title: "Report",
    } as BuilderCompletionEventV1
    const done = createSession({ task: { phase: "completed", taskId: "task-1", runId: "run-1" }, completion })
    expect(await done.handler.execute(call("check_async_task", {}))).toMatchObject({
      ok: true,
      status: "success",
      ready: true,
      artifact_path: "mnt/user-data/outputs/report.md",
    })

    const empty = createSession({
      task: { phase: "completed", taskId: "task-1", runId: "run-1" },
      completion: { ...completion, artifact_path: null },
    })
    expect(await empty.handler.execute(call("check_async_task", {}))).toMatchObject({
      status: "completed_without_artifact",
      ready: false,
    })

    expect(await running.handler.execute(call("check_async_task", { task_id: "invented-id" }))).toMatchObject({
      ok: false,
      error_type: "task_not_found",
      known_task_ids: ["task-1"],
    })
    expect(await running.handler.execute(call("list_async_tasks", {}))).toMatchObject({ ok: true, count: 1 })
    expect(await createSession().handler.execute(call("check_async_task", {}))).toMatchObject({ ok: true, status: "none" })
  })

  it("cancels only the running session build", async () => {
    const session = createSession({ task: { phase: "running", taskId: "task-1", runId: "run-1" } })

    expect(await session.handler.execute(call("cancel_async_task", { task_id: "other" }))).toMatchObject({
      ok: false,
      error_type: "task_not_found",
    })
    expect(session.cancelBuilderTask).not.toHaveBeenCalled()

    expect(await session.handler.execute(call("cancel_async_task", { task_id: "task-1" }))).toMatchObject({
      ok: true,
      status: "cancelled",
      task_id: "task-1",
    })
    expect(session.cancelBuilderTask).toHaveBeenCalledTimes(1)

    expect(await createSession().handler.execute(call("cancel_async_task", {}))).toMatchObject({
      ok: false,
      reason: "no_active_builder_task",
    })
  })

  it("answers truthfully when no session bridge is registered", async () => {
    expect(await executeVoiceBuilderToolBridgeCall(call("start_builder_task", { description: "x" }, ["please research x"]))).toMatchObject({
      ok: false,
      started: false,
      builder_task_started: false,
      reason: "voice_builder_unavailable",
    })
    expect(voiceBuilderKnownTaskIds()).toEqual([])
  })

  it("exposes the session's known task ids through the registered bridge", () => {
    const session = createSession({
      task: { phase: "running", taskId: "task-1", runId: "run-1" },
      completion: { thread_id: "thread-1", task_id: "task-0", status: "success" } as BuilderCompletionEventV1,
    })
    const unregister = registerVoiceBuilderToolBridge(session.handler)
    expect(voiceBuilderKnownTaskIds()).toEqual(["task-1", "task-0"])
    unregister()
    expect(voiceBuilderKnownTaskIds()).toEqual([])
  })
})
