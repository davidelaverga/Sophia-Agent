import { describe, expect, it } from "vitest"

import {
  buildCoreviewWorkspaceKey,
  normalizeCoreviewArtifactKey,
  buildCoreviewArtifactStableIdentity,
  normalizeCoreviewArtifactPath,
} from "../../app/lib/coreview-artifact-identity"

describe("Coreview artifact identity", () => {
  it("builds a stable workspace key from the same user and thread", () => {
    const first = buildCoreviewWorkspaceKey({
      userId: "user-1",
      threadId: "thread-1",
      voiceAgentSessionId: "voice-session-a",
    })
    const second = buildCoreviewWorkspaceKey({
      userId: "user-1",
      threadId: "thread-1",
      voiceAgentSessionId: "voice-session-b",
    })

    expect(first.key).toBe("user:user-1|thread:thread-1")
    expect(second.key).toBe(first.key)
    expect(first.key).not.toContain("voice")
  })

  it("uses unknown workspace key parts when user or thread are unavailable", () => {
    expect(buildCoreviewWorkspaceKey({}).key).toBe("user:unknown|thread:unknown")
  })

  it("normalizes artifact path variants to the same path", () => {
    const variants = [
      "/mnt/user-data/outputs/report.pdf",
      "mnt/user-data/outputs/report.pdf",
      "/user-data/outputs/report.pdf",
      "user-data/outputs/report.pdf",
      "/outputs/report.pdf",
      "outputs/report.pdf",
    ]

    expect(variants.map(normalizeCoreviewArtifactPath)).toEqual(
      variants.map(() => "mnt/user-data/outputs/report.pdf"),
    )
  })

  it("normalizes same artifact path variants to the same artifact key", () => {
    const first = normalizeCoreviewArtifactKey("user:user-1|thread:thread-1|path:/outputs/report.pdf|renderer:pdf")
    const second = normalizeCoreviewArtifactKey("user:user-1|thread:thread-1|path:file:///mnt/user-data/outputs/report.pdf|renderer:pdf")
    const third = normalizeCoreviewArtifactKey("outputs/report.pdf")

    expect(first).toBe("user:user-1|thread:thread-1|path:mnt/user-data/outputs/report.pdf|renderer:pdf")
    expect(second).toBe(first)
    expect(third).toBe("path:mnt/user-data/outputs/report.pdf")
  })

  it("keeps different artifact paths isolated by artifact key", () => {
    expect(normalizeCoreviewArtifactKey("outputs/report.pdf")).not.toBe(
      normalizeCoreviewArtifactKey("outputs/other-report.pdf"),
    )
  })

  it("keeps the same stable identity across voice session changes", () => {
    const first = buildCoreviewArtifactStableIdentity({
      threadId: "thread-1",
      artifactPath: "/mnt/user-data/outputs/report.pdf",
      rendererKind: "pdf",
    })
    const second = buildCoreviewArtifactStableIdentity({
      threadId: "thread-1",
      artifactPath: "outputs/report.pdf",
      rendererKind: "pdf",
    })

    expect(first.key).toBe(second.key)
    expect(first.key).not.toContain("voice")
  })

  it("includes builder task thread association when available", () => {
    const identity = buildCoreviewArtifactStableIdentity({
      userId: "user-1",
      threadId: "thread-1",
      parentThreadId: "parent-thread",
      builderTaskThreadId: "builder-thread",
      artifactPath: "outputs/report.pdf",
      rendererKind: "pdf",
    })

    expect(identity.key).toBe(
      "user:user-1|thread:parent-thread|builder:builder-thread|path:mnt/user-data/outputs/report.pdf|renderer:pdf",
    )
  })

  it("rejects path traversal segments", () => {
    expect(normalizeCoreviewArtifactPath("outputs/../secret.pdf")).toBeNull()
    expect(buildCoreviewArtifactStableIdentity({
      threadId: "thread-1",
      artifactPath: "outputs/../secret.pdf",
      rendererKind: "pdf",
    }).key).toBe("user:unknown|thread:thread-1|path:unknown|renderer:pdf")
  })
})
