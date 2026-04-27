import { renderHook, waitFor, act } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useBuilderEvents } from "../../app/hooks/useBuilderEvents"
import type { BuilderCompletionEventV1 } from "../../app/types/builder-completion"

/**
 * Tests for the SSE subscription hook PR #87 shipped but never wired in.
 * PR-B finally consumes it. The hook has two responsibilities:
 *   1. Late-mount recovery: GET ``/builder-events/last`` to surface any
 *      event that fired while the tab was unmounted.
 *   2. Live subscription: open an EventSource on the SSE endpoint and
 *      yield each event back to the caller via state.
 *
 * These tests stub both fetch and EventSource so they run in jsdom
 * without hitting the network.
 */

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_EVENT_SOURCE = globalThis.EventSource

class FakeEventSource {
  public static instances: FakeEventSource[] = []
  public url: string
  public onmessage: ((event: MessageEvent) => void) | null = null
  public onerror: ((event: Event) => void) | null = null
  public readyState: number = 0
  public closed: boolean = false
  static OPEN = 1
  static CLOSED = 2

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  close() {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }

  emit(payload: BuilderCompletionEventV1) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent("message", { data: JSON.stringify(payload) }))
    }
  }
}

const SUCCESS_EVENT: BuilderCompletionEventV1 = {
  thread_id: "thread-1",
  task_id: "task-success",
  status: "success",
  artifact_url: "https://example.com/file.md",
  artifact_title: "Done",
  artifact_filename: "file.md",
}

const ERROR_EVENT: BuilderCompletionEventV1 = {
  thread_id: "thread-1",
  task_id: "task-fail",
  status: "error",
  task_brief: "Build a thing",
  error_message: "Anthropic API quota exhausted.",
}

beforeEach(() => {
  FakeEventSource.instances = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).EventSource = FakeEventSource
  globalThis.fetch = vi.fn(async () =>
    new Response(null, { status: 204 }),
  ) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).EventSource = ORIGINAL_EVENT_SOURCE
  vi.restoreAllMocks()
})

describe("useBuilderEvents", () => {
  it("returns null and skips network calls when disabled", () => {
    const { result } = renderHook(() => useBuilderEvents("thread-1", { enabled: false }))
    expect(result.current).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it("returns null and skips network calls when threadId is missing", () => {
    const { result } = renderHook(() => useBuilderEvents(null, { enabled: true }))
    expect(result.current).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it("hits /last on mount and surfaces a cached event before SSE delivers", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(SUCCESS_EVENT), { status: 200 }),
    ) as unknown as typeof fetch

    const { result } = renderHook(() => useBuilderEvents("thread-1", { enabled: true }))

    await waitFor(() => {
      expect(result.current).toEqual(SUCCESS_EVENT)
    })
    // /last endpoint was probed.
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/threads/thread-1/builder-events/last"),
      expect.any(Object),
    )
  })

  it("opens an EventSource when enabled and yields events to the caller", async () => {
    const { result } = renderHook(() => useBuilderEvents("thread-1", { enabled: true }))

    // Wait for the EventSource to be opened.
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1)
    })
    const source = FakeEventSource.instances[0]
    expect(source.url).toContain("/api/threads/thread-1/builder-events")

    // Simulate the gateway pushing a completion event.
    act(() => {
      source.emit(ERROR_EVENT)
    })

    await waitFor(() => {
      expect(result.current).toEqual(ERROR_EVENT)
    })
  })

  it("closes the EventSource on unmount", async () => {
    const { unmount } = renderHook(() => useBuilderEvents("thread-1", { enabled: true }))
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1)
    })
    const source = FakeEventSource.instances[0]
    unmount()
    expect(source.closed).toBe(true)
  })

  it("ignores malformed SSE payloads instead of crashing", async () => {
    const { result } = renderHook(() => useBuilderEvents("thread-1", { enabled: true }))
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1)
    })
    const source = FakeEventSource.instances[0]
    act(() => {
      source.onmessage?.(new MessageEvent("message", { data: "not-json" }))
    })
    // No crash, no event surfaced.
    expect(result.current).toBeNull()
  })
})
