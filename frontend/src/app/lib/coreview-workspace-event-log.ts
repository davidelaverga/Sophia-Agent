import { COREVIEW_WORKSPACE_CONTRACT_VERSION } from "./coreview-workspace-contract"
import {
  isCoreviewWorkspaceEventType,
  type CoreviewWorkspaceActor,
  type CoreviewWorkspaceActorKind,
  type CoreviewWorkspaceEvent,
  type CoreviewWorkspaceEventType,
} from "./coreview-workspace-events"
import type { CoreviewWorkspaceShareState } from "./coreview-workspace-share"

export type CoreviewWorkspaceEventLogResult =
  | "unavailable"
  | "empty"
  | "restored"
  | "corrupt"
  | "saved"
  | "failed"

export type CoreviewWorkspaceEventAppendInput = {
  id?: string | null
  type: CoreviewWorkspaceEventType
  workspaceKey: string
  artifactKey?: string | null
  actor: CoreviewWorkspaceActor
  createdAt?: string | null
  payload?: Record<string, unknown> | null
  artifactId?: string | null
  artifactStableIdentity?: string | null
  threadId?: string | null
  builderTaskId?: string | null
  builderRunId?: string | null
}

export type CoreviewWorkspaceEventCounts = {
  eventCount: number
  typeCounts: Partial<Record<CoreviewWorkspaceEventType, number>>
  lastEventType: CoreviewWorkspaceEventType | null
  lastActorKind: CoreviewWorkspaceActorKind | null
  annotationEventsCreatedCount: number
  viewChangedEventCount: number
  builderWorkspaceEventCount: number
  builderLastWorkspaceEventType: CoreviewWorkspaceEventType | null
}

export type CoreviewWorkspaceEventLogTelemetry = {
  coreviewWorkspaceEventLogActive: boolean
  coreviewWorkspaceContractVersion: number
  coreviewWorkspaceEventCount: number
  coreviewWorkspaceLastEventType: CoreviewWorkspaceEventType | null
  coreviewWorkspaceActorKind: CoreviewWorkspaceActorKind | null
  coreviewWorkspaceHasShareReadyMetadata: boolean
  coreviewShareStatus: CoreviewWorkspaceShareState["status"]
  workspaceEventLogPersistResult: CoreviewWorkspaceEventLogResult
  workspaceEventLogRestoreCount: number
  annotationEventsCreatedCount: number
  viewChangedEventCount: number
  builderWorkspaceEventCount: number
  builderLastWorkspaceEventType: CoreviewWorkspaceEventType | null
  rawCommentTextExcluded: true
  rawArtifactTextExcluded: true
  rawFrameExcluded: true
}

type StoredWorkspaceEventLogV1 = {
  version: 1
  workspaceKey: string
  events: CoreviewWorkspaceEvent[]
  updatedAt: string
}

type WorkspaceEventLogMeta = {
  persistResult: CoreviewWorkspaceEventLogResult
  restoreResult: CoreviewWorkspaceEventLogResult
  restoreCount: number
}

const STORAGE_PREFIX = "sophia:coreview-workspace-events:v1:"
const MAX_EVENTS_PER_WORKSPACE = 1000
const logs = new Map<string, CoreviewWorkspaceEvent[]>()
const restoredWorkspaceKeys = new Set<string>()
const metadataByWorkspaceKey = new Map<string, WorkspaceEventLogMeta>()

export function appendWorkspaceEvent(input: CoreviewWorkspaceEventAppendInput): CoreviewWorkspaceEvent {
  const workspaceKey = normalizeToken(input.workspaceKey)
  if (!workspaceKey) {
    throw new Error("workspaceKey is required")
  }
  if (!isCoreviewWorkspaceEventType(input.type)) {
    throw new Error("workspace event type is unsupported")
  }

  const existing = restoreWorkspaceEvents(workspaceKey)
  const event = normalizeAppendInput(input, workspaceKey)
  const next = [...existing, event].slice(-MAX_EVENTS_PER_WORKSPACE)
  logs.set(workspaceKey, next)
  const persistResult = persistWorkspaceEvents(workspaceKey, next)
  const currentMeta = ensureMeta(workspaceKey)
  metadataByWorkspaceKey.set(workspaceKey, {
    ...currentMeta,
    persistResult,
  })
  return event
}

export function getWorkspaceEvents(
  workspaceKey: string | null | undefined,
  artifactKey?: string | null,
): CoreviewWorkspaceEvent[] {
  const normalizedWorkspaceKey = normalizeToken(workspaceKey)
  if (!normalizedWorkspaceKey) {
    return []
  }
  const events = restoreWorkspaceEvents(normalizedWorkspaceKey)
  const normalizedArtifactKey = normalizeToken(artifactKey)
  return normalizedArtifactKey
    ? events.filter((event) => event.artifactKey === normalizedArtifactKey)
    : [...events]
}

export function getLatestWorkspaceEvent(
  workspaceKey: string | null | undefined,
  artifactKey?: string | null,
): CoreviewWorkspaceEvent | null {
  return getWorkspaceEvents(workspaceKey, artifactKey).at(-1) ?? null
}

export function getWorkspaceEventCounts(
  workspaceKey: string | null | undefined,
  artifactKey?: string | null,
): CoreviewWorkspaceEventCounts {
  const events = getWorkspaceEvents(workspaceKey, artifactKey)
  const typeCounts: Partial<Record<CoreviewWorkspaceEventType, number>> = {}
  for (const event of events) {
    typeCounts[event.type] = (typeCounts[event.type] ?? 0) + 1
  }
  const latest = events.at(-1) ?? null
  return {
    eventCount: events.length,
    typeCounts,
    lastEventType: latest?.type ?? null,
    lastActorKind: latest?.actor.kind ?? null,
    annotationEventsCreatedCount: typeCounts["annotation.created"] ?? 0,
    viewChangedEventCount: typeCounts["view.changed"] ?? 0,
    builderWorkspaceEventCount: events.filter((event) => isBuilderWorkspaceEventType(event.type)).length,
    builderLastWorkspaceEventType: [...events].reverse().find((event) => isBuilderWorkspaceEventType(event.type))?.type ?? null,
  }
}

export function getCoreviewWorkspaceEventLogTelemetry(
  workspaceKey: string | null | undefined,
  artifactKey: string | null | undefined,
  shareState: CoreviewWorkspaceShareState,
): CoreviewWorkspaceEventLogTelemetry {
  const normalizedWorkspaceKey = normalizeToken(workspaceKey)
  const counts = getWorkspaceEventCounts(normalizedWorkspaceKey, artifactKey)
  const meta = normalizedWorkspaceKey ? ensureMeta(normalizedWorkspaceKey) : null

  return {
    coreviewWorkspaceEventLogActive: Boolean(normalizedWorkspaceKey),
    coreviewWorkspaceContractVersion: COREVIEW_WORKSPACE_CONTRACT_VERSION,
    coreviewWorkspaceEventCount: counts.eventCount,
    coreviewWorkspaceLastEventType: counts.lastEventType,
    coreviewWorkspaceActorKind: counts.lastActorKind,
    coreviewWorkspaceHasShareReadyMetadata: shareState.permissionsModel === "not_implemented",
    coreviewShareStatus: shareState.status,
    workspaceEventLogPersistResult: meta?.persistResult ?? "empty",
    workspaceEventLogRestoreCount: meta?.restoreCount ?? 0,
    annotationEventsCreatedCount: counts.annotationEventsCreatedCount,
    viewChangedEventCount: counts.viewChangedEventCount,
    builderWorkspaceEventCount: counts.builderWorkspaceEventCount,
    builderLastWorkspaceEventType: counts.builderLastWorkspaceEventType,
    rawCommentTextExcluded: true,
    rawArtifactTextExcluded: true,
    rawFrameExcluded: true,
  }
}

export function clearWorkspaceEventsForTestOnly(workspaceKey?: string | null): void {
  const normalizedWorkspaceKey = normalizeToken(workspaceKey)
  if (normalizedWorkspaceKey) {
    logs.delete(normalizedWorkspaceKey)
    restoredWorkspaceKeys.delete(normalizedWorkspaceKey)
    metadataByWorkspaceKey.delete(normalizedWorkspaceKey)
    removeLocalStorageKey(storageKeyForWorkspace(normalizedWorkspaceKey))
    return
  }

  logs.clear()
  restoredWorkspaceKeys.clear()
  metadataByWorkspaceKey.clear()
  const storage = getLocalStorage()
  if (!storage) {
    return
  }
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith(STORAGE_PREFIX)))
    for (const key of keys) {
      storage.removeItem(key)
    }
  } catch {
    // Test cleanup is best-effort when localStorage is unavailable.
  }
}

export function hashCoreviewWorkspaceKey(workspaceKey: string | null | undefined): string | null {
  const normalized = normalizeToken(workspaceKey)
  return normalized ? stableHash(normalized) : null
}

function normalizeAppendInput(
  input: CoreviewWorkspaceEventAppendInput,
  workspaceKey: string,
): CoreviewWorkspaceEvent {
  return {
    id: normalizeToken(input.id) ?? nextWorkspaceEventId(input.type),
    type: input.type,
    workspaceKey,
    artifactKey: normalizeToken(input.artifactKey),
    actor: normalizeActor(input.actor),
    createdAt: normalizeIsoDate(input.createdAt) ?? new Date().toISOString(),
    version: 1,
    payload: sanitizeWorkspaceEventPayload(input.payload ?? {}),
    artifactId: normalizeToken(input.artifactId),
    artifactStableIdentity: normalizeToken(input.artifactStableIdentity),
    threadId: normalizeToken(input.threadId),
    builderTaskId: normalizeToken(input.builderTaskId),
    builderRunId: normalizeToken(input.builderRunId),
  }
}

function restoreWorkspaceEvents(workspaceKey: string): CoreviewWorkspaceEvent[] {
  const normalizedWorkspaceKey = normalizeToken(workspaceKey)
  if (!normalizedWorkspaceKey) {
    return []
  }
  if (restoredWorkspaceKeys.has(normalizedWorkspaceKey)) {
    return logs.get(normalizedWorkspaceKey) ?? []
  }

  restoredWorkspaceKeys.add(normalizedWorkspaceKey)
  const storage = getLocalStorage()
  const storageKey = storageKeyForWorkspace(normalizedWorkspaceKey)
  if (!storage) {
    logs.set(normalizedWorkspaceKey, logs.get(normalizedWorkspaceKey) ?? [])
    metadataByWorkspaceKey.set(normalizedWorkspaceKey, {
      persistResult: "unavailable",
      restoreResult: "unavailable",
      restoreCount: 0,
    })
    return logs.get(normalizedWorkspaceKey) ?? []
  }

  const raw = safeGetItem(storage, storageKey)
  if (!raw) {
    logs.set(normalizedWorkspaceKey, logs.get(normalizedWorkspaceKey) ?? [])
    metadataByWorkspaceKey.set(normalizedWorkspaceKey, {
      persistResult: "empty",
      restoreResult: "empty",
      restoreCount: 0,
    })
    return logs.get(normalizedWorkspaceKey) ?? []
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    const restored = eventsFromStoragePayload(parsed, normalizedWorkspaceKey)
    if (!restored) {
      storage.removeItem(storageKey)
      logs.set(normalizedWorkspaceKey, [])
      metadataByWorkspaceKey.set(normalizedWorkspaceKey, {
        persistResult: "corrupt",
        restoreResult: "corrupt",
        restoreCount: 0,
      })
      return []
    }
    logs.set(normalizedWorkspaceKey, restored)
    metadataByWorkspaceKey.set(normalizedWorkspaceKey, {
      persistResult: "restored",
      restoreResult: restored.length > 0 ? "restored" : "empty",
      restoreCount: restored.length,
    })
    return restored
  } catch {
    removeLocalStorageKey(storageKey)
    logs.set(normalizedWorkspaceKey, [])
    metadataByWorkspaceKey.set(normalizedWorkspaceKey, {
      persistResult: "corrupt",
      restoreResult: "corrupt",
      restoreCount: 0,
    })
    return []
  }
}

function persistWorkspaceEvents(
  workspaceKey: string,
  events: CoreviewWorkspaceEvent[],
): CoreviewWorkspaceEventLogResult {
  const storage = getLocalStorage()
  if (!storage) {
    return "unavailable"
  }
  try {
    storage.setItem(storageKeyForWorkspace(workspaceKey), JSON.stringify({
      version: 1,
      workspaceKey,
      events,
      updatedAt: new Date().toISOString(),
    } satisfies StoredWorkspaceEventLogV1))
    return "saved"
  } catch {
    return "failed"
  }
}

function eventsFromStoragePayload(value: unknown, expectedWorkspaceKey: string): CoreviewWorkspaceEvent[] | null {
  if (!isRecord(value) || value.version !== 1 || value.workspaceKey !== expectedWorkspaceKey || !Array.isArray(value.events)) {
    return null
  }

  const events: CoreviewWorkspaceEvent[] = []
  for (const entry of value.events.slice(-MAX_EVENTS_PER_WORKSPACE)) {
    const event = eventFromStorageEntry(entry, expectedWorkspaceKey)
    if (!event) {
      return null
    }
    events.push(event)
  }
  return events
}

function eventFromStorageEntry(value: unknown, expectedWorkspaceKey: string): CoreviewWorkspaceEvent | null {
  if (!isRecord(value)) {
    return null
  }
  if (!isCoreviewWorkspaceEventType(value.type) || value.workspaceKey !== expectedWorkspaceKey || value.version !== 1) {
    return null
  }
  const id = normalizeToken(value.id)
  const actor = isRecord(value.actor) ? normalizeActor(value.actor) : null
  const createdAt = normalizeIsoDate(value.createdAt)
  if (!id || !actor || !createdAt) {
    return null
  }
  return {
    id,
    type: value.type,
    workspaceKey: expectedWorkspaceKey,
    artifactKey: normalizeToken(value.artifactKey),
    actor,
    createdAt,
    version: 1,
    payload: sanitizeWorkspaceEventPayload(isRecord(value.payload) ? value.payload : {}),
    artifactId: normalizeToken(value.artifactId),
    artifactStableIdentity: normalizeToken(value.artifactStableIdentity),
    threadId: normalizeToken(value.threadId),
    builderTaskId: normalizeToken(value.builderTaskId),
    builderRunId: normalizeToken(value.builderRunId),
  }
}

function sanitizeWorkspaceEventPayload(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isRawFrameKey(key) || isRawCommentTextKey(key) || isRawArtifactTextKey(key)) {
      continue
    }
    const next = sanitizeJsonValue(entry)
    if (next !== undefined) {
      sanitized[key] = next
    }
  }
  return {
    ...sanitized,
    rawCommentTextExcluded: true,
    rawArtifactTextExcluded: true,
    rawFrameExcluded: true,
  }
}

function sanitizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  if (Array.isArray(value)) {
    return value
      .map(sanitizeJsonValue)
      .filter((entry) => entry !== undefined)
  }
  if (!isRecord(value)) {
    return undefined
  }

  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isRawFrameKey(key) || isRawCommentTextKey(key) || isRawArtifactTextKey(key)) {
      continue
    }
    const next = sanitizeJsonValue(entry)
    if (next !== undefined) {
      output[key] = next
    }
  }
  return output
}

function normalizeActor(actor: unknown): CoreviewWorkspaceActor {
  const record = isRecord(actor) ? actor : {}
  const rawKind = record.kind
  const kind = rawKind === "sophia"
    || rawKind === "system"
    || rawKind === "collaborator_future"
    ? rawKind
    : "user"
  return {
    kind,
    id: normalizeToken(record.id) ?? (kind === "system" ? "system" : `${kind}:unknown`),
    displayName: normalizeToken(record.displayName),
  }
}

function ensureMeta(workspaceKey: string): WorkspaceEventLogMeta {
  restoreWorkspaceEvents(workspaceKey)
  const existing = metadataByWorkspaceKey.get(workspaceKey)
  if (existing) {
    return existing
  }
  const meta: WorkspaceEventLogMeta = {
    persistResult: "empty",
    restoreResult: "empty",
    restoreCount: 0,
  }
  metadataByWorkspaceKey.set(workspaceKey, meta)
  return meta
}

function storageKeyForWorkspace(workspaceKey: string): string {
  return `${STORAGE_PREFIX}${stableHash(workspaceKey)}`
}

function nextWorkspaceEventId(type: CoreviewWorkspaceEventType): string {
  return `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null
  }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function getLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

function safeGetItem(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function removeLocalStorageKey(key: string) {
  const storage = getLocalStorage()
  try {
    storage?.removeItem(key)
  } catch {
    // Storage cleanup is best-effort.
  }
}

function isRawFrameKey(key: string): boolean {
  return /^(data|base64|frame|rawFrame|raw_frame|frameData|frame_data|rawFrameData|raw_frame_data|imageData|image_data|dataUrl|data_url|canvas)$/u.test(key)
}

function isRawCommentTextKey(key: string): boolean {
  return /^(text|note|commentText|comment_text|rawCommentText|raw_comment_text)$/u.test(key)
}

function isRawArtifactTextKey(key: string): boolean {
  return /^(content|artifactText|artifact_text|rawArtifactText|raw_artifact_text|documentText|document_text)$/u.test(key)
}

function isBuilderWorkspaceEventType(type: CoreviewWorkspaceEventType): boolean {
  return type.startsWith("builder.") || type.startsWith("artifact.version_")
}

function normalizeToken(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function stableHash(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index)
  }
  return (hash >>> 0).toString(36)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
