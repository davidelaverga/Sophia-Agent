import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  clearArtifactCanvasOpenState,
  hashArtifactCanvasRestoreIdentity,
  persistArtifactCanvasOpenState,
  restoreArtifactCanvasOpenState,
  type ArtifactCanvasOpenStateV1,
  type ArtifactCanvasRestoreContext,
} from "../../app/lib/artifact-canvas-restore-state"

const context: ArtifactCanvasRestoreContext = {
  userId: "user-1",
  threadId: "thread-1",
  sessionId: "session-1",
}

function storageKeyFor(hash: string | null) {
  return hash ? `sophia:artifact-canvas-open:v1:${hash}` : null
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe("artifact canvas restore state", () => {
  it("persists and restores the open artifact state with normalized path identity", () => {
    const saved = persistArtifactCanvasOpenState(context, {
      artifactPath: "/mnt/user-data/outputs/launch-brief.pdf",
      rendererKind: "pdf",
    })

    expect(saved.result).toBe("saved")
    expect(saved.state).toMatchObject({
      open: true,
      userId: "user-1",
      threadId: "thread-1",
      sessionId: "session-1",
      normalizedArtifactPath: "mnt/user-data/outputs/launch-brief.pdf",
      rendererKind: "pdf",
    })
    expect(saved.state?.stableArtifactIdentity).toContain("path:mnt/user-data/outputs/launch-brief.pdf")
    expect(saved.state?.stableArtifactIdentityHash).toBe(hashArtifactCanvasRestoreIdentity(saved.state?.stableArtifactIdentity))

    const restored = restoreArtifactCanvasOpenState(context)

    expect(restored.result).toBe("restored")
    expect(restored.storageKeyHash).toBe(saved.storageKeyHash)
    expect(restored.state).toMatchObject({
      normalizedArtifactPath: "mnt/user-data/outputs/launch-brief.pdf",
      rendererKind: "pdf",
    })
  })

  it("does not reopen after the stored open state is intentionally cleared", () => {
    const saved = persistArtifactCanvasOpenState(context, {
      artifactPath: "outputs/launch-brief.pdf",
      rendererKind: "pdf",
    })
    expect(saved.result).toBe("saved")

    const cleared = clearArtifactCanvasOpenState(context)
    expect(cleared.result).toBe("cleared")

    expect(restoreArtifactCanvasOpenState(context)).toMatchObject({
      result: "empty",
      state: null,
    })
  })

  it("does not restore across a different thread or session context", () => {
    persistArtifactCanvasOpenState(context, {
      artifactPath: "outputs/launch-brief.pdf",
      rendererKind: "pdf",
    })

    expect(restoreArtifactCanvasOpenState({
      ...context,
      threadId: "thread-2",
    })).toMatchObject({
      result: "empty",
      state: null,
    })
    expect(restoreArtifactCanvasOpenState({
      ...context,
      sessionId: "session-2",
    })).toMatchObject({
      result: "empty",
      state: null,
    })
  })

  it("rejects a stored state whose embedded context no longer matches", () => {
    const saved = persistArtifactCanvasOpenState(context, {
      artifactPath: "outputs/launch-brief.pdf",
      rendererKind: "pdf",
    })
    const key = storageKeyFor(saved.storageKeyHash)
    expect(key).toBeTruthy()

    const raw = JSON.parse(window.localStorage.getItem(key ?? "") ?? "{}") as ArtifactCanvasOpenStateV1
    window.localStorage.setItem(key ?? "", JSON.stringify({
      ...raw,
      threadId: "thread-2",
    }))

    expect(restoreArtifactCanvasOpenState(context)).toMatchObject({
      result: "context_mismatch",
      state: null,
    })
  })

  it("fails safely and clears corrupt stored canvas restore state", () => {
    const saved = persistArtifactCanvasOpenState(context, {
      artifactPath: "outputs/launch-brief.pdf",
      rendererKind: "pdf",
    })
    const key = storageKeyFor(saved.storageKeyHash)
    expect(key).toBeTruthy()
    window.localStorage.setItem(key ?? "", "{not-json")

    expect(restoreArtifactCanvasOpenState(context)).toMatchObject({
      result: "corrupt",
      state: null,
    })
    expect(window.localStorage.getItem(key ?? "")).toBeNull()
  })
})
