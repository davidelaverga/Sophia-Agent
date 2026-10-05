import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  clearVoiceBuilderToolBridgeForTests,
  COMPANION_TURN_UNCONFIRMED,
  companionTurnFailureCode,
  createCompanionTurnFailures,
  createVoiceBuilderToolHandler,
  executeVoiceBuilderToolBridgeCall,
  hasRecentExplicitVoiceBuilderRequest,
  isExplicitVoiceBuilderRequest,
  MEMORY_SOURCE_SEND_REFUSED,
  registerVoiceBuilderToolBridge,
  voiceBuilderKnownTaskIds,
  type VoiceBuilderOutcomeLog,
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
  const state: {
    task: BuilderTaskV1 | null
    completion: BuilderCompletionEventV1 | null
    sessionKey: string | null
    artifactPath: string | null
    ready: boolean
  } = {
    task: initial.task ?? null,
    completion: initial.completion ?? null,
    sessionKey: "thread-a",
    artifactPath: null,
    ready: true,
  }
  const sent: string[] = []
  const onSend: {
    next: (() => void) | null
    reject: Error | null
    hold: Promise<void> | null
    // Diagnostics facts the session reports for the send, when set.
    messageId: string | null
  } = { next: null, reject: null, hold: null, messageId: null }
  const cancelBuilderTask = vi.fn(async () => ({ status: "cancelled", task_id: state.task?.taskId ?? null, run_id: state.task?.runId ?? null }))
  const adapter: VoiceBuilderSessionAdapter = {
    sendCompanionMessage: async (text, context) => {
      sent.push(text)
      if (onSend.messageId !== null) {
        context?.note({ messageId: onSend.messageId, appVersionMs: 7 })
        context?.note({ sourceRecordMs: 11, sourceRecorded: true })
      }
      if (onSend.hold !== null) {
        await onSend.hold
      }
      if (onSend.reject) {
        throw onSend.reject
      }
      onSend.next?.()
    },
    getBuilderTask: () => state.task,
    getBuilderCompletion: () => state.completion,
    cancelBuilderTask,
    getSessionKey: () => state.sessionKey,
    getBuilderArtifactPath: () => state.artifactPath,
    isBuilderStateReady: () => state.ready,
  }
  let clock = NOW
  const logs: VoiceBuilderOutcomeLog[] = []
  const handler = createVoiceBuilderToolHandler(adapter, {
    confirmationTimeoutMs: 1_000,
    pollIntervalMs: 100,
    nowMs: () => clock,
    sleep: async (ms) => { clock += ms },
    logOutcome: (outcome) => { logs.push(outcome) },
  })
  return { state, sent, onSend, cancelBuilderTask, handler, logs, advance: (ms: number) => { clock += ms } }
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

  it("treats a run-creation refusal before any activity as definitive", () => {
    const failures = createCompanionTurnFailures()
    failures.record("refused-run", JSON.stringify({ error: MEMORY_SOURCE_SEND_REFUSED }), false)
    failures.record("refused-run-late", JSON.stringify({ error: MEMORY_SOURCE_SEND_REFUSED }), true)
    failures.record("unconfirmed-run", JSON.stringify({ error: "memory_source_send_unconfirmed" }), false)

    expect(failures.take("refused-run")).toBe(MEMORY_SOURCE_SEND_REFUSED)
    expect(failures.take("refused-run-late")).toBe(COMPANION_TURN_UNCONFIRMED)
    expect(failures.take("unconfirmed-run")).toBe(COMPANION_TURN_UNCONFIRMED)
    expect(companionTurnFailureCode(MEMORY_SOURCE_SEND_REFUSED, false)).toBe(MEMORY_SOURCE_SEND_REFUSED)
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
    // BuilderCommandMiddleware (backend) routes on this exact header, task
    // type line and Brief prefix; changing them stops the voice build route.
    const lines = session.sent[0].split("\n")
    expect(lines[0]).toBe("[Voice build request]")
    expect(lines).toContain("Task type: research")
    expect(lines[lines.length - 1]).toBe("Brief: Research EV charging in Germany; deliver Markdown.")
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

  it("reports a run-creation refusal as not started, without retrying", async () => {
    const session = createSession()
    session.onSend.reject = new Error(MEMORY_SOURCE_SEND_REFUSED)

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
      send_error: MEMORY_SOURCE_SEND_REFUSED,
    })
    expect(result).not.toHaveProperty("delivery")
    expect(String(result.recovery_guidance)).toContain("could not be started, so no new build is running")
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
    session.state.artifactPath = "mnt/user-data/outputs/report.md"
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

  it("refuses a correction when the session has no build, and sends nothing", async () => {
    // R017: a correction forwarded before any start spent the turn and its
    // recorded source, and kept the chat busy when the real start arrived.
    const session = createSession()

    for (const name of ["update_async_task", "edit_builder_artifact"] as const) {
      const result = await session.handler.execute(call(name, { message: "Make it shorter." }))

      expect(result).toMatchObject({ ok: false, updated: false, reason: "no_build_to_change", error_type: "no_build_to_change" })
      expect(String(result.recovery_guidance)).toContain("start_builder_task")
    }
    expect(session.sent).toHaveLength(0)
  })

  it("refuses a correction after a build that completed without an artifact", async () => {
    const session = createSession({ task: { phase: "completed", taskId: "task-1", runId: "run-1" } })

    const result = await session.handler.execute(call("edit_builder_artifact", { message: "Add a summary table." }))

    expect(result).toMatchObject({ ok: false, reason: "no_build_to_change" })
    expect(session.sent).toHaveLength(0)
  })

  it("refuses a correction after a build that failed without an artifact", async () => {
    const session = createSession({ task: { phase: "failed", taskId: "task-1", runId: "run-1" } })

    const result = await session.handler.execute(call("update_async_task", { task_id: "task-1", message: "Shorter." }))

    expect(result).toMatchObject({ ok: false, reason: "no_build_to_change" })
    expect(session.sent).toHaveLength(0)
  })

  it("forwards a correction to a start the browser has not seen running yet, but not a stale one", async () => {
    const session = createSession()
    const started = await session.handler.execute(call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    ))
    expect(started).toMatchObject({ ok: false, reason: "builder_start_unconfirmed" })

    // The companion tracks that build even though no running task is visible here.
    await session.handler.execute(call("update_async_task", { message: "Also cover Austria." }))
    expect(session.sent).toHaveLength(2)
    expect(session.sent[1]).toContain("Correction: Also cover Austria.")

    session.advance(6 * 60 * 1000)
    const stale = await session.handler.execute(call("update_async_task", { message: "And Switzerland." }))
    expect(stale).toMatchObject({ ok: false, reason: "no_build_to_change" })
    expect(session.sent).toHaveLength(2)
  })

  it("does not keep a confirmed start that then failed as something to correct", async () => {
    const session = createSession()
    session.onSend.next = () => {
      session.state.task = { phase: "running", taskId: "task-new", runId: "run-new" }
    }
    const started = await session.handler.execute(call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    ))
    expect(started).toMatchObject({ ok: true, started: true })

    session.state.task = { phase: "failed", taskId: "task-new", runId: "run-new" }
    const correction = await session.handler.execute(call("update_async_task", { message: "Also cover Austria." }))

    expect(correction).toMatchObject({ ok: false, reason: "no_build_to_change" })
    expect(session.sent).toHaveLength(1)
  })

  it("drops a pending start once its task appears and ends without an artifact", async () => {
    const session = createSession()
    await session.handler.execute(call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    ))
    // The session observes every state change, so the run is seen running first.
    session.state.task = { phase: "running", taskId: "task-late", runId: "run-late" }
    session.handler.observe?.()
    session.state.task = { phase: "cancelled", taskId: "task-late", runId: "run-late" }

    const correction = await session.handler.execute(call("update_async_task", { message: "Also cover Austria." }))

    expect(correction).toMatchObject({ ok: false, reason: "no_build_to_change" })
    expect(session.sent).toHaveLength(1)
  })

  it("does not carry a pending start into another conversation", async () => {
    const session = createSession()
    await session.handler.execute(call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    ))

    session.state.sessionKey = "thread-b"
    const elsewhere = await session.handler.execute(call("update_async_task", { message: "Also cover Austria." }))
    expect(elsewhere).toMatchObject({ ok: false, reason: "no_build_to_change" })

    // Returning to the first conversation does not revive it either.
    session.state.sessionKey = "thread-a"
    const back = await session.handler.execute(call("update_async_task", { message: "Also cover Austria." }))
    expect(back).toMatchObject({ ok: false, reason: "no_build_to_change" })
    expect(session.sent).toHaveLength(1)
  })

  it("does not treat a start that was never sent as something to correct", async () => {
    const session = createSession()
    session.onSend.reject = new Error("memory_source_dispatch_busy")

    const started = await session.handler.execute(call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    ))
    expect(started).toMatchObject({ ok: false, reason: "builder_request_not_sent", send_error: "memory_source_dispatch_busy" })

    session.onSend.reject = null
    const correction = await session.handler.execute(call("update_async_task", { message: "Also cover Austria." }))
    expect(correction).toMatchObject({ ok: false, reason: "no_build_to_change" })
    expect(session.sent).toHaveLength(1)
  })

  it.each([MEMORY_SOURCE_SEND_REFUSED, "memory_context_rotation_required"])(
    "drops a pending start whose send is refused after the wait (%s)",
    async (code) => {
      const session = createSession()
      let release: (error: Error) => void = () => {}
      session.onSend.hold = new Promise<void>((_resolve, reject) => { release = reject })
      const started = await session.handler.execute(call(
        "start_builder_task",
        { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
        ["Can you research EV charging in Germany?"],
      ))
      expect(started).toMatchObject({ ok: false, reason: "builder_start_unconfirmed" })

      release(new Error(code))
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      const correction = await session.handler.execute(call("update_async_task", { message: "Also cover Austria." }))

      expect(correction).toMatchObject({ ok: false, reason: "no_build_to_change" })
      expect(session.sent).toHaveLength(1)
    },
  )

  it.each([COMPANION_TURN_UNCONFIRMED, "Failed to fetch: network connection lost"])(
    "keeps a pending start whose send ends ambiguously after the wait (%s)",
    async (failure) => {
      const session = createSession()
      let release: (error: Error) => void = () => {}
      session.onSend.hold = new Promise<void>((_resolve, reject) => { release = reject })
      await session.handler.execute(call(
        "start_builder_task",
        { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
        ["Can you research EV charging in Germany?"],
      ))

      // The send may have been accepted and launched the build (an unconfirmed
      // turn, or a network error after the request left), so it stays correctable.
      session.onSend.hold = null
      release(new Error(failure))
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      await session.handler.execute(call("update_async_task", { message: "Also cover Austria." }))

      expect(session.sent).toHaveLength(2)
      expect(session.sent[1]).toContain("Correction: Also cover Austria.")
    },
  )

  it("does not let a pending start's first run confirm a correction", async () => {
    const session = createSession()
    await session.handler.execute(call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    ))
    // The original build becomes visible while the correction waits.
    session.onSend.next = () => {
      session.state.task = { phase: "running", taskId: "task-late", runId: "run-late" }
    }

    const correction = await session.handler.execute(call("update_async_task", { message: "Also cover Austria." }))

    expect(correction).toMatchObject({ ok: false, reason: "builder_update_unconfirmed", status: "unconfirmed" })
    expect(session.sent).toHaveLength(2)
  })

  it("refuses a second start while the first may still appear, and allows one after it ends", async () => {
    const session = createSession()
    const request = call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    )
    await session.handler.execute(request)

    const again = await session.handler.execute(request)
    expect(again).toMatchObject({ ok: false, reason: "builder_start_pending", duplicate_guard: true })
    expect(session.sent).toHaveLength(1)

    session.state.task = { phase: "running", taskId: "task-late", runId: "run-late" }
    session.handler.observe?.()
    session.state.task = { phase: "failed", taskId: "task-late", runId: "run-late" }
    const retry = await session.handler.execute(request)
    expect(retry).toMatchObject({ ok: false, reason: "builder_start_unconfirmed" })
    expect(session.sent).toHaveLength(2)
  })

  it("keeps a pending start when the earlier Builder card is dismissed", async () => {
    const session = createSession({ task: { phase: "failed", taskId: "task-old", runId: "run-old" } })
    const request = call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    )
    await session.handler.execute(request)

    session.state.task = null
    const again = await session.handler.execute(request)
    expect(again).toMatchObject({ ok: false, reason: "builder_start_pending" })
    await session.handler.execute(call("update_async_task", { message: "Also cover Austria." }))
    expect(session.sent).toHaveLength(2)
    expect(session.sent[1]).toContain("Correction: Also cover Austria.")
  })

  it("refuses a start that overlaps one still waiting for confirmation", async () => {
    const session = createSession()
    const request = call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    )

    const [first, second] = await Promise.all([session.handler.execute(request), session.handler.execute(request)])

    expect(first).toMatchObject({ ok: false, reason: "builder_start_unconfirmed" })
    expect(second).toMatchObject({ ok: false, reason: "builder_start_pending" })
    expect(session.sent).toHaveLength(1)
  })

  it("ends a pending start seen running, even after its card is dismissed", async () => {
    const session = createSession()
    const request = call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    )
    await session.handler.execute(request)

    session.state.task = { phase: "running", taskId: "task-late", runId: "run-late" }
    session.handler.observe?.()
    session.state.completion = {
      task_id: "task-late",
      run_id: "run-late",
      status: "success",
      artifact_path: "mnt/user-data/outputs/report.md",
    } as BuilderCompletionEventV1
    session.state.task = null
    session.onSend.next = () => {
      session.state.task = { phase: "running", taskId: "task-late", runId: "run-edit" }
    }
    const correction = await session.handler.execute(call("edit_builder_artifact", { message: "Add a summary." }))
    expect(correction).toMatchObject({ ok: true, updated: true })
  })

  it("does not take an earlier delivered artifact as the pending start's", async () => {
    const session = createSession({ completion: {
      task_id: "task-old",
      run_id: "run-old",
      status: "success",
      artifact_path: "mnt/user-data/outputs/old.md",
    } as BuilderCompletionEventV1 })
    const request = call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    )
    await session.handler.execute(request)

    const again = await session.handler.execute(request)
    expect(again).toMatchObject({ ok: false, reason: "builder_start_pending" })

    // The earlier artifact's view changing (hydrated, replaced or cleared) is
    // still the earlier delivery.
    session.state.artifactPath = "mnt/user-data/outputs/old-hydrated.md"
    session.state.completion = { ...session.state.completion, artifact_path: null } as BuilderCompletionEventV1
    const afterViewChange = await session.handler.execute(request)
    expect(afterViewChange).toMatchObject({ ok: false, reason: "builder_start_pending" })
    expect(session.sent).toHaveLength(1)
  })

  it("never confirms a start with a task from a conversation opened during the wait", async () => {
    const session = createSession()
    session.onSend.next = () => {
      session.state.sessionKey = "thread-b"
      session.state.task = { phase: "running", taskId: "task-b", runId: "run-b" }
    }

    const started = await session.handler.execute(call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    ))

    expect(started).toMatchObject({ ok: false, reason: "builder_start_unconfirmed" })
    expect(started).not.toHaveProperty("task_id", "task-b")
  })

  it("sends no correction while the start's turn is still being sent", async () => {
    const session = createSession()
    let release: () => void = () => {}
    session.onSend.hold = new Promise<void>((resolve) => { release = resolve })
    await session.handler.execute(call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    ))

    const early = await session.handler.execute(call("update_async_task", { message: "Also cover Austria." }))
    expect(early).toMatchObject({ ok: false, reason: "companion_turn_in_progress" })
    expect(session.sent).toHaveLength(1)

    // Once that send settles without proof either way, the start stays correctable.
    session.onSend.hold = null
    release()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    await session.handler.execute(call("update_async_task", { message: "Also cover Austria." }))
    expect(session.sent).toHaveLength(2)
  })

  it.each(["bridge", "ui"])("settles a pending start whose build is cancelled (%s)", async (via) => {
    const session = createSession()
    const request = call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    )
    await session.handler.execute(request)

    session.state.task = { phase: "running", taskId: "task-late", runId: "run-late" }
    if (via === "bridge") {
      expect(await session.handler.execute(call("cancel_async_task", {}))).toMatchObject({ ok: true })
    } else {
      session.handler.observe?.()
    }
    // The UI then dismisses the cancelled card and filters its completion.
    session.state.task = null

    const retry = await session.handler.execute(request)
    expect(retry).toMatchObject({ ok: false, reason: "builder_start_unconfirmed" })
    expect(session.sent).toHaveLength(2)
  })

  it("keeps a pending start when a late snapshot replays an older build", async () => {
    const session = createSession()
    const request = call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    )
    await session.handler.execute(request)

    // The canvas hydrates after the send with an earlier, finished build.
    session.state.task = { phase: "completed", taskId: "task-old", runId: "run-old" }
    session.state.completion = {
      task_id: "task-old",
      run_id: "run-old",
      status: "success",
      artifact_path: "mnt/user-data/outputs/old.md",
    } as BuilderCompletionEventV1
    session.handler.observe?.()

    const again = await session.handler.execute(request)
    expect(again).toMatchObject({ ok: false, reason: "builder_start_pending" })
    expect(session.sent).toHaveLength(1)
  })

  it("sends no start until the session's Builder state has loaded", async () => {
    const session = createSession()
    session.state.ready = false
    const request = call(
      "start_builder_task",
      { description: "Research EV charging in Germany; deliver Markdown.", task_type: "research" },
      ["Can you research EV charging in Germany?"],
    )

    expect(await session.handler.execute(request)).toMatchObject({ ok: false, reason: "builder_state_loading" })
    expect(session.sent).toHaveLength(0)

    session.state.ready = true
    expect(await session.handler.execute(request)).toMatchObject({ ok: false, reason: "builder_start_unconfirmed" })
    expect(session.sent).toHaveLength(1)
  })

  it("logs one content-free outcome per call", async () => {
    const session = createSession()
    session.onSend.reject = new Error("memory_source_dispatch_busy")

    await session.handler.execute(call(
      "start_builder_task",
      { description: "PRIVATE_SYNTHETIC_BRIEF about EV charging", task_type: "research" },
      ["Can you research PRIVATE_SYNTHETIC_UTTERANCE?"],
    ))
    await session.handler.execute(call("update_async_task", { message: "PRIVATE_SYNTHETIC_CORRECTION" }))

    expect(session.logs).toEqual([
      expect.objectContaining({ tool: "start_builder_task", ok: false, reason: "builder_request_not_sent", send_error: "memory_source_dispatch_busy" }),
      expect.objectContaining({ tool: "update_async_task", ok: false, reason: "no_build_to_change", send_error: null }),
    ])
    expect(JSON.stringify(session.logs)).not.toMatch(/PRIVATE_SYNTHETIC/)
    for (const entry of session.logs) {
      expect(Object.keys(entry).sort()).toEqual(["ok", "reason", "send_error", "status", "task_id", "tool", "waited_ms"])
    }
  })

  describe("single-line diagnostics", () => {
    const MESSAGE_ID = "0190f2a3-0000-7000-8000-00000000a001"
    const TASK_ID = "0190f2a3-0000-7000-8000-00000000b001"
    const RUN_ID = "0190f2a3-0000-7000-8000-00000000c001"
    let warn: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    })

    afterEach(() => {
      warn.mockRestore()
    })

    const diagRecords = () => warn.mock.calls.map((args) => {
      // One string argument per line, so log readers never flatten it.
      expect(args).toHaveLength(1)
      expect(typeof args[0]).toBe("string")
      const line = args[0] as string
      expect(line.startsWith("[sophia-diag] ")).toBe(true)
      return JSON.parse(line.slice("[sophia-diag] ".length)) as Record<string, unknown>
    })

    it("emits call, send and outcome lines that share the call id and carry ids, not content", async () => {
      const session = createSession()
      session.onSend.messageId = MESSAGE_ID
      session.onSend.next = () => {
        session.state.task = { phase: "running", taskId: TASK_ID, runId: RUN_ID }
      }

      const result = await session.handler.execute(call(
        "start_builder_task",
        { description: "PRIVATE_SYNTHETIC_BRIEF about EV charging", task_type: "research" },
        ["Can you research PRIVATE_SYNTHETIC_UTTERANCE?"],
      ))
      expect(result).toMatchObject({ ok: true, started: true, task_id: TASK_ID, run_id: RUN_ID })

      const records = diagRecords()
      expect(records.map((record) => record.ev)).toEqual(["voice_builder.call", "voice_builder.send", "voice_builder.outcome"])
      const [callLine, sendLine, outcomeLine] = records
      expect(typeof callLine.call).toBe("string")
      expect(sendLine.call).toBe(callLine.call)
      expect(outcomeLine.call).toBe(callLine.call)
      expect(callLine).toMatchObject({ tool: "start_builder_task", tool_call_id: "start_builder_task-1", thread_id: "thread-a" })
      expect(sendLine).toMatchObject({
        message_id: MESSAGE_ID,
        thread_id: "thread-a",
        outcome: "recorded",
        app_version_ms: 7,
        source_record_ms: 11,
      })
      expect(outcomeLine).toMatchObject({
        v: 1,
        tool: "start_builder_task",
        thread_id: "thread-a",
        message_id: MESSAGE_ID,
        task_id: TASK_ID,
        run_id: RUN_ID,
        ok: true,
        outcome: "started",
        app_version_ms: 7,
        source_record_ms: 11,
        // The companion turn is still streaming when its run is confirmed.
        send_pending: true,
      })
      expect(typeof outcomeLine.at).toBe("string")
      expect(typeof outcomeLine.waited_ms).toBe("number")
      expect(typeof outcomeLine.confirm_wait_ms).toBe("number")
      expect(typeof outcomeLine.pre_send_ms).toBe("number")

      const serialized = warn.mock.calls.map((args) => String(args[0])).join("\n")
      expect(serialized).not.toMatch(/PRIVATE_SYNTHETIC|EV charging|Voice build request|Brief:/)
    })

    it("reports a send that settles after an unconfirmed result, and a run that appears later, as late lines", async () => {
      const session = createSession()
      session.onSend.messageId = MESSAGE_ID
      let release!: () => void
      session.onSend.hold = new Promise<void>((resolve) => { release = resolve })

      const result = await session.handler.execute(call(
        "start_builder_task",
        { description: "Research EV charging.", task_type: "research" },
        ["please research EV charging"],
      ))
      expect(result).toMatchObject({ ok: false, reason: "builder_start_unconfirmed", status: "unconfirmed" })
      const outcomeLine = diagRecords().find((record) => record.ev === "voice_builder.outcome")
      expect(outcomeLine).toMatchObject({ ok: false, outcome: "builder_start_unconfirmed", send_pending: true, send_settle_ms: null })

      release()
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      const settledLine = diagRecords().find((record) => record.ev === "voice_builder.late" && record.kind === "send_settled")
      expect(settledLine).toMatchObject({ call: outcomeLine?.call, message_id: MESSAGE_ID, outcome: "sent", send_error: null })
      expect(typeof settledLine?.late_ms).toBe("number")

      session.advance(2_000)
      session.state.task = { phase: "running", taskId: TASK_ID, runId: RUN_ID }
      session.handler.observe?.()
      const runLine = diagRecords().find((record) => record.ev === "voice_builder.late" && record.kind === "run_observed")
      expect(runLine).toMatchObject({ call: outcomeLine?.call, task_id: TASK_ID, run_id: RUN_ID, late_ms: 2_000 })
    })
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
