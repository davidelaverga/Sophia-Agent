import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SessionArtifactTrayLauncher } from "../../../app/components/session/SessionArtifactTrayLauncher"
import {
  clearArtifactSessionIndexForTests,
  loadArtifactSessionIndex,
  registerArtifactInSessionIndex,
  type ArtifactRecord,
  type ArtifactSessionIndex,
} from "../../../app/lib/session-artifact-index"

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
  title: "Quarterly Report",
  artifactType: "pdf",
  rendererKind: "pdf",
  mimeType: "application/pdf",
  localPath: "mnt/user-data/outputs/quarterly-report.pdf",
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
  contentHash: "hash-should-never-render",
  capabilities: null,
  review: null,
  safeSummary: null,
  rawContentExcluded: true,
}

const htmlRecord: ArtifactRecord = {
  ...baseRecord,
  artifactId: "artifact-html",
  stableArtifactIdentity: "stable-html",
  logicalArtifactId: "logical-html",
  versionId: "logical-html::v1",
  title: "Orca Explainer Page",
  artifactType: "webpage",
  rendererKind: "html",
  mimeType: "text/html",
  localPath: "mnt/user-data/outputs/orca-explainer.html",
  createdAt: "2026-06-07T12:05:00.000Z",
  updatedAt: "2026-06-07T12:05:00.000Z",
}

function buildIndex(overrides: Partial<ArtifactSessionIndex> = {}): ArtifactSessionIndex {
  return {
    userId: "user-1",
    threadId: "thread-1",
    sessionId: "session-1",
    artifacts: [baseRecord, htmlRecord],
    activeArtifactId: null,
    recentlyOpenedArtifactIds: [],
    ...overrides,
  }
}

function renderLauncher({
  index,
  onSessionArtifactOpen = vi.fn(),
}: {
  index: ArtifactSessionIndex | null
  onSessionArtifactOpen?: (artifact: ArtifactRecord) => void
}) {
  render(
    <SessionArtifactTrayLauncher
      sessionArtifactIndex={index}
      threadId="thread-1"
      onSessionArtifactOpen={onSessionArtifactOpen}
    />,
  )
  return { onSessionArtifactOpen }
}

beforeEach(() => {
  clearArtifactSessionIndexForTests()
})

describe("SessionArtifactTrayLauncher", () => {
  it("shows the Artifacts entry with a count badge matching the artifact count", () => {
    renderLauncher({ index: buildIndex() })

    const launcher = screen.getByTestId("session-artifact-tray-launcher")
    expect(launcher).toBeInTheDocument()
    expect(launcher).toHaveTextContent("Artifacts")
    expect(screen.getByTestId("session-artifact-tray-count")).toHaveTextContent("2")
    // Premium product styling, not a raw debug list.
    expect(launcher.className).toContain("rounded-full")
    expect(launcher.className).toContain("backdrop-blur-xl")
  })

  it("renders nothing when the session artifact index is empty", () => {
    renderLauncher({ index: buildIndex({ artifacts: [] }) })
    expect(screen.queryByTestId("session-artifact-tray-launcher")).not.toBeInTheDocument()

    renderLauncher({ index: null })
    expect(screen.queryByTestId("session-artifact-tray-launcher")).not.toBeInTheDocument()
  })

  it("opens the panel and routes View in canvas through the existing open flow", () => {
    const { onSessionArtifactOpen } = renderLauncher({ index: buildIndex() })

    expect(screen.queryByTestId("session-artifact-tray-panel")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("session-artifact-tray-launcher"))

    const panel = screen.getByTestId("session-artifact-tray-panel")
    expect(panel).toBeInTheDocument()
    expect(screen.getAllByTestId("session-artifact-tray-row")).toHaveLength(2)
    expect(screen.getByText("Quarterly Report")).toBeInTheDocument()
    expect(screen.getByText("Orca Explainer Page")).toBeInTheDocument()
    // Type / renderer metadata is surfaced per row.
    expect(screen.getByText(/Pdf • Pdf • v1/u)).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText("View Orca Explainer Page in canvas"))
    expect(onSessionArtifactOpen).toHaveBeenCalledTimes(1)
    expect(onSessionArtifactOpen).toHaveBeenCalledWith(expect.objectContaining({ artifactId: "artifact-html" }))
    // Selecting an artifact closes the tray panel.
    expect(screen.queryByTestId("session-artifact-tray-panel")).not.toBeInTheDocument()
  })

  it("marks the active artifact with an Active badge", () => {
    renderLauncher({ index: buildIndex({ activeArtifactId: "artifact-pdf" }) })

    fireEvent.click(screen.getByTestId("session-artifact-tray-launcher"))
    const rows = screen.getAllByTestId("session-artifact-tray-row")
    const activeRow = rows.find((row) => row.textContent?.includes("Quarterly Report"))
    expect(activeRow?.textContent).toContain("Active")
    const otherRow = rows.find((row) => row.textContent?.includes("Orca Explainer Page"))
    expect(otherRow?.textContent).not.toContain("Active")
  })

  it("shows artifacts restored from localStorage after a refresh", () => {
    const context = { userId: "user-1", threadId: "thread-1", sessionId: "session-1" }
    registerArtifactInSessionIndex({
      context,
      localPath: "mnt/user-data/outputs/restored-report.pdf",
      title: "Restored Report",
      rendererKind: "pdf",
      artifactType: "pdf",
      source: "builder_completion",
    })

    const restored = loadArtifactSessionIndex(context)
    expect(restored.artifacts).toHaveLength(1)

    renderLauncher({ index: restored })
    expect(screen.getByTestId("session-artifact-tray-count")).toHaveTextContent("1")
    fireEvent.click(screen.getByTestId("session-artifact-tray-launcher"))
    expect(screen.getByText("Restored Report")).toBeInTheDocument()
  })

  it("disables actions for missing artifacts instead of offering dead links", () => {
    const missingRecord: ArtifactRecord = {
      ...baseRecord,
      review: { missing: true },
    }
    renderLauncher({ index: buildIndex({ artifacts: [missingRecord] }) })

    fireEvent.click(screen.getByTestId("session-artifact-tray-launcher"))
    expect(screen.getByLabelText("View Quarterly Report in canvas")).toBeDisabled()
    expect(screen.queryByLabelText("Open Quarterly Report in new tab")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Download Quarterly Report")).not.toBeInTheDocument()
    expect(screen.getByText(/Unavailable/u)).toBeInTheDocument()
  })

  it("never renders raw artifact content, hashes, or paths as visible text", () => {
    renderLauncher({ index: buildIndex() })
    fireEvent.click(screen.getByTestId("session-artifact-tray-launcher"))

    const panel = screen.getByTestId("session-artifact-tray-panel")
    expect(panel.textContent).not.toContain("hash-should-never-render")
    expect(panel.textContent).not.toContain("mnt/user-data/outputs")
    expect(panel.textContent).not.toContain("<html")
  })
})
