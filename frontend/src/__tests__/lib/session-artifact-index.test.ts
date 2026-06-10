import { beforeEach, describe, expect, it } from "vitest"

import {
  clearArtifactSessionIndexForTests,
  getArtifactSessionIndexStorageKeyForTests,
  listSessionArtifacts,
  loadArtifactSessionIndex,
  openArtifactInSessionIndex,
  registerArtifactInSessionIndex,
} from "../../app/lib/session-artifact-index"

const CONTEXT = {
  userId: "user-1",
  threadId: "thread-1",
  sessionId: "session-1",
}

describe("session artifact index", () => {
  beforeEach(() => {
    window.localStorage.clear()
    clearArtifactSessionIndexForTests()
  })

  it("registers the first artifact", () => {
    const result = registerArtifactInSessionIndex({
      context: CONTEXT,
      localPath: "/mnt/user-data/outputs/report.pdf",
      title: "Quarterly report",
      artifactType: "pdf",
      rendererKind: "pdf",
      mimeType: "application/pdf",
      source: "builder_completion",
      createdAt: "2026-06-07T12:00:00.000Z",
    })

    expect(result.result).toBe("registered")
    expect(result.record).toMatchObject({
      title: "Quarterly report",
      localPath: "mnt/user-data/outputs/report.pdf",
      rendererKind: "pdf",
      storageProvider: "local",
      rawContentExcluded: true,
    })
    expect(result.index.artifacts).toHaveLength(1)
  })

  it("registers multiple artifacts in one session", () => {
    registerArtifactInSessionIndex({
      context: CONTEXT,
      localPath: "mnt/user-data/outputs/report.pdf",
      title: "Report",
      artifactType: "pdf",
      rendererKind: "pdf",
    })
    registerArtifactInSessionIndex({
      context: CONTEXT,
      localPath: "outputs/site.html",
      title: "Site",
      artifactType: "webpage",
      rendererKind: "html",
    })

    const restored = loadArtifactSessionIndex(CONTEXT)
    expect(restored.artifacts.map((artifact) => artifact.rendererKind).sort()).toEqual(["html", "pdf"])
  })

  it("dedupes the same normalized path, renderer, and thread", () => {
    const first = registerArtifactInSessionIndex({
      context: CONTEXT,
      localPath: "/mnt/user-data/outputs/report.pdf",
      title: "report.pdf",
      artifactType: "document",
      rendererKind: "pdf",
    })
    const second = registerArtifactInSessionIndex({
      context: CONTEXT,
      localPath: "outputs/report.pdf",
      title: "Quarterly report",
      artifactType: "pdf",
      rendererKind: "pdf",
      source: "builder_completion",
    })

    expect(first.record?.artifactId).toBe(second.record?.artifactId)
    expect(second.result).toBe("updated")
    expect(second.deduped).toBe(true)
    expect(second.index.artifacts).toHaveLength(1)
    expect(second.record?.title).toBe("Quarterly report")
  })

  it("preserves renderer kind, title, and path", () => {
    const result = registerArtifactInSessionIndex({
      context: CONTEXT,
      localPath: "mnt/user-data/outputs/site.html",
      title: "Launch page",
      artifactType: "webpage",
      rendererKind: "html",
      mimeType: "text/html",
    })

    expect(result.record).toMatchObject({
      title: "Launch page",
      rendererKind: "html",
      localPath: "mnt/user-data/outputs/site.html",
      mimeType: "text/html",
    })
  })

  it("stores source and revision relationship under the same logical artifact", () => {
    const original = registerArtifactInSessionIndex({
      context: CONTEXT,
      localPath: "mnt/user-data/outputs/site.html",
      title: "Site",
      artifactType: "webpage",
      rendererKind: "html",
      stableArtifactIdentity: "logical-site",
    })
    const revision = registerArtifactInSessionIndex({
      context: CONTEXT,
      localPath: "mnt/user-data/outputs/site-revision-a.html",
      title: "Site revision",
      artifactType: "webpage",
      rendererKind: "html",
      sourceArtifactPath: "mnt/user-data/outputs/site.html",
      revisionOfArtifactPath: "/mnt/user-data/outputs/site.html",
      source: "quick_patch",
    })

    expect(revision.record?.logicalArtifactId).toBe(original.record?.logicalArtifactId)
    expect(revision.record?.parentVersionId).toBe(original.record?.versionId)
    expect(revision.record).toMatchObject({
      sourceArtifactPath: "mnt/user-data/outputs/site.html",
      revisionOfArtifactPath: "mnt/user-data/outputs/site.html",
    })
  })

  it("persists and restores from localStorage", () => {
    const registered = registerArtifactInSessionIndex({
      context: CONTEXT,
      localPath: "mnt/user-data/outputs/report.pdf",
      title: "Report",
      artifactType: "pdf",
      rendererKind: "pdf",
    })
    const opened = openArtifactInSessionIndex(CONTEXT, registered.record?.artifactId)

    const restored = loadArtifactSessionIndex(CONTEXT)
    expect(restored.activeArtifactId).toBe(opened.record?.artifactId)
    expect(restored.recentlyOpenedArtifactIds).toEqual([opened.record?.artifactId])
    expect(listSessionArtifacts(restored)[0]?.artifactId).toBe(opened.record?.artifactId)
  })

  it("lists deliverables before newer source and preview siblings", () => {
    registerArtifactInSessionIndex({
      context: CONTEXT,
      localPath: "mnt/user-data/outputs/sophia-roadmap.pdf",
      title: "sophia-roadmap.pdf",
      artifactType: "pdf",
      rendererKind: "pdf",
      updatedAt: "2026-06-10T12:00:00.000Z",
    })
    registerArtifactInSessionIndex({
      context: CONTEXT,
      localPath: "mnt/user-data/outputs/sophia-roadmap.pdf.md",
      title: "sophia-roadmap.pdf.md",
      artifactType: "document",
      rendererKind: "markdown",
      updatedAt: "2026-06-10T12:05:00.000Z",
    })
    registerArtifactInSessionIndex({
      context: CONTEXT,
      localPath: "mnt/user-data/outputs/deck.preview.pdf",
      title: "deck.preview.pdf",
      artifactType: "pdf",
      rendererKind: "pdf",
      updatedAt: "2026-06-10T12:06:00.000Z",
    })

    const listed = listSessionArtifacts(loadArtifactSessionIndex(CONTEXT))
    // The deliverable leads even though both siblings are newer; the
    // non-deliverables keep recency order among themselves.
    expect(listed.map((artifact) => artifact.title)).toEqual([
      "sophia-roadmap.pdf",
      "deck.preview.pdf",
      "sophia-roadmap.pdf.md",
    ])
  })

  it("still lets an explicitly opened source sibling lead the recents list", () => {
    registerArtifactInSessionIndex({
      context: CONTEXT,
      localPath: "mnt/user-data/outputs/sophia-roadmap.pdf",
      title: "sophia-roadmap.pdf",
      artifactType: "pdf",
      rendererKind: "pdf",
    })
    const source = registerArtifactInSessionIndex({
      context: CONTEXT,
      localPath: "mnt/user-data/outputs/sophia-roadmap.pdf.md",
      title: "sophia-roadmap.pdf.md",
      artifactType: "document",
      rendererKind: "markdown",
    })
    openArtifactInSessionIndex(CONTEXT, source.record?.artifactId)

    const listed = listSessionArtifacts(loadArtifactSessionIndex(CONTEXT))
    expect(listed[0]?.title).toBe("sophia-roadmap.pdf.md")
  })

  it("does not use voiceAgentSessionId in the storage key", () => {
    const firstKey = getArtifactSessionIndexStorageKeyForTests({
      ...CONTEXT,
      voiceAgentSessionId: "voice-session-1",
    })
    const secondKey = getArtifactSessionIndexStorageKeyForTests({
      ...CONTEXT,
      voiceAgentSessionId: "voice-session-2",
    })

    expect(firstKey).toBe(secondKey)
  })

  it("does not store raw content fields", () => {
    registerArtifactInSessionIndex({
      context: CONTEXT,
      localPath: "mnt/user-data/outputs/site.html",
      title: "Site",
      artifactType: "webpage",
      rendererKind: "html",
      safeSummary: "A safe summary.",
      rawHtml: "<main>private</main>",
      rawContent: "private artifact body",
    } as Parameters<typeof registerArtifactInSessionIndex>[0] & {
      rawHtml: string
      rawContent: string
    })

    const raw = window.localStorage.getItem(getArtifactSessionIndexStorageKeyForTests(CONTEXT))
    expect(raw).toContain("rawContentExcluded")
    expect(raw).not.toContain("private")
    expect(raw).not.toContain("<main>")
  })
})
