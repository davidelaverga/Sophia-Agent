"use client"

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"

import type {
  ArtifactAnnotation,
  ArtifactAnnotationColor,
  ArtifactAnnotationKind,
  ArtifactAnnotationSource,
  NormalizedArtifactLine,
  NormalizedArtifactPoint,
  NormalizedArtifactRect,
} from "../types/artifact-annotations"

import {
  ARTIFACT_ANNOTATION_STORAGE_VERSION,
  buildArtifactAnnotationWorkspaceIdentity,
  persistArtifactAnnotations,
  restoreArtifactAnnotations,
  type ArtifactAnnotationPersistenceStatus,
} from "./artifact-annotation-persistence"
import { normalizeCoreviewArtifactPath } from "./coreview-artifact-identity"

export const COREVIEW_ANNOTATION_STORAGE_VERSION = ARTIFACT_ANNOTATION_STORAGE_VERSION

export type CoreviewAnnotation = ArtifactAnnotation & {
  source: ArtifactAnnotationSource
  updatedAt: number
  version: 1
}

export type CoreviewAnnotationStateEnvelope = {
  version: 1
  stableArtifactIdentity: string
  annotations: CoreviewAnnotation[]
  updatedAt: number
}

export type CoreviewAnnotationStateSource = "coreview"
export type CoreviewAnnotationRestoreSource = "identity_ready" | "canvas_reopen" | "browser_refresh" | "stage_mount"
export type CoreviewAnnotationStateClearedReason = "explicit_delete_all" | "unsupported_renderer" | "identity_unavailable" | null

export type CoreviewAnnotationCounts = {
  annotationCount: number
  highlightCount: number
  commentCount: number
  underlineCount: number
  arrowCount: number
  drawPathCount: number
}

export type CoreviewAnnotationStoreTelemetry = {
  coreviewAnnotationStoreActive: boolean
  coreviewAnnotationStateSource: CoreviewAnnotationStateSource
  annotationPersistenceStatus: ArtifactAnnotationPersistenceStatus | null
  annotationRestoreAttempted: boolean
  annotationRestoreResult: string | null
  annotationRestoreCount: number
  annotationRestoreSource: CoreviewAnnotationRestoreSource | null
  annotationPersistAttempted: boolean
  annotationPersistResult: string | null
  annotationPersistCount: number
  annotationPersistedCount: number
  annotationStorageVersion: number
  annotationStorageKeyHash: string | null
  annotationIdentityWriteHash: string | null
  annotationIdentityReadHash: string | null
  annotationPreventedEmptyOverwriteCount: number
  annotationMigratedIdentityCount: number
  annotationStoreSurvivedCanvasClose: boolean
  annotationStoreHydratedArtifactStage: boolean
  annotationStateClearedReason: CoreviewAnnotationStateClearedReason
  annotationDeleteCount: number
  annotationEditCount: number
}

export type CoreviewAnnotationStoreSnapshot = {
  stableArtifactIdentity: string | null
  annotations: CoreviewAnnotation[]
  counts: CoreviewAnnotationCounts
  pageCounts: ReadonlyMap<number, number>
  annotationVersion: string
  telemetry: CoreviewAnnotationStoreTelemetry
}

export type CoreviewAnnotationLineCoordinates = {
  x1: number
  y1: number
  x2: number
  y2: number
}

export type CoreviewAnnotationInput = {
  id?: string | null
  kind: ArtifactAnnotationKind
  pageIndex: number
  rect?: NormalizedArtifactRect | null
  point?: NormalizedArtifactPoint | null
  line?: NormalizedArtifactLine | CoreviewAnnotationLineCoordinates | null
  color?: ArtifactAnnotationColor | null
  text?: string | null
  source?: ArtifactAnnotationSource | null
  actorId?: string | null
  createdAt?: number | null
  updatedAt?: number | null
}

export type CoreviewAnnotationPatch = Partial<Pick<CoreviewAnnotationInput, "rect" | "point" | "line" | "color" | "text" | "actorId">>

export type CoreviewAnnotationMutationResult = {
  ok: boolean
  annotation: CoreviewAnnotation | null
  annotations: CoreviewAnnotation[]
  counts: CoreviewAnnotationCounts
  blockedReason: "identity_unavailable" | "invalid_annotation" | "annotation_not_found" | null
}

type InternalState = {
  snapshot: CoreviewAnnotationStoreSnapshot
  restored: boolean
}

const EMPTY_COUNTS: CoreviewAnnotationCounts = {
  annotationCount: 0,
  highlightCount: 0,
  commentCount: 0,
  underlineCount: 0,
  arrowCount: 0,
  drawPathCount: 0,
}

const EMPTY_TELEMETRY: CoreviewAnnotationStoreTelemetry = {
  coreviewAnnotationStoreActive: false,
  coreviewAnnotationStateSource: "coreview",
  annotationPersistenceStatus: null,
  annotationRestoreAttempted: false,
  annotationRestoreResult: null,
  annotationRestoreCount: 0,
  annotationRestoreSource: null,
  annotationPersistAttempted: false,
  annotationPersistResult: null,
  annotationPersistCount: 0,
  annotationPersistedCount: 0,
  annotationStorageVersion: COREVIEW_ANNOTATION_STORAGE_VERSION,
  annotationStorageKeyHash: null,
  annotationIdentityWriteHash: null,
  annotationIdentityReadHash: null,
  annotationPreventedEmptyOverwriteCount: 0,
  annotationMigratedIdentityCount: 0,
  annotationStoreSurvivedCanvasClose: false,
  annotationStoreHydratedArtifactStage: false,
  annotationStateClearedReason: "identity_unavailable",
  annotationDeleteCount: 0,
  annotationEditCount: 0,
}

const EMPTY_SNAPSHOT: CoreviewAnnotationStoreSnapshot = {
  stableArtifactIdentity: null,
  annotations: [],
  counts: EMPTY_COUNTS,
  pageCounts: new Map(),
  annotationVersion: "",
  telemetry: EMPTY_TELEMETRY,
}

const states = new Map<string, InternalState>()
const subscribers = new Set<() => void>()
const migrationReadAttempts = new Set<string>()

export function useCoreviewAnnotationStore(stableArtifactIdentity: string | null | undefined) {
  const normalizedIdentity = useMemo(
    () => normalizeCoreviewAnnotationStableIdentity(stableArtifactIdentity),
    [stableArtifactIdentity],
  )
  const previousIdentityRef = useRef<string | null>(null)
  const snapshot = useSyncExternalStore(
    subscribeCoreviewAnnotationStore,
    () => getCoreviewAnnotationSnapshot(normalizedIdentity),
    () => EMPTY_SNAPSHOT,
  )

  useEffect(() => {
    if (!normalizedIdentity) {
      previousIdentityRef.current = null
      return
    }

    const previousIdentity = previousIdentityRef.current
    restoreAnnotations(normalizedIdentity)
    if (previousIdentity && previousIdentity !== normalizedIdentity) {
      migrateAnnotations(previousIdentity, normalizedIdentity)
    }
    previousIdentityRef.current = normalizedIdentity
  }, [normalizedIdentity])

  const add = useCallback((input: CoreviewAnnotationInput) => (
    addAnnotation(normalizedIdentity, input)
  ), [normalizedIdentity])
  const update = useCallback((annotationId: string, patch: CoreviewAnnotationPatch) => (
    updateAnnotation(normalizedIdentity, annotationId, patch)
  ), [normalizedIdentity])
  const remove = useCallback((annotationId: string) => (
    deleteAnnotation(normalizedIdentity, annotationId)
  ), [normalizedIdentity])

  return {
    ...snapshot,
    stableArtifactIdentity: normalizedIdentity,
    addAnnotation: add,
    updateAnnotation: update,
    deleteAnnotation: remove,
  }
}

export function subscribeCoreviewAnnotationStore(listener: () => void): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

export function getAnnotations(stableArtifactIdentity: string | null | undefined): CoreviewAnnotation[] {
  return getCoreviewAnnotationSnapshot(stableArtifactIdentity).annotations
}

export function restoreAnnotations(
  stableArtifactIdentity: string | null | undefined,
  source: CoreviewAnnotationRestoreSource = "identity_ready",
): CoreviewAnnotationStoreSnapshot {
  const identity = normalizeCoreviewAnnotationStableIdentity(stableArtifactIdentity)
  if (!identity) {
    return EMPTY_SNAPSHOT
  }

  const current = ensureState(identity)
  const storageIdentity = buildCoreviewAnnotationStorageIdentity(identity)
  const restored = restoreArtifactAnnotations(storageIdentity.storageKey, identity)
  if (restored.restoreCount > 0) {
    return replaceAnnotations(identity, restored.annotations, {
      restored: true,
      persistenceStatus: restored.status,
      restoreAttempted: true,
      restoreResult: restored.status,
      restoreCount: restored.restoreCount,
      restoreSource: source,
      identityReadHash: storageIdentity.storageKeyHash,
      stateClearedReason: null,
    })
  }

  const migrated = restoreMigratedUserUnknownIdentity(identity, storageIdentity, source)
  if (migrated) {
    return migrated
  }

  if (current.snapshot.annotations.length > 0 && restored.status !== "corrupt") {
    const telemetry = current.snapshot.telemetry
    return updateSnapshot(identity, current.snapshot.annotations, {
      telemetry: {
        ...telemetry,
        coreviewAnnotationStoreActive: true,
        annotationRestoreAttempted: true,
        annotationRestoreResult: "empty_preserved",
        annotationRestoreCount: 0,
        annotationRestoreSource: source,
        annotationIdentityReadHash: storageIdentity.storageKeyHash,
        annotationPreventedEmptyOverwriteCount: telemetry.annotationPreventedEmptyOverwriteCount + 1,
        annotationStoreSurvivedCanvasClose: true,
        annotationStateClearedReason: null,
      },
      restored: current.restored,
    })
  }

  return updateSnapshot(identity, [], {
    telemetry: {
      ...current.snapshot.telemetry,
      coreviewAnnotationStoreActive: true,
      annotationPersistenceStatus: restored.status,
      annotationRestoreAttempted: true,
      annotationRestoreResult: restored.status,
      annotationRestoreCount: 0,
      annotationRestoreSource: source,
      annotationStorageKeyHash: storageIdentity.storageKeyHash,
      annotationIdentityReadHash: storageIdentity.storageKeyHash,
      annotationStateClearedReason: null,
    },
    restored: true,
  })
}

export function addAnnotation(
  stableArtifactIdentity: string | null | undefined,
  input: CoreviewAnnotationInput,
): CoreviewAnnotationMutationResult {
  const identity = normalizeCoreviewAnnotationStableIdentity(stableArtifactIdentity)
  if (!identity) {
    return blockedMutation("identity_unavailable")
  }

  const current = ensureState(identity)
  const annotation = normalizeAnnotationInput(input, identity)
  if (!annotation) {
    return blockedMutation("invalid_annotation", current.snapshot.annotations)
  }

  const annotations = [...current.snapshot.annotations, annotation]
  const snapshot = persistAndUpdate(identity, annotations, {
    stateClearedReason: null,
  })
  return {
    ok: true,
    annotation,
    annotations: snapshot.annotations,
    counts: snapshot.counts,
    blockedReason: null,
  }
}

export function updateAnnotation(
  stableArtifactIdentity: string | null | undefined,
  annotationId: string,
  patch: CoreviewAnnotationPatch,
): CoreviewAnnotationMutationResult {
  const identity = normalizeCoreviewAnnotationStableIdentity(stableArtifactIdentity)
  if (!identity) {
    return blockedMutation("identity_unavailable")
  }

  const current = ensureState(identity)
  let updated: CoreviewAnnotation | null = null
  const annotations = current.snapshot.annotations.map((annotation) => {
    if (annotation.id !== annotationId) {
      return annotation
    }
    const next = normalizeAnnotationPatch(annotation, patch)
    if (!next || annotationSignature(next) === annotationSignature(annotation)) {
      return annotation
    }
    updated = next
    return next
  })

  if (!updated) {
    return blockedMutation("annotation_not_found", current.snapshot.annotations)
  }

  const snapshot = persistAndUpdate(identity, annotations, {
    editDelta: 1,
    stateClearedReason: null,
  })
  return {
    ok: true,
    annotation: updated,
    annotations: snapshot.annotations,
    counts: snapshot.counts,
    blockedReason: null,
  }
}

export function deleteAnnotation(
  stableArtifactIdentity: string | null | undefined,
  annotationId: string,
): CoreviewAnnotationMutationResult {
  const identity = normalizeCoreviewAnnotationStableIdentity(stableArtifactIdentity)
  if (!identity) {
    return blockedMutation("identity_unavailable")
  }

  const current = ensureState(identity)
  const annotations = current.snapshot.annotations.filter((annotation) => annotation.id !== annotationId)
  if (annotations.length === current.snapshot.annotations.length) {
    return blockedMutation("annotation_not_found", current.snapshot.annotations)
  }

  const snapshot = persistAndUpdate(identity, annotations, {
    deleteDelta: 1,
    stateClearedReason: annotations.length === 0 ? "explicit_delete_all" : null,
  })
  return {
    ok: true,
    annotation: null,
    annotations: snapshot.annotations,
    counts: snapshot.counts,
    blockedReason: null,
  }
}

export function getAnnotationCountsByPage(stableArtifactIdentity: string | null | undefined): ReadonlyMap<number, number> {
  return getCoreviewAnnotationSnapshot(stableArtifactIdentity).pageCounts
}

export function getCoreviewAnnotationSnapshot(
  stableArtifactIdentity: string | null | undefined,
): CoreviewAnnotationStoreSnapshot {
  const identity = normalizeCoreviewAnnotationStableIdentity(stableArtifactIdentity)
  if (!identity) {
    return EMPTY_SNAPSHOT
  }
  return ensureState(identity).snapshot
}

export function buildCoreviewAnnotationStorageIdentity(stableArtifactIdentity: string | null | undefined) {
  const identity = normalizeCoreviewAnnotationStableIdentity(stableArtifactIdentity)
  return buildArtifactAnnotationWorkspaceIdentity({
    artifactStableIdentity: identity,
  })
}

export function normalizeCoreviewAnnotationStableIdentity(value: string | null | undefined): string | null {
  const normalized = normalizeToken(value)
  if (!normalized) {
    return null
  }

  if (normalized.startsWith("file://")) {
    const path = normalizeCoreviewArtifactPath(normalized)
    return path ? `path:${path}` : normalized
  }

  if (!normalized.includes("|") && !normalized.includes(":")) {
    const path = normalizeCoreviewArtifactPath(normalized)
    return path ? `path:${path}` : normalized
  }

  const parts = normalized.split("|")
  let changed = false
  const canonicalParts = parts.map((part) => {
    if (!part.startsWith("path:")) {
      return part
    }
    const canonicalPath = normalizeCoreviewArtifactPath(part.slice("path:".length))
    if (!canonicalPath || canonicalPath === part.slice("path:".length)) {
      return part
    }
    changed = true
    return `path:${canonicalPath}`
  })
  return changed ? canonicalParts.join("|") : normalized
}

export function clearCoreviewAnnotationStoreForTests(): void {
  states.clear()
  migrationReadAttempts.clear()
  notifySubscribers()
}

function migrateAnnotations(fromIdentity: string, toIdentity: string): CoreviewAnnotationStoreSnapshot | null {
  const from = getCoreviewAnnotationSnapshot(fromIdentity)
  const to = ensureState(toIdentity)
  if (from.annotations.length === 0 || to.snapshot.annotations.length > 0) {
    return null
  }

  const annotations = from.annotations.map((annotation) => ({
    ...annotation,
    artifactStableIdentity: toIdentity,
    updatedAt: Date.now(),
    version: COREVIEW_ANNOTATION_STORAGE_VERSION,
  } satisfies CoreviewAnnotation))
  const migrated = persistAndUpdate(toIdentity, annotations, {
    migratedDelta: 1,
    stateClearedReason: null,
  })
  return updateSnapshot(toIdentity, migrated.annotations, {
    telemetry: {
      ...migrated.telemetry,
      annotationRestoreAttempted: true,
      annotationRestoreResult: "migrated_identity",
      annotationRestoreCount: migrated.annotations.length,
      annotationStoreSurvivedCanvasClose: true,
    },
    restored: true,
  })
}

function restoreMigratedUserUnknownIdentity(
  identity: string,
  storageIdentity: ReturnType<typeof buildCoreviewAnnotationStorageIdentity>,
  source: CoreviewAnnotationRestoreSource,
): CoreviewAnnotationStoreSnapshot | null {
  const oldIdentity = userUnknownIdentityVariant(identity)
  if (!oldIdentity || oldIdentity === identity || migrationReadAttempts.has(identity)) {
    return null
  }
  migrationReadAttempts.add(identity)

  const oldStorageIdentity = buildCoreviewAnnotationStorageIdentity(oldIdentity)
  if (!oldStorageIdentity.storageKey || oldStorageIdentity.storageKey === storageIdentity.storageKey) {
    return null
  }

  const restored = restoreArtifactAnnotations(oldStorageIdentity.storageKey, oldIdentity)
  if (restored.restoreCount <= 0) {
    return null
  }

  const annotations = restored.annotations.map((annotation) => normalizeStoredAnnotation(annotation, identity))
  const snapshot = persistAndUpdate(identity, annotations, {
    migratedDelta: 1,
    stateClearedReason: null,
  })
  return updateSnapshot(identity, snapshot.annotations, {
    telemetry: {
      ...snapshot.telemetry,
      annotationPersistenceStatus: "restored",
      annotationRestoreAttempted: true,
      annotationRestoreResult: "migrated_user_unknown",
      annotationRestoreCount: restored.restoreCount,
      annotationRestoreSource: source,
      annotationIdentityReadHash: oldStorageIdentity.storageKeyHash,
      annotationStorageKeyHash: storageIdentity.storageKeyHash,
      annotationMigratedIdentityCount: snapshot.telemetry.annotationMigratedIdentityCount,
      annotationStoreSurvivedCanvasClose: true,
    },
    restored: true,
  })
}

function replaceAnnotations(
  identity: string,
  annotations: ArtifactAnnotation[],
  details: {
    restored: boolean
    persistenceStatus: ArtifactAnnotationPersistenceStatus | null
    restoreAttempted: boolean
    restoreResult: string | null
    restoreCount: number
    restoreSource: CoreviewAnnotationRestoreSource
    identityReadHash: string | null
    stateClearedReason: CoreviewAnnotationStateClearedReason
  },
): CoreviewAnnotationStoreSnapshot {
  const current = ensureState(identity)
  return updateSnapshot(identity, annotations.map((annotation) => normalizeStoredAnnotation(annotation, identity)), {
    telemetry: {
      ...current.snapshot.telemetry,
      coreviewAnnotationStoreActive: true,
      annotationPersistenceStatus: details.persistenceStatus,
      annotationRestoreAttempted: details.restoreAttempted,
      annotationRestoreResult: details.restoreResult,
      annotationRestoreCount: details.restoreCount,
      annotationRestoreSource: details.restoreSource,
      annotationPersistedCount: annotations.length,
      annotationStorageKeyHash: buildCoreviewAnnotationStorageIdentity(identity).storageKeyHash,
      annotationIdentityReadHash: details.identityReadHash,
      annotationStoreSurvivedCanvasClose: current.snapshot.annotations.length > 0,
      annotationStateClearedReason: details.stateClearedReason,
    },
    restored: details.restored,
  })
}

function persistAndUpdate(
  identity: string,
  annotations: CoreviewAnnotation[],
  details: {
    deleteDelta?: number
    editDelta?: number
    migratedDelta?: number
    stateClearedReason: CoreviewAnnotationStateClearedReason
  },
): CoreviewAnnotationStoreSnapshot {
  const current = ensureState(identity)
  const storageIdentity = buildCoreviewAnnotationStorageIdentity(identity)
  const persist = persistArtifactAnnotations(storageIdentity.storageKey, annotations, {
    stableArtifactIdentity: identity,
  })
  return updateSnapshot(identity, annotations, {
    telemetry: {
      ...current.snapshot.telemetry,
      coreviewAnnotationStoreActive: true,
      annotationPersistenceStatus: persist.status,
      annotationPersistAttempted: true,
      annotationPersistResult: persist.status,
      annotationPersistCount: persist.persistedCount,
      annotationPersistedCount: persist.persistedCount,
      annotationStorageKeyHash: storageIdentity.storageKeyHash,
      annotationIdentityWriteHash: storageIdentity.storageKeyHash,
      annotationMigratedIdentityCount: current.snapshot.telemetry.annotationMigratedIdentityCount + (details.migratedDelta ?? 0),
      annotationStateClearedReason: details.stateClearedReason,
      annotationDeleteCount: current.snapshot.telemetry.annotationDeleteCount + (details.deleteDelta ?? 0),
      annotationEditCount: current.snapshot.telemetry.annotationEditCount + (details.editDelta ?? 0),
    },
    restored: true,
  })
}

function updateSnapshot(
  identity: string,
  annotations: CoreviewAnnotation[],
  options: {
    telemetry: CoreviewAnnotationStoreTelemetry
    restored: boolean
  },
): CoreviewAnnotationStoreSnapshot {
  const storageIdentity = buildCoreviewAnnotationStorageIdentity(identity)
  const counts = countAnnotations(annotations)
  const nextSnapshot: CoreviewAnnotationStoreSnapshot = {
    stableArtifactIdentity: identity,
    annotations,
    counts,
    pageCounts: countAnnotationsByPage(annotations),
    annotationVersion: annotationCollectionSignature(annotations),
    telemetry: {
      ...options.telemetry,
      coreviewAnnotationStoreActive: true,
      coreviewAnnotationStateSource: "coreview",
      annotationStorageVersion: COREVIEW_ANNOTATION_STORAGE_VERSION,
      annotationStorageKeyHash: options.telemetry.annotationStorageKeyHash ?? storageIdentity.storageKeyHash,
      annotationStoreHydratedArtifactStage: annotations.length > 0,
    },
  }
  states.set(identity, {
    snapshot: nextSnapshot,
    restored: options.restored,
  })
  notifySubscribers()
  return nextSnapshot
}

function ensureState(identity: string): InternalState {
  const existing = states.get(identity)
  if (existing) {
    return existing
  }

  const storageIdentity = buildCoreviewAnnotationStorageIdentity(identity)
  const snapshot: CoreviewAnnotationStoreSnapshot = {
    stableArtifactIdentity: identity,
    annotations: [],
    counts: EMPTY_COUNTS,
    pageCounts: new Map(),
    annotationVersion: "",
    telemetry: {
      ...EMPTY_TELEMETRY,
      coreviewAnnotationStoreActive: true,
      annotationPersistenceStatus: "empty",
      annotationStorageKeyHash: storageIdentity.storageKeyHash,
      annotationStateClearedReason: null,
    },
  }
  const state = { snapshot, restored: false }
  states.set(identity, state)
  return state
}

function notifySubscribers() {
  for (const subscriber of subscribers) {
    subscriber()
  }
}

function blockedMutation(
  reason: CoreviewAnnotationMutationResult["blockedReason"],
  annotations: CoreviewAnnotation[] = [],
): CoreviewAnnotationMutationResult {
  return {
    ok: false,
    annotation: null,
    annotations,
    counts: countAnnotations(annotations),
    blockedReason: reason,
  }
}

function normalizeAnnotationInput(input: CoreviewAnnotationInput, stableArtifactIdentity: string): CoreviewAnnotation | null {
  const pageIndex = normalizePageIndex(input.pageIndex)
  const createdAt = normalizeTimestamp(input.createdAt) ?? Date.now()
  const updatedAt = normalizeTimestamp(input.updatedAt) ?? createdAt
  if (pageIndex === null) {
    return null
  }

  const base = {
    id: normalizeToken(input.id) ?? nextCoreviewAnnotationId(input.kind),
    artifactStableIdentity: stableArtifactIdentity,
    actorId: normalizeToken(input.actorId) ?? undefined,
    pageIndex,
    color: normalizeAnnotationColor(input.color) ?? defaultAnnotationColor(input.kind),
    source: normalizeAnnotationSource(input.source) ?? "user",
    createdAt,
    updatedAt,
    version: COREVIEW_ANNOTATION_STORAGE_VERSION as 1,
  }

  if (input.kind === "highlight") {
    const rect = normalizeRect(input.rect)
    return rect ? { ...base, kind: "highlight", rect } : null
  }
  if (input.kind === "underline") {
    const rect = normalizeRect(input.rect)
    return rect ? { ...base, kind: "underline", rect } : null
  }
  if (input.kind === "comment") {
    const point = normalizePoint(input.point)
    return point ? { ...base, kind: "comment", point, text: normalizeCommentText(input.text) } : null
  }

  const line = normalizeLine(input.line)
  return line ? { ...base, kind: "arrow", line } : null
}

function normalizeAnnotationPatch(annotation: CoreviewAnnotation, patch: CoreviewAnnotationPatch): CoreviewAnnotation | null {
  const updatedAt = Date.now()
  const color = patch.color === undefined ? annotation.color : normalizeAnnotationColor(patch.color) ?? annotation.color
  const actorId = patch.actorId === undefined ? annotation.actorId : normalizeToken(patch.actorId) ?? undefined

  if (annotation.kind === "highlight" || annotation.kind === "underline") {
    const rect = patch.rect === undefined ? annotation.rect : normalizeRect(patch.rect)
    return rect ? { ...annotation, rect, color, actorId, updatedAt, version: COREVIEW_ANNOTATION_STORAGE_VERSION as 1 } : null
  }
  if (annotation.kind === "comment") {
    const point = patch.point === undefined ? annotation.point : normalizePoint(patch.point)
    const text = patch.text === undefined ? annotation.text : normalizeCommentText(patch.text)
    return point ? { ...annotation, point, text, color, actorId, updatedAt, version: COREVIEW_ANNOTATION_STORAGE_VERSION as 1 } : null
  }

  const line = patch.line === undefined ? annotation.line : normalizeLine(patch.line)
  return line ? { ...annotation, line, color, actorId, updatedAt, version: COREVIEW_ANNOTATION_STORAGE_VERSION as 1 } : null
}

function normalizeStoredAnnotation(annotation: ArtifactAnnotation, stableArtifactIdentity: string): CoreviewAnnotation {
  return {
    ...annotation,
    artifactStableIdentity: stableArtifactIdentity,
    source: annotation.source ?? "user",
    updatedAt: annotation.updatedAt ?? annotation.createdAt,
    version: COREVIEW_ANNOTATION_STORAGE_VERSION as 1,
  } as CoreviewAnnotation
}

function countAnnotations(annotations: readonly ArtifactAnnotation[]): CoreviewAnnotationCounts {
  let highlightCount = 0
  let commentCount = 0
  let underlineCount = 0
  let arrowCount = 0
  for (const annotation of annotations) {
    if (annotation.kind === "highlight") {
      highlightCount += 1
    } else if (annotation.kind === "comment") {
      commentCount += 1
    } else if (annotation.kind === "underline") {
      underlineCount += 1
    } else if (annotation.kind === "arrow") {
      arrowCount += 1
    }
  }
  return {
    annotationCount: annotations.length,
    highlightCount,
    commentCount,
    underlineCount,
    arrowCount,
    drawPathCount: 0,
  }
}

function countAnnotationsByPage(annotations: readonly ArtifactAnnotation[]): ReadonlyMap<number, number> {
  const counts = new Map<number, number>()
  for (const annotation of annotations) {
    counts.set(annotation.pageIndex, (counts.get(annotation.pageIndex) ?? 0) + 1)
  }
  return counts
}

function annotationCollectionSignature(annotations: readonly ArtifactAnnotation[]): string {
  return annotations.map(annotationSignature).join("|")
}

function annotationSignature(annotation: ArtifactAnnotation): string {
  if (annotation.kind === "highlight" || annotation.kind === "underline") {
    return [
      annotation.id,
      annotation.kind,
      annotation.pageIndex,
      annotation.color ?? "",
      annotation.source ?? "",
      annotation.rect.x.toFixed(4),
      annotation.rect.y.toFixed(4),
      annotation.rect.width.toFixed(4),
      annotation.rect.height.toFixed(4),
      annotation.updatedAt ?? annotation.createdAt,
    ].join(":")
  }
  if (annotation.kind === "arrow") {
    return [
      annotation.id,
      annotation.kind,
      annotation.pageIndex,
      annotation.color ?? "",
      annotation.source ?? "",
      annotation.line.start.x.toFixed(4),
      annotation.line.start.y.toFixed(4),
      annotation.line.end.x.toFixed(4),
      annotation.line.end.y.toFixed(4),
      annotation.updatedAt ?? annotation.createdAt,
    ].join(":")
  }
  return [
    annotation.id,
    annotation.kind,
    annotation.pageIndex,
    annotation.source ?? "",
    annotation.point.x.toFixed(4),
    annotation.point.y.toFixed(4),
    annotation.text.length,
    annotation.updatedAt ?? annotation.createdAt,
  ].join(":")
}

function userUnknownIdentityVariant(identity: string): string | null {
  if (!identity.startsWith("user:") || identity.startsWith("user:unknown|")) {
    return null
  }
  return identity.replace(/^user:[^|]+/u, "user:unknown")
}

function defaultAnnotationColor(kind: ArtifactAnnotationKind): ArtifactAnnotationColor {
  return kind === "highlight" ? "yellow" : "purple"
}

function normalizeAnnotationColor(value: unknown): ArtifactAnnotationColor | undefined {
  return value === "yellow" || value === "purple" || value === "blue" || value === "pink"
    ? value
    : undefined
}

function normalizeAnnotationSource(value: unknown): ArtifactAnnotationSource | undefined {
  return value === "sophia" || value === "user" ? value : undefined
}

function normalizeRect(value: unknown): NormalizedArtifactRect | null {
  if (!isRecord(value)) {
    return null
  }
  const x = clampNormalizedNumber(value.x)
  const y = clampNormalizedNumber(value.y)
  const width = clampNormalizedNumber(value.width)
  const height = clampNormalizedNumber(value.height)
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
    return null
  }
  return {
    x,
    y,
    width: Math.min(width, 1 - x),
    height: Math.min(height, 1 - y),
  }
}

function normalizePoint(value: unknown): NormalizedArtifactPoint | null {
  if (!isRecord(value)) {
    return null
  }
  const x = clampNormalizedNumber(value.x)
  const y = clampNormalizedNumber(value.y)
  return x === null || y === null ? null : { x, y }
}

function normalizeLine(value: unknown): NormalizedArtifactLine | null {
  if (!isRecord(value)) {
    return null
  }
  const start = normalizePoint(value.start) ?? normalizePoint({ x: value.x1, y: value.y1 })
  const end = normalizePoint(value.end) ?? normalizePoint({ x: value.x2, y: value.y2 })
  if (!start || !end || Math.hypot(end.x - start.x, end.y - start.y) <= 0.001) {
    return null
  }
  return { start, end }
}

function normalizeCommentText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\r\n\t]+/gu, " ").slice(0, 180)
    : ""
}

function normalizePageIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null
}

function normalizeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null
}

function clampNormalizedNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null
}

function normalizeToken(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function nextCoreviewAnnotationId(kind: ArtifactAnnotationKind): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
