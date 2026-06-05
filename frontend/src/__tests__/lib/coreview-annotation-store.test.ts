import { beforeEach, describe, expect, it } from "vitest"

import {
  addAnnotation,
  buildCoreviewAnnotationStorageIdentity,
  clearCoreviewAnnotationStoreForTests,
  deleteAnnotation,
  getAnnotationCountsByPage,
  getAnnotations,
  normalizeCoreviewAnnotationStableIdentity,
  restoreAnnotations,
  updateAnnotation,
} from "../../app/lib/coreview-annotation-store"

const identity = "user:test-user|thread:thread-1|path:mnt/user-data/outputs/report.pdf|renderer:pdf"

beforeEach(() => {
  clearCoreviewAnnotationStoreForTests()
  window.localStorage.clear()
})

describe("Coreview annotation store", () => {
  it("adds, updates, deletes, and persists annotations under the Coreview identity", () => {
    const storageIdentity = buildCoreviewAnnotationStorageIdentity(identity)

    const added = addAnnotation(identity, {
      kind: "comment",
      pageIndex: 0,
      point: { x: 0.4, y: 0.2 },
      text: "Original note",
      source: "user",
    })

    expect(added.ok).toBe(true)
    expect(added.counts).toMatchObject({ annotationCount: 1, commentCount: 1 })
    expect(window.localStorage.getItem(storageIdentity.storageKey ?? "")).toContain("Original note")

    const updated = updateAnnotation(identity, added.annotation?.id ?? "", { text: "Edited note" })
    expect(updated.ok).toBe(true)
    expect(window.localStorage.getItem(storageIdentity.storageKey ?? "")).toContain("Edited note")

    const deleted = deleteAnnotation(identity, added.annotation?.id ?? "")
    expect(deleted.ok).toBe(true)
    expect(deleted.counts.annotationCount).toBe(0)
    expect(window.localStorage.getItem(storageIdentity.storageKey ?? "")).toBeNull()
  })

  it("restores annotations after a browser refresh and keeps different artifacts isolated", () => {
    addAnnotation(identity, {
      kind: "highlight",
      pageIndex: 0,
      rect: { x: 0.1, y: 0.12, width: 0.3, height: 0.08 },
      color: "yellow",
      source: "user",
    })

    clearCoreviewAnnotationStoreForTests()
    const restored = restoreAnnotations(identity, "browser_refresh")
    expect(restored.annotations).toHaveLength(1)
    expect(restored.telemetry.annotationRestoreResult).toBe("restored")

    const other = restoreAnnotations("user:test-user|thread:thread-1|path:mnt/user-data/outputs/other.pdf|renderer:pdf")
    expect(other.annotations).toHaveLength(0)
  })

  it("normalizes path variants to the same annotation bucket and page counts", () => {
    const variants = [
      "/mnt/user-data/outputs/foo.pdf",
      "mnt/user-data/outputs/foo.pdf",
      "user-data/outputs/foo.pdf",
      "outputs/foo.pdf",
      "file:///mnt/user-data/outputs/foo.pdf",
    ]

    expect(variants.map(normalizeCoreviewAnnotationStableIdentity)).toEqual(
      variants.map(() => "path:mnt/user-data/outputs/foo.pdf"),
    )

    addAnnotation(variants[0], {
      kind: "underline",
      pageIndex: 2,
      rect: { x: 0.2, y: 0.5, width: 0.4, height: 0.03 },
      source: "sophia",
    })

    expect(getAnnotations(variants[3])).toHaveLength(1)
    expect(getAnnotationCountsByPage(variants[4]).get(2)).toBe(1)
  })

  it("does not let an empty restore overwrite a live Coreview bucket", () => {
    addAnnotation(identity, {
      kind: "arrow",
      pageIndex: 0,
      line: { start: { x: 0.2, y: 0.2 }, end: { x: 0.6, y: 0.6 } },
      source: "user",
    })
    const storageIdentity = buildCoreviewAnnotationStorageIdentity(identity)
    window.localStorage.removeItem(storageIdentity.storageKey ?? "")

    const restored = restoreAnnotations(identity, "canvas_reopen")
    expect(restored.annotations).toHaveLength(1)
    expect(restored.telemetry.annotationRestoreResult).toBe("empty_preserved")
    expect(restored.telemetry.annotationPreventedEmptyOverwriteCount).toBe(1)
  })

  it("migrates old user:unknown annotation storage into a user-scoped identity", () => {
    const oldIdentity = "user:unknown|thread:thread-1|path:mnt/user-data/outputs/migrated.pdf|renderer:pdf"
    const newIdentity = "user:test-user|thread:thread-1|path:mnt/user-data/outputs/migrated.pdf|renderer:pdf"
    addAnnotation(oldIdentity, {
      kind: "highlight",
      pageIndex: 0,
      rect: { x: 0.12, y: 0.2, width: 0.32, height: 0.06 },
      source: "user",
    })

    clearCoreviewAnnotationStoreForTests()
    const restored = restoreAnnotations(newIdentity)
    expect(restored.annotations).toHaveLength(1)
    expect(restored.annotations[0]?.artifactStableIdentity).toBe(newIdentity)
    expect(restored.telemetry.annotationRestoreResult).toBe("migrated_user_unknown")
    expect(restored.telemetry.annotationMigratedIdentityCount).toBe(1)
    expect(window.localStorage.getItem(buildCoreviewAnnotationStorageIdentity(newIdentity).storageKey ?? "")).toBeTruthy()
  })
})
