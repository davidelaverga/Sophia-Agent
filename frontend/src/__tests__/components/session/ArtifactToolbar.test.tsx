import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ArtifactToolbar } from "../../../app/components/session/ArtifactToolbar"

vi.mock("../../../app/hooks/useHaptics", () => ({
  haptic: vi.fn(),
}))

describe("ArtifactToolbar", () => {
  it("keeps open and download actions while hiding unsupported zoom controls", () => {
    render(
      <ArtifactToolbar
        title="Launch brief"
        openHref="/artifact.md"
        downloadHref="/artifact.md?download=true"
        downloadName="artifact.md"
      />,
    )

    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument()
    expect(screen.getByLabelText("Open Launch brief in new tab")).toHaveAttribute("href", "/artifact.md")
    expect(screen.getByLabelText("Download Launch brief")).toHaveAttribute("download", "artifact.md")
    expect(screen.queryByLabelText("Zoom out")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Zoom in")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Fit to view")).not.toBeInTheDocument()
  })
})
