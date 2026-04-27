import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { BuilderCompletionCard } from "../../app/components/session/BuilderCompletionCard"
import type { BuilderCompletionEventV1 } from "../../app/types/builder-completion"

const SUCCESS_EVENT: BuilderCompletionEventV1 = {
  thread_id: "thread-1",
  task_id: "task-1",
  status: "success",
  task_brief: "Write a one-pager about LLM time-series solutions.",
  artifact_url: "https://example.com/llm_time_series.md",
  artifact_title: "LLM Time-Series Solutions",
  artifact_type: "document",
  artifact_filename: "llm_time_series.md",
  summary: "A focused one-pager covering the major architectures.",
  user_next_action: "Open and review.",
}

const ERROR_EVENT: BuilderCompletionEventV1 = {
  thread_id: "thread-1",
  task_id: "task-2",
  status: "error",
  task_brief: "Build a 5-slide investor deck.",
  error_message: undefined,
}

const TIMEOUT_EVENT: BuilderCompletionEventV1 = {
  thread_id: "thread-1",
  task_id: "task-3",
  status: "timeout",
  task_brief: "Compile a market analysis report.",
}

const CANCELLED_EVENT: BuilderCompletionEventV1 = {
  thread_id: "thread-1",
  task_id: "task-4",
  status: "cancelled",
  task_brief: "Generate a meeting agenda.",
}

beforeEach(() => {
  // Vitest's window.open mock — happy-dom doesn't ship one by default in
  // the configuration this repo uses.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window.open as unknown) = vi.fn()
})

describe("BuilderCompletionCard — success variant", () => {
  it("renders the artifact title and summary", () => {
    render(<BuilderCompletionCard event={SUCCESS_EVENT} />)
    expect(screen.getByText("LLM Time-Series Solutions")).toBeTruthy()
    expect(screen.getByText(/focused one-pager/i)).toBeTruthy()
    expect(screen.getByText("ready")).toBeTruthy()
  })

  it("opens the artifact URL in a new tab when 'open' is clicked", () => {
    const onOpen = vi.fn()
    render(<BuilderCompletionCard event={SUCCESS_EVENT} onOpen={onOpen} />)
    const button = screen.getByRole("button", { name: /open/i })
    fireEvent.click(button)
    expect(window.open).toHaveBeenCalledWith(
      "https://example.com/llm_time_series.md",
      "_blank",
      "noopener,noreferrer",
    )
    expect(onOpen).toHaveBeenCalledWith(SUCCESS_EVENT)
  })

  it("does NOT show retry on success", () => {
    render(<BuilderCompletionCard event={SUCCESS_EVENT} />)
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull()
  })
})

describe("BuilderCompletionCard — error variant", () => {
  it("shows the apology + retry copy", () => {
    render(<BuilderCompletionCard event={ERROR_EVENT} />)
    expect(screen.getByText(/Sorry it seems like the task didn’t complete/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy()
  })

  it("includes the original task brief so users can correlate", () => {
    render(<BuilderCompletionCard event={ERROR_EVENT} />)
    expect(screen.getByText(/about: Build a 5-slide investor deck/)).toBeTruthy()
  })

  it("invokes onRetry with the event when 'try again' is clicked", () => {
    const onRetry = vi.fn()
    render(<BuilderCompletionCard event={ERROR_EVENT} onRetry={onRetry} />)
    fireEvent.click(screen.getByRole("button", { name: /try again/i }))
    expect(onRetry).toHaveBeenCalledWith(ERROR_EVENT)
  })

  it("does NOT show open on error (no artifact_url)", () => {
    render(<BuilderCompletionCard event={ERROR_EVENT} />)
    expect(screen.queryByRole("button", { name: /open/i })).toBeNull()
  })

  it("surfaces a custom error_message when provided", () => {
    const event: BuilderCompletionEventV1 = {
      ...ERROR_EVENT,
      error_message: "Anthropic API quota exhausted.",
    }
    render(<BuilderCompletionCard event={event} />)
    expect(screen.getByText("Anthropic API quota exhausted.")).toBeTruthy()
  })
})

describe("BuilderCompletionCard — timeout variant", () => {
  it("shows the timeout body and retry button", () => {
    render(<BuilderCompletionCard event={TIMEOUT_EVENT} />)
    expect(screen.getByText(/took longer than expected/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy()
  })
})

describe("BuilderCompletionCard — cancelled variant", () => {
  it("shows cancellation copy without retry", () => {
    render(<BuilderCompletionCard event={CANCELLED_EVENT} />)
    expect(screen.getByText(/Build was cancelled/i)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull()
  })
})

describe("BuilderCompletionCard — dismiss", () => {
  it("renders the dismiss button when onDismiss is provided", () => {
    const onDismiss = vi.fn()
    render(<BuilderCompletionCard event={SUCCESS_EVENT} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledWith(SUCCESS_EVENT)
  })

  it("does NOT render dismiss when onDismiss is omitted", () => {
    render(<BuilderCompletionCard event={SUCCESS_EVENT} />)
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull()
  })
})
