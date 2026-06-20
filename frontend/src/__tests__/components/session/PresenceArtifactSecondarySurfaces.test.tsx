import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { PresenceArtifactSecondarySurfaces } from "../../../app/components/session/PresenceArtifactSecondarySurfaces"
import type { ArtifactRecord, ArtifactSessionIndex } from "../../../app/lib/session-artifact-index"

const baseRecord: ArtifactRecord = {
  artifactId: "artifact-pdf",
  stableArtifactIdentity: "stable-pdf",
  logicalArtifactId: "logical-pdf",
  versionId: "logical-pdf::v1",
  parentVersionId: null,
  userId: "user-1",
  threadId: "thread-1",
  sessionId: "session-1",
  parentThreadId: null,
  taskId: null,
  runId: null,
  title: "First PDF",
  artifactType: "pdf",
  rendererKind: "pdf",
  mimeType: "application/pdf",
  localPath: "mnt/user-data/outputs/first.pdf",
  storageProvider: "local",
  storageBucket: null,
  storageObjectPath: null,
  signedUrl: null,
  signedUrlExpiresAt: null,
  createdAt: "2026-06-07T12:00:00.000Z",
  updatedAt: "2026-06-07T12:00:00.000Z",
  sourceArtifactPath: null,
  revisionOfArtifactPath: null,
  sourceHash: null,
  contentHash: null,
  capabilities: null,
  review: null,
  safeSummary: null,
  rawContentExcluded: true,
}

function renderTray({
  index,
  onSessionArtifactOpen = vi.fn(),
}: {
  index: ArtifactSessionIndex
  onSessionArtifactOpen?: (artifact: ArtifactRecord) => void
}) {
  render(
    <PresenceArtifactSecondarySurfaces
      artifacts={null}
      builderArtifactLibrary={[]}
      stageBuilderArtifact={null}
      sessionArtifactIndex={index}
      showSecondaryArtifactSurfaces
      showDomArtifactCoReview={false}
      threadId="thread-1"
      sessionId="session-1"
      normalSessionId="session-1"
      revealStep={1}
      isActive
      bloomColor="var(--sophia-purple)"
      reflectionTapped={false}
      domArtifactCoReview={{
        state: { state: "idle" },
        transportStatus: { statusText: "idle" },
        canStart: false,
        enabled: false,
        startReview: vi.fn(),
        stopReview: vi.fn(),
      } as never}
      onSelectedBuilderArtifactPathChange={vi.fn()}
      onSessionArtifactOpen={onSessionArtifactOpen}
      onHandleReflectionTap={vi.fn()}
      onDomArtifactRootChange={vi.fn()}
    />,
  )
}

describe("PresenceArtifactSecondarySurfaces artifact tray", () => {
  it("lists multiple artifacts and highlights the active one", () => {
    const htmlRecord: ArtifactRecord = {
      ...baseRecord,
      artifactId: "artifact-html",
      stableArtifactIdentity: "stable-html",
      logicalArtifactId: "logical-html",
      versionId: "logical-html::v1",
      title: "Second HTML",
      artifactType: "webpage",
      rendererKind: "html",
      mimeType: "text/html",
      localPath: "mnt/user-data/outputs/second.html",
      createdAt: "2026-06-07T12:05:00.000Z",
      updatedAt: "2026-06-07T12:05:00.000Z",
    }
    renderTray({
      index: {
        userId: "user-1",
        threadId: "thread-1",
        sessionId: "session-1",
        artifacts: [baseRecord, htmlRecord],
        activeArtifactId: "artifact-pdf",
        recentlyOpenedArtifactIds: ["artifact-pdf"],
      },
    })

    expect(screen.getByText("Artifacts")).toBeInTheDocument()
    expect(screen.getByText("First PDF")).toBeInTheDocument()
    expect(screen.getByText("Second HTML")).toBeInTheDocument()
    expect(screen.getByLabelText("View First PDF in canvas")).toHaveAttribute("aria-pressed", "true")
  })

  it("opens a previous artifact from the tray", () => {
    const onSessionArtifactOpen = vi.fn()
    const htmlRecord: ArtifactRecord = {
      ...baseRecord,
      artifactId: "artifact-html",
      stableArtifactIdentity: "stable-html",
      logicalArtifactId: "logical-html",
      versionId: "logical-html::v1",
      title: "Second HTML",
      artifactType: "webpage",
      rendererKind: "html",
      mimeType: "text/html",
      localPath: "mnt/user-data/outputs/second.html",
    }
    renderTray({
      index: {
        userId: "user-1",
        threadId: "thread-1",
        sessionId: "session-1",
        artifacts: [baseRecord, htmlRecord],
        activeArtifactId: "artifact-pdf",
        recentlyOpenedArtifactIds: ["artifact-pdf"],
      },
      onSessionArtifactOpen,
    })

    fireEvent.click(screen.getByLabelText("View Second HTML in canvas"))
    expect(onSessionArtifactOpen).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: "artifact-html",
      localPath: "mnt/user-data/outputs/second.html",
      rendererKind: "html",
    }))
  })

  it("hides deck preview PDFs from artifact tray rows", () => {
    const deckRecord: ArtifactRecord = {
      ...baseRecord,
      artifactId: "artifact-deck",
      stableArtifactIdentity: "stable-deck",
      logicalArtifactId: "logical-deck",
      versionId: "logical-deck::v1",
      title: "Deck",
      artifactType: "presentation",
      rendererKind: "download_only",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      localPath: "mnt/user-data/outputs/deck.pptx",
    }
    const previewRecord: ArtifactRecord = {
      ...baseRecord,
      artifactId: "artifact-deck-preview",
      stableArtifactIdentity: "stable-deck-preview",
      logicalArtifactId: "logical-deck-preview",
      versionId: "logical-deck-preview::v1",
      title: "deck.preview.pdf",
      artifactType: "pdf",
      rendererKind: "pdf",
      mimeType: "application/pdf",
      localPath: "mnt/user-data/outputs/deck.preview.pdf",
    }
    renderTray({
      index: {
        userId: "user-1",
        threadId: "thread-1",
        sessionId: "session-1",
        artifacts: [previewRecord, deckRecord],
        activeArtifactId: "artifact-deck",
        recentlyOpenedArtifactIds: [],
      },
    })

    expect(screen.getByText("Deck")).toBeInTheDocument()
    expect(screen.queryByText("deck.preview.pdf")).not.toBeInTheDocument()
  })

  it("shows a safe unavailable state for missing artifacts", () => {
    renderTray({
      index: {
        userId: "user-1",
        threadId: "thread-1",
        sessionId: "session-1",
        artifacts: [{
          ...baseRecord,
          review: { missing: true },
        }],
        activeArtifactId: null,
        recentlyOpenedArtifactIds: [],
      },
    })

    expect(screen.getByText(/Unavailable/u)).toBeInTheDocument()
    expect(screen.getByLabelText("View First PDF in canvas")).toBeDisabled()
  })
})
