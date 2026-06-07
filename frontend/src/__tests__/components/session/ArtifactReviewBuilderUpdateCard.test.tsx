import { render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ArtifactReviewBuilderUpdateCard } from "../../../app/components/session/ArtifactReviewBuilderUpdateCard"

describe("ArtifactReviewBuilderUpdateCard", () => {
  it("shows completed HTML live-update copy without a View updated version CTA", () => {
    render(
      <ArtifactReviewBuilderUpdateCard
        artifactTitle="site.html"
        requestedChangeSummary="Make the page calmer."
        status="completed"
        outputTitle="site-v2.html"
        outputPath="mnt/user-data/outputs/site-v2.html"
        autoApplied
        versionLabel="Version 2 saved"
        restoreAvailable
        onRestoreOriginal={vi.fn()}
        onViewUpdatedVersion={vi.fn()}
      />,
    )

    const card = screen.getByTestId("artifact-review-builder-update-card")
    expect(within(card).getByText("Preview updated")).toBeInTheDocument()
    expect(within(card).getByText("Version 2 saved")).toBeInTheDocument()
    expect(within(card).getByText("Original preserved")).toBeInTheDocument()
    expect(within(card).getByRole("button", { name: /restore original/i })).toBeInTheDocument()
    expect(within(card).queryByRole("button", { name: /view updated version/i })).not.toBeInTheDocument()
    expect(card.textContent).not.toMatch(/task id|async task|tool|builder-thread-id|tracking task|listing builds|emit artifact/i)
  })

  it("shows truthful non-HTML output copy without pretending the preview was applied", () => {
    render(
      <ArtifactReviewBuilderUpdateCard
        artifactTitle="site.html"
        requestedChangeSummary="Create a PDF version."
        status="completed"
        outputTitle="site.pdf"
        outputPath="mnt/user-data/outputs/site.pdf"
        nonHtmlOutput
        onViewUpdatedVersion={vi.fn()}
      />,
    )

    const card = screen.getByTestId("artifact-review-builder-update-card")
    expect(within(card).getByText("New artifact created")).toBeInTheDocument()
    expect(within(card).getByText("A new artifact was created, but it is not an HTML update.")).toBeInTheDocument()
    expect(within(card).getByRole("button", { name: /open artifact/i })).toBeInTheDocument()
    expect(within(card).queryByText("Preview updated")).not.toBeInTheDocument()
  })

  it("shows applying copy before render confirmation", () => {
    render(
      <ArtifactReviewBuilderUpdateCard
        artifactTitle="site.html"
        requestedChangeSummary="Make the page calmer."
        status="applying"
        outputTitle="site-v2.html"
        outputPath="mnt/user-data/outputs/site-v2.html"
      />,
    )

    const card = screen.getByTestId("artifact-review-builder-update-card")
    expect(within(card).getByText("Applying update...")).toBeInTheDocument()
    expect(within(card).queryByText("Preview updated")).not.toBeInTheDocument()
  })

  it("shows preview refresh failure without claiming success", () => {
    render(
      <ArtifactReviewBuilderUpdateCard
        artifactTitle="site.html"
        requestedChangeSummary="Make the page calmer."
        status="preview_not_refreshed"
        outputTitle="site-v2.html"
        outputPath="mnt/user-data/outputs/site-v2.html"
      />,
    )

    const card = screen.getByTestId("artifact-review-builder-update-card")
    expect(within(card).getByText("Update built, but preview did not refresh.")).toBeInTheDocument()
    expect(within(card).getByText("Original preserved")).toBeInTheDocument()
    expect(within(card).queryByText("Preview updated")).not.toBeInTheDocument()
  })
})
