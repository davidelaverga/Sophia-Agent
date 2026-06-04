import { describe, expect, it } from "vitest"

import {
  buildCoreviewArtifactStableIdentity,
  normalizeCoreviewArtifactPath,
} from "../../app/lib/coreview-artifact-identity"

describe("Coreview artifact identity", () => {
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
