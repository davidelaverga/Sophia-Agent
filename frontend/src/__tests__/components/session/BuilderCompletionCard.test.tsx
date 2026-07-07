import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { BuilderCompletionCard } from "../../../app/components/session/BuilderCompletionCard"
import type { BuilderCompletionEventV1 } from "../../../app/types/builder-completion"

function deckCompletionEvent(overrides: Partial<BuilderCompletionEventV1> = {}): BuilderCompletionEventV1 {
  return {
    thread_id: "thread-1",
    task_id: "task-1",
    status: "success",
    artifact_path: "mnt/user-data/outputs/deck.pptx",
    artifact_title: "Deck",
    artifact_filename: "deck.pptx",
    artifact_ext: "pptx",
    artifact_files: [
      {
        path: "mnt/user-data/outputs/deck.pptx",
        name: "deck.pptx",
        role: "primary",
      },
      {
        path: "mnt/user-data/outputs/deck.preview.pdf",
        name: "deck.preview.pdf",
        role: "preview",
      },
    ],
    ...overrides,
  }
}

describe("BuilderCompletionCard", () => {
  it("keeps deck preview reachable while downloads target the PPTX", () => {
    const onOpen = vi.fn()
    render(<BuilderCompletionCard event={deckCompletionEvent()} onOpen={onOpen} />)

    fireEvent.click(screen.getByRole("button", { name: /view in canvas/i }))

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({
      artifact_path: "mnt/user-data/outputs/deck.preview.pdf",
    }))
    expect(screen.getByRole("link", { name: "Download artifact" })).toHaveAttribute(
      "href",
      "/api/threads/thread-1/artifacts/mnt/user-data/outputs/deck.pptx?download=true",
    )
  })

  it("keeps download-first decks without a preview out of the canvas action", () => {
    const onOpen = vi.fn()
    render(
      <BuilderCompletionCard
        event={deckCompletionEvent({
          artifact_files: [
            {
              path: "mnt/user-data/outputs/deck.pptx",
              name: "deck.pptx",
              role: "primary",
            },
          ],
        })}
        onOpen={onOpen}
      />,
    )

    expect(screen.queryByRole("button", { name: /view in canvas/i })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Download artifact" })).toBeInTheDocument()
  })
})
