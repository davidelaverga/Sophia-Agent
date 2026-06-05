import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  ARTIFACT_ANNOTATION_STORAGE_VERSION,
  buildArtifactAnnotationWorkspaceIdentity,
  persistArtifactAnnotations,
  restoreArtifactAnnotations,
} from "../../app/lib/artifact-annotation-persistence"
import type { ArtifactAnnotation } from "../../app/types/artifact-annotations"

function identityFor(stableArtifactIdentity: string) {
  return buildArtifactAnnotationWorkspaceIdentity({
    artifactStableIdentity: stableArtifactIdentity,
    threadId: "thread-1",
    artifactId: "artifact-1",
    artifactPath: "mnt/user-data/outputs/launch-brief.pdf",
    rendererKind: "pdf",
  })
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe("artifact annotation persistence", () => {
  it("persists and restores highlights, comments, Sophia source, and workspace-ready metadata", () => {
    const stableIdentity = "user:u1|thread:thread-1|path:launch-brief.pdf|renderer:pdf"
    const identity = identityFor(stableIdentity)
    const annotations: ArtifactAnnotation[] = [
      {
        id: "highlight-1",
        kind: "highlight",
        artifactStableIdentity: stableIdentity,
        actorId: "user-1",
        pageIndex: 0,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.08 },
        color: "yellow",
        source: "user",
        createdAt: 100,
        updatedAt: 101,
        version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
      },
      {
        id: "comment-1",
        kind: "comment",
        artifactStableIdentity: stableIdentity,
        pageIndex: 0,
        point: { x: 0.62, y: 0.24 },
        text: "Persist this note",
        color: "purple",
        source: "sophia",
        createdAt: 110,
        updatedAt: 111,
        version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
      },
    ]

    const persistResult = persistArtifactAnnotations(identity.storageKey, annotations, {
      stableArtifactIdentity: identity.stableArtifactIdentity,
    })
    expect(persistResult).toMatchObject({
      status: "saved",
      persistedCount: 2,
      version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
    })

    const rawPayload = JSON.parse(window.localStorage.getItem(identity.storageKey ?? "") ?? "{}") as {
      version?: number
      stableArtifactIdentity?: string
      annotations?: ArtifactAnnotation[]
    }
    expect(rawPayload.version).toBe(ARTIFACT_ANNOTATION_STORAGE_VERSION)
    expect(rawPayload.stableArtifactIdentity).toBe(stableIdentity)
    expect(rawPayload.annotations?.[0]).toMatchObject({
      version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
      artifactStableIdentity: stableIdentity,
      actorId: "user-1",
      pageIndex: 0,
      source: "user",
      createdAt: 100,
      updatedAt: 101,
    })

    const restored = restoreArtifactAnnotations(identity.storageKey, identity.stableArtifactIdentity)
    expect(restored).toMatchObject({
      status: "restored",
      restoreCount: 2,
      version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
    })
    expect(restored.annotations).toHaveLength(2)
    expect(restored.annotations[1]).toMatchObject({
      kind: "comment",
      text: "Persist this note",
      source: "sophia",
    })
  })

  it("keeps annotation storage isolated by stable artifact identity", () => {
    const firstIdentity = identityFor("user:u1|thread:thread-1|path:first.pdf|renderer:pdf")
    const secondIdentity = identityFor("user:u1|thread:thread-1|path:second.pdf|renderer:pdf")

    persistArtifactAnnotations(firstIdentity.storageKey, [
      {
        id: "highlight-1",
        kind: "highlight",
        artifactStableIdentity: firstIdentity.stableArtifactIdentity,
        pageIndex: 0,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.08 },
        createdAt: 100,
        updatedAt: 100,
        version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
      },
    ], { stableArtifactIdentity: firstIdentity.stableArtifactIdentity })

    expect(firstIdentity.storageKey).not.toBe(secondIdentity.storageKey)
    expect(restoreArtifactAnnotations(secondIdentity.storageKey, secondIdentity.stableArtifactIdentity)).toMatchObject({
      annotations: [],
      status: "empty",
      restoreCount: 0,
    })
  })

  it("maps artifact path variants to the same annotation storage key", () => {
    const absoluteIdentity = buildArtifactAnnotationWorkspaceIdentity({
      artifactStableIdentity: "user:u1|thread:thread-1|path:/mnt/user-data/outputs/launch-brief.pdf|renderer:pdf",
      threadId: "thread-1",
      artifactId: "artifact-1",
      artifactPath: "/mnt/user-data/outputs/launch-brief.pdf",
      rendererKind: "pdf",
    })
    const outputsIdentity = buildArtifactAnnotationWorkspaceIdentity({
      artifactStableIdentity: "user:u1|thread:thread-1|path:outputs/launch-brief.pdf|renderer:pdf",
      threadId: "thread-1",
      artifactId: "artifact-1",
      artifactPath: "outputs/launch-brief.pdf",
      rendererKind: "pdf",
    })

    expect(absoluteIdentity.stableArtifactIdentity).toBe(outputsIdentity.stableArtifactIdentity)
    expect(absoluteIdentity.storageKey).toBe(outputsIdentity.storageKey)

    persistArtifactAnnotations(absoluteIdentity.storageKey, [
      {
        id: "underline-1",
        kind: "underline",
        artifactStableIdentity: absoluteIdentity.stableArtifactIdentity,
        pageIndex: 0,
        rect: { x: 0.1, y: 0.7, width: 0.4, height: 0.03 },
        createdAt: 100,
        updatedAt: 100,
        version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
      },
    ], { stableArtifactIdentity: absoluteIdentity.stableArtifactIdentity })

    const restored = restoreArtifactAnnotations(outputsIdentity.storageKey, outputsIdentity.stableArtifactIdentity)
    expect(restored).toMatchObject({
      status: "restored",
      restoreCount: 1,
    })
    expect(restored.annotations[0]).toMatchObject({
      kind: "underline",
      artifactStableIdentity: outputsIdentity.stableArtifactIdentity,
    })
  })

  it("preserves page indexes so callers can render only page-specific annotations", () => {
    const identity = identityFor("user:u1|thread:thread-1|path:paged.pdf|renderer:pdf")
    persistArtifactAnnotations(identity.storageKey, [
      {
        id: "page-1-highlight",
        kind: "highlight",
        artifactStableIdentity: identity.stableArtifactIdentity,
        pageIndex: 0,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.08 },
        createdAt: 100,
        updatedAt: 100,
        version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
      },
      {
        id: "page-2-arrow",
        kind: "arrow",
        artifactStableIdentity: identity.stableArtifactIdentity,
        pageIndex: 1,
        line: { start: { x: 0.2, y: 0.4 }, end: { x: 0.5, y: 0.6 } },
        source: "sophia",
        createdAt: 110,
        updatedAt: 110,
        version: ARTIFACT_ANNOTATION_STORAGE_VERSION,
      },
    ], { stableArtifactIdentity: identity.stableArtifactIdentity })

    const restored = restoreArtifactAnnotations(identity.storageKey, identity.stableArtifactIdentity)
    expect(restored.annotations.filter((annotation) => annotation.pageIndex === 0)).toHaveLength(1)
    expect(restored.annotations.filter((annotation) => annotation.pageIndex === 1)).toHaveLength(1)
    expect(restored.annotations[1]).toMatchObject({ kind: "arrow", source: "sophia" })
  })

  it("fails safely and starts empty when stored data is corrupt", () => {
    const identity = identityFor("user:u1|thread:thread-1|path:corrupt.pdf|renderer:pdf")
    window.localStorage.setItem(identity.storageKey ?? "", "{not-json")

    const restored = restoreArtifactAnnotations(identity.storageKey, identity.stableArtifactIdentity)

    expect(restored).toMatchObject({
      annotations: [],
      status: "corrupt",
      restoreCount: 0,
    })
    expect(window.localStorage.getItem(identity.storageKey ?? "")).toBeNull()
  })
})
