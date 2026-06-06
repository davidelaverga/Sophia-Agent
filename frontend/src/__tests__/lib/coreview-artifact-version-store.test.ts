import { beforeEach, describe, expect, it } from "vitest"

import {
  clearCoreviewArtifactVersionStoreForTests,
  createVersionFromBuilderOutput,
  getCurrentVersion,
  getVersionTelemetry,
  restoreOriginalVersion,
  selectArtifactVersion,
} from "../../app/lib/coreview-artifact-version-store"

const WORKSPACE_KEY = "user:unknown|thread:thread-1"
const LOGICAL_ID = "user:unknown|thread:thread-1|path:mnt/user-data/outputs/site.html|renderer:html"

function createHtmlVersion(options: {
  workspaceKey?: string
  logicalArtifactId?: string
  outputPath?: string
  voiceAgentSessionId?: string
} = {}) {
  return createVersionFromBuilderOutput({
    workspaceKey: options.workspaceKey ?? WORKSPACE_KEY,
    logicalArtifactId: options.logicalArtifactId ?? LOGICAL_ID,
    original: {
      artifactStableIdentity: LOGICAL_ID,
      artifactPath: "mnt/user-data/outputs/site.html",
      artifactTitle: "site.html",
      rendererKind: "html",
    },
    output: {
      artifactStableIdentity: "user:unknown|thread:thread-1|path:mnt/user-data/outputs/site-v2.html|renderer:html",
      artifactPath: options.outputPath ?? "mnt/user-data/outputs/site-v2.html",
      artifactTitle: "site-v2.html",
      rendererKind: "html",
    },
    builderTaskId: "task-1",
    requestedChangeSummary: "Make the hero calmer.",
    createdAt: "2026-06-06T12:00:00.000Z",
    ...(
      options.voiceAgentSessionId
        ? { voiceAgentSessionId: options.voiceAgentSessionId }
        : {}
    ),
  } as Parameters<typeof createVersionFromBuilderOutput>[0] & { voiceAgentSessionId?: string })
}

describe("Coreview artifact version store", () => {
  beforeEach(() => {
    window.localStorage.clear()
    clearCoreviewArtifactVersionStoreForTests()
  })

  it("creating a new version preserves the original", () => {
    const state = createHtmlVersion()

    expect(state).not.toBeNull()
    if (!state) throw new Error("expected version state")
    expect(state.versions).toHaveLength(2)
    expect(state.originalVersionId).not.toBe(state.currentVersionId)
    expect(state.versions.find((version) => version.versionId === state.originalVersionId)).toMatchObject({
      artifactPath: "mnt/user-data/outputs/site.html",
      source: "manual_select",
    })
    expect(getCurrentVersion(state)).toMatchObject({
      artifactPath: "mnt/user-data/outputs/site-v2.html",
      source: "builder_update",
    })
  })

  it("selecting a new version changes currentVersionId", () => {
    const state = createHtmlVersion()
    const originalVersionId = state?.originalVersionId
    if (!state || !originalVersionId) throw new Error("expected version state")

    const selected = selectArtifactVersion({
      workspaceKey: WORKSPACE_KEY,
      logicalArtifactId: LOGICAL_ID,
      versionId: originalVersionId,
    })

    expect(selected?.currentVersionId).toBe(originalVersionId)
    expect(getCurrentVersion(selected)).toMatchObject({
      artifactPath: "mnt/user-data/outputs/site.html",
    })
  })

  it("restoring original returns to the original version", () => {
    const state = createHtmlVersion()
    expect(getCurrentVersion(state)?.artifactPath).toBe("mnt/user-data/outputs/site-v2.html")

    const restored = restoreOriginalVersion({
      workspaceKey: WORKSPACE_KEY,
      logicalArtifactId: LOGICAL_ID,
    })

    expect(restored?.currentVersionId).toBe(restored?.originalVersionId)
    expect(getCurrentVersion(restored)).toMatchObject({
      artifactPath: "mnt/user-data/outputs/site.html",
    })
    expect(getVersionTelemetry(restored)).toMatchObject({
      coreviewArtifactVersioningEnabled: true,
      coreviewArtifactLogicalId: LOGICAL_ID,
      coreviewArtifactOriginalVersionIdPresent: true,
      coreviewArtifactCurrentVersionIdPresent: true,
      coreviewArtifactVersionCount: 2,
      coreviewHtmlUpdateRestoreAvailable: false,
    })
  })

  it("different artifacts do not share versions", () => {
    const first = createHtmlVersion()
    const secondLogicalId = "user:unknown|thread:thread-1|path:mnt/user-data/outputs/other.html|renderer:html"
    const second = createHtmlVersion({
      logicalArtifactId: secondLogicalId,
      outputPath: "mnt/user-data/outputs/other-v2.html",
    })

    expect(first?.logicalArtifactId).toBe(LOGICAL_ID)
    expect(second?.logicalArtifactId).toBe(secondLogicalId)
    expect(getCurrentVersion(first)?.artifactPath).toBe("mnt/user-data/outputs/site-v2.html")
    expect(getCurrentVersion(second)?.artifactPath).toBe("mnt/user-data/outputs/other-v2.html")
  })

  it("voice session id does not affect the version key", () => {
    const first = createHtmlVersion({ voiceAgentSessionId: "voice-session-1" })
    const second = createHtmlVersion({ voiceAgentSessionId: "voice-session-2" })

    expect(first?.logicalArtifactId).toBe(LOGICAL_ID)
    expect(second?.logicalArtifactId).toBe(LOGICAL_ID)
    expect(second?.versions).toHaveLength(2)
    expect(getCurrentVersion(second)?.artifactPath).toBe("mnt/user-data/outputs/site-v2.html")
  })
})
