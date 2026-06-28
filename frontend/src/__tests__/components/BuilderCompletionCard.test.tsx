import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { BuilderCompletionCard } from "../../app/components/session/BuilderCompletionCard"
import type { BuilderCompletionEventV1 } from "../../app/types/builder-completion"

const SUCCESS_EVENT: BuilderCompletionEventV1 = {
  thread_id: "thread-1",
  task_id: "task-1",
  status: "success",
  task_brief: "Write a one-pager about LLM time-series solutions.",
  artifact_path: "mnt/user-data/outputs/llm_time_series.md",
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
  vi.stubGlobal("open", vi.fn())
})

describe("BuilderCompletionCard — success variant", () => {
  it("renders the artifact title and summary", () => {
    render(<BuilderCompletionCard event={SUCCESS_EVENT} />)
    expect(screen.getByText("LLM Time-Series Solutions")).toBeTruthy()
    expect(screen.getByText(/focused one-pager/i)).toBeTruthy()
    expect(screen.getByText("ready")).toBeTruthy()
  })

  it("selects the artifact for in-session preview when View in canvas is clicked", () => {
    const onOpen = vi.fn()
    render(<BuilderCompletionCard event={SUCCESS_EVENT} onOpen={onOpen} />)
    const button = screen.getByRole("button", { name: /view in canvas/i })
    fireEvent.click(button)
    expect(window.open).not.toHaveBeenCalled()
    expect(onOpen).toHaveBeenCalledWith(SUCCESS_EVENT)
  })

  it("keeps Open in new tab as a secondary same-origin action", () => {
    render(<BuilderCompletionCard event={SUCCESS_EVENT} onOpen={vi.fn()} />)
    const link = screen.getByRole("link", { name: /open artifact in new tab/i })
    expect(link).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/llm_time_series.md",
    )
    expect(link).toHaveAttribute("target", "_blank")
  })

  it("uses the signed URL as Open in new tab when artifact_path is missing", () => {
    const event: BuilderCompletionEventV1 = {
      ...SUCCESS_EVENT,
      artifact_path: undefined,
    }

    render(<BuilderCompletionCard event={event} onOpen={vi.fn()} />)
    expect(screen.queryByRole("button", { name: /view in canvas/i })).toBeNull()
    expect(screen.getByRole("link", { name: /open artifact in new tab/i })).toHaveAttribute(
      "href",
      "https://example.com/llm_time_series.md",
    )
  })

  it("does NOT show retry on success", () => {
    render(<BuilderCompletionCard event={SUCCESS_EVENT} />)
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull()
  })

  it("renders a Download anchor with the same-origin proxy and download attribute", () => {
    render(<BuilderCompletionCard event={SUCCESS_EVENT} />)
    const link = screen.getByRole("link", { name: /download/i })
    expect(link.getAttribute("href")).toBe(
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/llm_time_series.md?download=true",
    )
    // The download attribute makes the browser save instead of navigating.
    expect(link.hasAttribute("download")).toBe(true)
    // Filename hint is preferred over the boolean form.
    expect(link.getAttribute("download")).toBe(SUCCESS_EVENT.artifact_filename)
  })

  it("falls back to artifact_path when the signed URL is missing", () => {
    const event: BuilderCompletionEventV1 = {
      ...SUCCESS_EVENT,
      artifact_url: undefined,
    }

    render(<BuilderCompletionCard event={event} onOpen={vi.fn()} />)
    expect(screen.getByRole("button", { name: /view in canvas/i })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /open artifact in new tab/i })).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/llm_time_series.md",
    )
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/llm_time_series.md?download=true",
    )
  })

  it("explains when a successful completion has no artifact action yet", () => {
    const event: BuilderCompletionEventV1 = {
      ...SUCCESS_EVENT,
      artifact_path: undefined,
      artifact_url: undefined,
    }

    render(<BuilderCompletionCard event={event} />)
    expect(screen.queryByRole("button", { name: /view in canvas/i })).toBeNull()
    expect(screen.queryByRole("link", { name: /open artifact in new tab/i })).toBeNull()
    expect(screen.queryByRole("link", { name: /download/i })).toBeNull()
    expect(screen.getByText(/keep checking the library/i)).toBeTruthy()
  })

  it("does not claim a file is ready when success has no title or action", () => {
    const event: BuilderCompletionEventV1 = {
      ...SUCCESS_EVENT,
      artifact_path: undefined,
      artifact_url: undefined,
      artifact_title: undefined,
      artifact_filename: undefined,
    }

    render(<BuilderCompletionCard event={event} />)
    expect(screen.queryByText("Your file is ready.")).toBeNull()
    expect(screen.getByText("Artifact delivery is pending.")).toBeTruthy()
  })

  it("invokes onDownload when the Download link is clicked", () => {
    const onDownload = vi.fn()
    render(<BuilderCompletionCard event={SUCCESS_EVENT} onDownload={onDownload} />)
    const link = screen.getByRole("link", { name: /download/i })
    fireEvent.click(link)
    expect(onDownload).toHaveBeenCalledWith(SUCCESS_EVENT)
  })

  it("treats PowerPoint artifacts as download-first", () => {
    const event: BuilderCompletionEventV1 = {
      ...SUCCESS_EVENT,
      artifact_path: "mnt/user-data/outputs/research_deck.pptx",
      artifact_url: "https://example.com/research_deck.pptx",
      artifact_filename: "research_deck.pptx",
      artifact_type: "presentation",
    }

    render(<BuilderCompletionCard event={event} />)

    expect(screen.queryByRole("button", { name: /view in canvas/i })).toBeNull()
    expect(screen.queryByRole("link", { name: /open artifact in new tab/i })).toBeNull()
    const link = screen.getByRole("link", { name: /download/i })
    expect(link).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/research_deck.pptx?download=true",
    )
    expect(link).toHaveAttribute("download", "research_deck.pptx")
  })

  it("downloads the .pptx, never the .preview.pdf, for a deck with artifact_files", () => {
    // Regression (prod 019f0b8a): the delivery card must resolve the DOWNLOAD to
    // the primary deliverable (.pptx), never the render-only .preview.pdf. Even
    // if artifact_path points at the preview, the role-aware selection picks the
    // primary .pptx from artifact_files.
    const event: BuilderCompletionEventV1 = {
      ...SUCCESS_EVENT,
      artifact_path: "mnt/user-data/outputs/research_deck.preview.pdf",
      artifact_url: undefined,
      artifact_filename: "research_deck.preview.pdf",
      artifact_type: "presentation",
      artifact_files: [
        { path: "mnt/user-data/outputs/research_deck.pptx", role: "primary", name: "research_deck.pptx" },
        { path: "mnt/user-data/outputs/research_deck.preview.pdf", role: "preview", name: "research_deck.preview.pdf" },
      ],
    }

    render(<BuilderCompletionCard event={event} />)

    const link = screen.getByRole("link", { name: /download/i })
    expect(link).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/research_deck.pptx?download=true",
    )
    expect(link.getAttribute("href")).not.toContain(".preview.pdf")
  })

  it("labels usable HTML fallbacks for slide deck requests explicitly", () => {
    const event: BuilderCompletionEventV1 = {
      ...SUCCESS_EVENT,
      artifact_path: "mnt/user-data/outputs/research_deck.html",
      artifact_url: undefined,
      artifact_filename: "research_deck.html",
      artifact_type: "webpage",
      requested_artifact_ext: "pptx",
      artifact_ext: "html",
      artifact_is_fallback: true,
      fallback_reason: "pptx_generation_not_completed",
      summary: undefined,
    }

    render(<BuilderCompletionCard event={event} onOpen={vi.fn()} />)

    expect(screen.getByText("HTML fallback ready.")).toBeInTheDocument()
    expect(screen.getByText("html fallback")).toBeInTheDocument()
    expect(screen.getByText(/couldn’t finish the PowerPoint package/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /view in canvas/i })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /open artifact in new tab/i })).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/research_deck.html",
    )
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/research_deck.html?download=true",
    )
  })

  it("does NOT render Download on error/timeout/cancelled states", () => {
    const errorEvent = {
      ...SUCCESS_EVENT,
      status: "error" as const,
      artifact_url: undefined,
    }
    render(<BuilderCompletionCard event={errorEvent} />)
    expect(screen.queryByRole("link", { name: /download/i })).toBeNull()
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
    expect(screen.queryByRole("button", { name: /view in canvas/i })).toBeNull()
    expect(screen.queryByRole("link", { name: /open artifact in new tab/i })).toBeNull()
  })

  it("surfaces a safe diagnostic reason when no error_message is provided", () => {
    const event: BuilderCompletionEventV1 = {
      ...ERROR_EVENT,
      error_message: null,
      builder_failure_diagnostics: {
        schema: "builder_failure_diagnostics_v1",
        failure_code: "html_invalid_artifact_extension",
        failure_stage: "emit_rejected",
        failure_reason: "Builder rejected HTML output because it was not a standalone .html file.",
        emit_attempted: true,
        raw_content_excluded: true,
        raw_artifact_text_excluded: true,
        raw_frame_excluded: true,
        secrets_excluded: true,
      },
    }
    render(<BuilderCompletionCard event={event} />)
    expect(screen.getByText("Builder rejected HTML output because it was not a standalone .html file.")).toBeTruthy()
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

  it("prefers the backend budget-stop message when present", () => {
    const event: BuilderCompletionEventV1 = {
      ...TIMEOUT_EVENT,
      error_message: "Sorry, we hit the token limit for this task. Please let me know if you want to try again.",
      budget_stop_reason: "token_limit",
    }

    render(<BuilderCompletionCard event={event} />)

    expect(screen.getByText(/hit the token limit/i)).toBeTruthy()
    expect(screen.queryByText(/took longer than expected/i)).toBeNull()
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
