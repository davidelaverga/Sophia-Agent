import type { ArtifactRendererKind } from "./artifact-renderers"
import { classifyBuilderArtifactFileRole, normalizeBuilderArtifactPath } from "./builder-artifacts"
import { buildCoreviewArtifactStableIdentity } from "./coreview-artifact-identity"

export const ARTIFACT_SESSION_INDEX_STORAGE_VERSION = 1

const STORAGE_PREFIX = "sophia:session-artifact-index:v1:"
const RECENTLY_OPENED_LIMIT = 12

export type ArtifactStorageProvider = "local" | "supabase" | "hybrid"

export type ArtifactRecordReviewMetadata = {
  openedCount?: number
  lastOpenedAt?: string | null
  missing?: boolean
  annotationCount?: number | null
}

export type ArtifactRecordCapabilitiesSnapshot = Record<string, boolean | number | string | null>

export interface ArtifactRecord {
  artifactId: string
  stableArtifactIdentity: string
  logicalArtifactId: string
  versionId: string
  parentVersionId?: string | null
  userId?: string | null
  threadId: string
  sessionId?: string | null
  parentThreadId?: string | null
  taskId?: string | null
  runId?: string | null
  title: string
  filename?: string | null
  artifactType: string
  rendererKind: ArtifactRendererKind
  mimeType?: string | null
  localPath: string
  storageProvider: ArtifactStorageProvider
  storageBucket?: string | null
  storageObjectPath?: string | null
  contentUrl?: string | null
  downloadUrl?: string | null
  signedUrl?: string | null
  signedUrlExpiresAt?: string | null
  createdAt: string
  updatedAt: string
  sourceArtifactPath?: string | null
  revisionOfArtifactPath?: string | null
  sourceHash?: string | null
  contentHash?: string | null
  capabilities?: ArtifactRecordCapabilitiesSnapshot | null
  review?: ArtifactRecordReviewMetadata | null
  safeSummary?: string | null
  rawContentExcluded: true
}

export interface ArtifactSessionIndex {
  userId?: string | null
  threadId: string
  sessionId?: string | null
  artifacts: ArtifactRecord[]
  activeArtifactId?: string | null
  recentlyOpenedArtifactIds: string[]
}

export interface ArtifactSessionIndexContext {
  userId?: string | null
  threadId?: string | null
  sessionId?: string | null
  parentThreadId?: string | null
  voiceAgentSessionId?: string | null
}

export type ArtifactRegisterSource =
  | "builder_completion"
  | "builder_canvas"
  | "current_builder_artifact"
  | "selected_stage"
  | "file_library"
  | "quick_patch"
  | "canvas_open"
  | "coreview_version"
  | "manual"

export interface RegisterArtifactInput {
  context: ArtifactSessionIndexContext
  artifactId?: string | null
  artifact_id?: string | null
  localPath?: string | null
  local_path?: string | null
  title?: string | null
  filename?: string | null
  artifactType?: string | null
  artifact_type?: string | null
  rendererKind?: ArtifactRendererKind | null
  renderer_kind?: ArtifactRendererKind | null
  mimeType?: string | null
  mime_type?: string | null
  stableArtifactIdentity?: string | null
  logicalArtifactId?: string | null
  logical_artifact_id?: string | null
  versionId?: string | null
  version_id?: string | null
  parentVersionId?: string | null
  parent_version_id?: string | null
  taskId?: string | null
  task_id?: string | null
  runId?: string | null
  run_id?: string | null
  sourceArtifactPath?: string | null
  source_artifact_path?: string | null
  revisionOfArtifactPath?: string | null
  revision_of_artifact_path?: string | null
  sourceHash?: string | null
  contentHash?: string | null
  content_hash?: string | null
  capabilities?: ArtifactRecordCapabilitiesSnapshot | null
  review?: ArtifactRecordReviewMetadata | null
  safeSummary?: string | null
  safe_summary?: string | null
  createdAt?: string | null
  created_at?: string | null
  updatedAt?: string | null
  updated_at?: string | null
  storageProvider?: ArtifactStorageProvider | null
  storage_provider?: ArtifactStorageProvider | null
  storageBucket?: string | null
  storage_bucket?: string | null
  storageObjectPath?: string | null
  storage_object_path?: string | null
  contentUrl?: string | null
  content_url?: string | null
  downloadUrl?: string | null
  download_url?: string | null
  signedUrl?: string | null
  signedUrlExpiresAt?: string | null
  source?: ArtifactRegisterSource
}

export type RegisterArtifactResult = {
  index: ArtifactSessionIndex
  record: ArtifactRecord | null
  deduped: boolean
  result: "registered" | "updated" | "invalid_context" | "invalid_path" | "invalid_renderer"
}

export type OpenArtifactResult = {
  index: ArtifactSessionIndex
  record: ArtifactRecord | null
  result: "opened" | "not_found" | "invalid_context"
}

export function loadArtifactSessionIndex(context: ArtifactSessionIndexContext): ArtifactSessionIndex {
  const normalizedContext = normalizeContext(context)
  const empty = createEmptyArtifactSessionIndex(normalizedContext)
  const storage = getLocalStorage()
  if (!storage || !normalizedContext.threadId) {
    return empty
  }

  try {
    const raw = storage.getItem(storageKey(normalizedContext))
    if (!raw) {
      return empty
    }
    const parsed = JSON.parse(raw) as unknown
    return indexFromStorage(parsed, normalizedContext) ?? empty
  } catch {
    try {
      storage.removeItem(storageKey(normalizedContext))
    } catch {
      // Local cleanup is best-effort.
    }
    return empty
  }
}

export function saveArtifactSessionIndex(
  context: ArtifactSessionIndexContext,
  index: ArtifactSessionIndex,
): void {
  const normalizedContext = normalizeContext(context)
  const storage = getLocalStorage()
  if (!storage || !normalizedContext.threadId) {
    return
  }
  try {
    storage.setItem(storageKey(normalizedContext), JSON.stringify({
      version: ARTIFACT_SESSION_INDEX_STORAGE_VERSION,
      userId: normalizedContext.userId,
      threadId: normalizedContext.threadId,
      sessionId: normalizedContext.sessionId,
      index,
      updatedAt: new Date().toISOString(),
    }))
  } catch {
    // Local persistence is best-effort.
  }
}

export function registerArtifactInSessionIndex(input: RegisterArtifactInput): RegisterArtifactResult {
  const normalizedContext = normalizeContext(input.context)
  const index = loadArtifactSessionIndex(normalizedContext)
  const now = normalizeIsoDate(input.updatedAt ?? input.updated_at) ?? new Date().toISOString()
  const localPath = normalizeBuilderArtifactPath(input.localPath ?? input.local_path)
  const rendererKind = normalizeRendererKind(input.rendererKind ?? input.renderer_kind)

  if (!normalizedContext.threadId) {
    return { index, record: null, deduped: false, result: "invalid_context" }
  }
  if (!localPath) {
    return { index, record: null, deduped: false, result: "invalid_path" }
  }
  if (!rendererKind) {
    return { index, record: null, deduped: false, result: "invalid_renderer" }
  }

  const existingIndex = index.artifacts.findIndex((record) => (
    record.threadId === normalizedContext.threadId
      && normalizeBuilderArtifactPath(record.localPath) === localPath
      && record.rendererKind === rendererKind
  ))
  const existingRecord = existingIndex >= 0 ? index.artifacts[existingIndex] : null
  const sourceArtifactPath = normalizeBuilderArtifactPath(input.sourceArtifactPath ?? input.source_artifact_path)
  const revisionOfArtifactPath = normalizeBuilderArtifactPath(input.revisionOfArtifactPath ?? input.revision_of_artifact_path)
  const parentRecord = findParentVersionRecord(index, {
    localPath,
    rendererKind,
    sourceArtifactPath,
    revisionOfArtifactPath,
  })
  const stableArtifactIdentity = normalizeToken(input.stableArtifactIdentity)
    ?? existingRecord?.stableArtifactIdentity
    ?? buildCoreviewArtifactStableIdentity({
      userId: normalizedContext.userId,
      threadId: normalizedContext.threadId,
      parentThreadId: normalizedContext.parentThreadId,
      artifactPath: localPath,
      rendererKind,
    }).key
  const logicalArtifactId = normalizeToken(input.logicalArtifactId ?? input.logical_artifact_id)
    ?? existingRecord?.logicalArtifactId
    ?? parentRecord?.logicalArtifactId
    ?? stableArtifactIdentity
  const versionId = normalizeToken(input.versionId ?? input.version_id)
    ?? existingRecord?.versionId
    ?? stableVersionId(stableArtifactIdentity)
  const parentVersionId = normalizeToken(input.parentVersionId ?? input.parent_version_id)
    ?? existingRecord?.parentVersionId
    ?? parentRecord?.versionId
    ?? null
  const createdAt = existingRecord?.createdAt
    ?? normalizeIsoDate(input.createdAt ?? input.created_at)
    ?? now
  const artifactId = chooseArtifactId({
    current: existingRecord?.artifactId,
    requested: normalizeToken(input.artifactId ?? input.artifact_id),
    fallback: stableArtifactId(normalizedContext.threadId, localPath, rendererKind),
  })
  const title = chooseTitle({
    currentTitle: existingRecord?.title,
    nextTitle: input.title,
    path: localPath,
    source: input.source,
  })
  const artifactType = normalizeToken(input.artifactType ?? input.artifact_type)
    ?? existingRecord?.artifactType
    ?? artifactTypeFromPath(localPath, rendererKind)
  const storageBucket = normalizeToken(input.storageBucket ?? input.storage_bucket) ?? existingRecord?.storageBucket ?? null
  const storageObjectPath = normalizeToken(input.storageObjectPath ?? input.storage_object_path) ?? existingRecord?.storageObjectPath ?? null
  const storageProvider = chooseStorageProvider({
    requested: normalizeStorageProvider(input.storageProvider ?? input.storage_provider),
    current: existingRecord?.storageProvider,
    storageBucket,
    storageObjectPath,
  })

  const record: ArtifactRecord = {
    ...(existingRecord ?? {}),
    artifactId,
    stableArtifactIdentity,
    logicalArtifactId,
    versionId,
    parentVersionId,
    userId: normalizedContext.userId,
    threadId: normalizedContext.threadId,
    sessionId: normalizedContext.sessionId,
    parentThreadId: normalizedContext.parentThreadId ?? existingRecord?.parentThreadId ?? null,
    taskId: normalizeToken(input.taskId ?? input.task_id) ?? existingRecord?.taskId ?? null,
    runId: normalizeToken(input.runId ?? input.run_id) ?? existingRecord?.runId ?? null,
    title,
    filename: normalizeToken(input.filename) ?? existingRecord?.filename ?? fallbackTitle(localPath),
    artifactType,
    rendererKind,
    mimeType: normalizeToken(input.mimeType ?? input.mime_type) ?? existingRecord?.mimeType ?? null,
    localPath,
    storageProvider,
    storageBucket,
    storageObjectPath,
    contentUrl: normalizeHref(input.contentUrl ?? input.content_url) ?? existingRecord?.contentUrl ?? null,
    downloadUrl: normalizeHref(input.downloadUrl ?? input.download_url) ?? existingRecord?.downloadUrl ?? null,
    signedUrl: normalizeToken(input.signedUrl) ?? existingRecord?.signedUrl ?? null,
    signedUrlExpiresAt: normalizeIsoDate(input.signedUrlExpiresAt) ?? existingRecord?.signedUrlExpiresAt ?? null,
    createdAt,
    updatedAt: now,
    sourceArtifactPath: sourceArtifactPath ?? existingRecord?.sourceArtifactPath ?? null,
    revisionOfArtifactPath: revisionOfArtifactPath ?? existingRecord?.revisionOfArtifactPath ?? null,
    sourceHash: normalizeToken(input.sourceHash) ?? existingRecord?.sourceHash ?? null,
    contentHash: normalizeToken(input.contentHash ?? input.content_hash) ?? existingRecord?.contentHash ?? null,
    capabilities: sanitizeCapabilities(input.capabilities) ?? existingRecord?.capabilities ?? null,
    review: mergeReviewMetadata(existingRecord?.review, input.review),
    safeSummary: safeSummary(input.safeSummary ?? input.safe_summary) ?? existingRecord?.safeSummary ?? null,
    rawContentExcluded: true,
  }

  const artifacts = existingIndex >= 0
    ? index.artifacts.map((item, itemIndex) => itemIndex === existingIndex ? record : item)
    : [...index.artifacts, record]
  const nextIndex: ArtifactSessionIndex = {
    ...index,
    userId: normalizedContext.userId,
    threadId: normalizedContext.threadId,
    sessionId: normalizedContext.sessionId,
    artifacts: artifacts.map((item) => ensureVersionRelationship(item, record, parentRecord)),
    activeArtifactId: index.activeArtifactId === existingRecord?.artifactId ? record.artifactId : index.activeArtifactId,
    recentlyOpenedArtifactIds: pruneRecentIds(
      index.recentlyOpenedArtifactIds.map((artifactId) => (
        artifactId === existingRecord?.artifactId ? record.artifactId : artifactId
      )),
      artifacts,
    ),
  }
  saveArtifactSessionIndex(normalizedContext, nextIndex)
  return {
    index: nextIndex,
    record,
    deduped: existingIndex >= 0,
    result: existingIndex >= 0 ? "updated" : "registered",
  }
}

export function openArtifactInSessionIndex(
  context: ArtifactSessionIndexContext,
  artifactIdOrPath: string | null | undefined,
  options?: { openedAt?: string | null },
): OpenArtifactResult {
  const normalizedContext = normalizeContext(context)
  const index = loadArtifactSessionIndex(normalizedContext)
  if (!normalizedContext.threadId) {
    return { index, record: null, result: "invalid_context" }
  }

  const openedAt = normalizeIsoDate(options?.openedAt) ?? new Date().toISOString()
  const normalizedPath = normalizeBuilderArtifactPath(artifactIdOrPath)
  const record = index.artifacts.find((item) => (
    item.artifactId === artifactIdOrPath
      || item.stableArtifactIdentity === artifactIdOrPath
      || normalizeBuilderArtifactPath(item.localPath) === normalizedPath
  )) ?? null

  if (!record) {
    return { index, record: null, result: "not_found" }
  }

  const nextRecord: ArtifactRecord = {
    ...record,
    updatedAt: openedAt,
    review: {
      ...(record.review ?? {}),
      openedCount: Math.max(0, record.review?.openedCount ?? 0) + 1,
      lastOpenedAt: openedAt,
    },
  }
  const artifacts = index.artifacts.map((item) => item.artifactId === record.artifactId ? nextRecord : item)
  const nextIndex: ArtifactSessionIndex = {
    ...index,
    artifacts,
    activeArtifactId: record.artifactId,
    recentlyOpenedArtifactIds: [
      record.artifactId,
      ...index.recentlyOpenedArtifactIds.filter((artifactId) => artifactId !== record.artifactId),
    ].slice(0, RECENTLY_OPENED_LIMIT),
  }
  saveArtifactSessionIndex(normalizedContext, nextIndex)
  return { index: nextIndex, record: nextRecord, result: "opened" }
}

export function listSessionArtifacts(index: ArtifactSessionIndex): ArtifactRecord[] {
  const recentOrder = new Map(index.recentlyOpenedArtifactIds.map((artifactId, order) => [artifactId, order]))
  const siblingFiles = index.artifacts.map((record) => ({ path: record.localPath }))
  // Render sources (report.pdf.md) and deck previews (deck.preview.pdf) must
  // never outrank the deliverable they belong to, so they sort after
  // deliverables unless the user explicitly opened them recently.
  const roleRank = (record: ArtifactRecord) => (
    classifyBuilderArtifactFileRole({ path: record.localPath }, siblingFiles) === "deliverable" ? 0 : 1
  )
  return [...index.artifacts].sort((left, right) => {
    const leftRecent = recentOrder.get(left.artifactId)
    const rightRecent = recentOrder.get(right.artifactId)
    if (leftRecent !== undefined || rightRecent !== undefined) {
      return (leftRecent ?? Number.MAX_SAFE_INTEGER) - (rightRecent ?? Number.MAX_SAFE_INTEGER)
    }
    const roleDelta = roleRank(left) - roleRank(right)
    if (roleDelta !== 0) {
      return roleDelta
    }
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  })
}

export function clearArtifactSessionIndexForTests(context?: ArtifactSessionIndexContext): void {
  const storage = getLocalStorage()
  if (!storage) {
    return
  }
  try {
    if (context) {
      storage.removeItem(storageKey(normalizeContext(context)))
      return
    }
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith(STORAGE_PREFIX)))
    for (const key of keys) {
      storage.removeItem(key)
    }
  } catch {
    // Test cleanup is best-effort.
  }
}

export function getArtifactSessionIndexStorageKeyForTests(context: ArtifactSessionIndexContext): string {
  return storageKey(normalizeContext(context))
}

function createEmptyArtifactSessionIndex(context: Required<Pick<ArtifactSessionIndexContext, "threadId">> & ArtifactSessionIndexContext): ArtifactSessionIndex {
  return {
    userId: normalizeToken(context.userId),
    threadId: normalizeToken(context.threadId) ?? "",
    sessionId: normalizeToken(context.sessionId),
    artifacts: [],
    activeArtifactId: null,
    recentlyOpenedArtifactIds: [],
  }
}

function indexFromStorage(
  value: unknown,
  context: ArtifactSessionIndexContext,
): ArtifactSessionIndex | null {
  if (!isRecord(value) || value.version !== ARTIFACT_SESSION_INDEX_STORAGE_VERSION || !isRecord(value.index)) {
    return null
  }
  const stored = value.index
  const threadId = normalizeToken(stored.threadId)
  if (!threadId || threadId !== normalizeToken(context.threadId)) {
    return null
  }
  const artifacts = Array.isArray(stored.artifacts)
    ? stored.artifacts
      .map((item) => artifactRecordFromStorage(item, threadId))
      .filter((item): item is ArtifactRecord => item !== null)
    : []
  return {
    userId: normalizeToken(stored.userId) ?? normalizeToken(context.userId),
    threadId,
    sessionId: normalizeToken(stored.sessionId) ?? normalizeToken(context.sessionId),
    artifacts,
    activeArtifactId: normalizeToken(stored.activeArtifactId),
    recentlyOpenedArtifactIds: Array.isArray(stored.recentlyOpenedArtifactIds)
      ? stored.recentlyOpenedArtifactIds
        .map(normalizeToken)
        .filter((item): item is string => Boolean(item))
        .filter((artifactId) => artifacts.some((record) => record.artifactId === artifactId))
        .slice(0, RECENTLY_OPENED_LIMIT)
      : [],
  }
}

function artifactRecordFromStorage(value: unknown, expectedThreadId: string): ArtifactRecord | null {
  if (!isRecord(value)) {
    return null
  }
  const artifactId = normalizeToken(value.artifactId)
  const stableArtifactIdentity = normalizeToken(value.stableArtifactIdentity)
  const logicalArtifactId = normalizeToken(value.logicalArtifactId)
  const versionId = normalizeToken(value.versionId)
  const threadId = normalizeToken(value.threadId)
  const rendererKind = normalizeRendererKind(value.rendererKind)
  const localPath = normalizeBuilderArtifactPath(typeof value.localPath === "string" ? value.localPath : null)
  const title = normalizeToken(value.title)
  const artifactType = normalizeToken(value.artifactType)
  const createdAt = normalizeIsoDate(value.createdAt)
  const updatedAt = normalizeIsoDate(value.updatedAt)

  if (!artifactId || !stableArtifactIdentity || !logicalArtifactId || !versionId || threadId !== expectedThreadId || !rendererKind || !localPath || !title || !artifactType || !createdAt || !updatedAt) {
    return null
  }

  return {
    artifactId,
    stableArtifactIdentity,
    logicalArtifactId,
    versionId,
    parentVersionId: normalizeToken(value.parentVersionId),
    userId: normalizeToken(value.userId),
    threadId,
    sessionId: normalizeToken(value.sessionId),
    parentThreadId: normalizeToken(value.parentThreadId),
    taskId: normalizeToken(value.taskId),
    runId: normalizeToken(value.runId),
    title,
    filename: normalizeToken(value.filename),
    artifactType,
    rendererKind,
    mimeType: normalizeToken(value.mimeType),
    localPath,
    storageProvider: normalizeStorageProvider(value.storageProvider) ?? "local",
    storageBucket: normalizeToken(value.storageBucket),
    storageObjectPath: normalizeToken(value.storageObjectPath),
    contentUrl: normalizeHref(value.contentUrl),
    downloadUrl: normalizeHref(value.downloadUrl),
    signedUrl: normalizeToken(value.signedUrl),
    signedUrlExpiresAt: normalizeIsoDate(value.signedUrlExpiresAt),
    createdAt,
    updatedAt,
    sourceArtifactPath: normalizeBuilderArtifactPath(typeof value.sourceArtifactPath === "string" ? value.sourceArtifactPath : null),
    revisionOfArtifactPath: normalizeBuilderArtifactPath(typeof value.revisionOfArtifactPath === "string" ? value.revisionOfArtifactPath : null),
    sourceHash: normalizeToken(value.sourceHash),
    contentHash: normalizeToken(value.contentHash),
    capabilities: sanitizeCapabilities(value.capabilities),
    review: sanitizeReviewMetadata(value.review),
    safeSummary: safeSummary(value.safeSummary),
    rawContentExcluded: true,
  }
}

function findParentVersionRecord(
  index: ArtifactSessionIndex,
  input: {
    localPath: string
    rendererKind: ArtifactRendererKind
    sourceArtifactPath: string | null
    revisionOfArtifactPath: string | null
  },
): ArtifactRecord | null {
  const sourcePath = input.revisionOfArtifactPath ?? input.sourceArtifactPath
  if (!sourcePath || sourcePath === input.localPath) {
    return null
  }
  return index.artifacts.find((record) => (
    normalizeBuilderArtifactPath(record.localPath) === sourcePath
      || normalizeBuilderArtifactPath(record.revisionOfArtifactPath) === sourcePath
      || normalizeBuilderArtifactPath(record.sourceArtifactPath) === sourcePath
  )) ?? null
}

function ensureVersionRelationship(
  item: ArtifactRecord,
  record: ArtifactRecord,
  parentRecord: ArtifactRecord | null,
): ArtifactRecord {
  if (parentRecord?.artifactId !== item.artifactId) {
    return item
  }
  if (item.logicalArtifactId === record.logicalArtifactId) {
    return item
  }
  return {
    ...item,
    logicalArtifactId: record.logicalArtifactId,
    updatedAt: record.updatedAt,
  }
}

function pruneRecentIds(recentIds: string[], artifacts: ArtifactRecord[]): string[] {
  return recentIds
    .filter((artifactId) => artifacts.some((record) => record.artifactId === artifactId))
    .slice(0, RECENTLY_OPENED_LIMIT)
}

function normalizeContext(context: ArtifactSessionIndexContext): Required<Pick<ArtifactSessionIndexContext, "threadId">> & ArtifactSessionIndexContext {
  return {
    userId: normalizeToken(context.userId),
    threadId: normalizeToken(context.threadId) ?? "",
    sessionId: normalizeToken(context.sessionId),
    parentThreadId: normalizeToken(context.parentThreadId),
  }
}

function storageKey(context: ArtifactSessionIndexContext): string {
  const key = [
    `user:${normalizeToken(context.userId) ?? "unknown"}`,
    `thread:${normalizeToken(context.threadId) ?? "unknown"}`,
    `session:${normalizeToken(context.sessionId) ?? "unknown"}`,
  ].join("|")
  return `${STORAGE_PREFIX}${stableHash(key)}`
}

function stableArtifactId(threadId: string, localPath: string, rendererKind: ArtifactRendererKind): string {
  return `artifact:${stableHash(`thread:${threadId}|path:${localPath}|renderer:${rendererKind}`)}`
}

function chooseArtifactId({
  current,
  requested,
  fallback,
}: {
  current?: string | null
  requested?: string | null
  fallback: string
}): string {
  if (!current) {
    return requested ?? fallback
  }
  if (requested && current.startsWith("artifact:") && !requested.startsWith("artifact:")) {
    return requested
  }
  return current
}

function stableVersionId(stableArtifactIdentity: string): string {
  return `${stableArtifactIdentity}::v1`
}

function chooseTitle(input: {
  currentTitle?: string | null
  nextTitle?: string | null
  path: string
  source?: ArtifactRegisterSource
}): string {
  const nextTitle = normalizeToken(input.nextTitle)
  const currentTitle = normalizeToken(input.currentTitle)
  if (!currentTitle) {
    return nextTitle ?? fallbackTitle(input.path)
  }
  if (!nextTitle) {
    return currentTitle
  }
  const fallback = fallbackTitle(input.path)
  if (currentTitle !== fallback && nextTitle === fallback) {
    return currentTitle
  }
  if (input.source && input.source !== "file_library") {
    return nextTitle
  }
  return currentTitle === fallback && nextTitle !== fallback ? nextTitle : currentTitle
}

function fallbackTitle(path: string): string {
  return path.split("/").filter(Boolean).pop() || "Artifact"
}

function artifactTypeFromPath(path: string, rendererKind: ArtifactRendererKind): string {
  if (rendererKind === "html") return "webpage"
  if (rendererKind === "pdf") return "pdf"
  if (rendererKind === "image") return "visual_report"
  if (rendererKind === "markdown") return "document"
  const extension = path.split(".").pop()?.toLowerCase() ?? ""
  if (["ppt", "pptx"].includes(extension)) return "presentation"
  if (["csv", "json", "xls", "xlsx"].includes(extension)) return "data_analysis"
  return "document"
}

function mergeReviewMetadata(
  current: ArtifactRecordReviewMetadata | null | undefined,
  next: ArtifactRecordReviewMetadata | null | undefined,
): ArtifactRecordReviewMetadata | null {
  const sanitizedNext = sanitizeReviewMetadata(next)
  const sanitizedCurrent = sanitizeReviewMetadata(current)
  if (!sanitizedCurrent && !sanitizedNext) {
    return null
  }
  return {
    ...(sanitizedCurrent ?? {}),
    ...(sanitizedNext ?? {}),
  }
}

function sanitizeReviewMetadata(value: unknown): ArtifactRecordReviewMetadata | null {
  if (!isRecord(value)) {
    return null
  }
  const openedCount = typeof value.openedCount === "number" && Number.isFinite(value.openedCount)
    ? Math.max(0, Math.floor(value.openedCount))
    : undefined
  const annotationCount = typeof value.annotationCount === "number" && Number.isFinite(value.annotationCount)
    ? Math.max(0, Math.floor(value.annotationCount))
    : undefined
  const lastOpenedAt = normalizeIsoDate(value.lastOpenedAt)
  const missing = typeof value.missing === "boolean" ? value.missing : undefined
  return {
    ...(openedCount !== undefined ? { openedCount } : {}),
    ...(lastOpenedAt ? { lastOpenedAt } : {}),
    ...(missing !== undefined ? { missing } : {}),
    ...(annotationCount !== undefined ? { annotationCount } : {}),
  }
}

function sanitizeCapabilities(value: unknown): ArtifactRecordCapabilitiesSnapshot | null {
  if (!isRecord(value)) {
    return null
  }
  const sanitized: ArtifactRecordCapabilitiesSnapshot = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/u.test(key)) {
      continue
    }
    if (typeof entry === "string") {
      sanitized[key] = entry.slice(0, 120)
    } else if (typeof entry === "boolean") {
      sanitized[key] = entry
    } else if (entry === null) {
      sanitized[key] = null
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      sanitized[key] = entry
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null
}

function normalizeRendererKind(value: unknown): ArtifactRendererKind | null {
  return value === "pdf"
    || value === "markdown"
    || value === "html"
    || value === "image"
    || value === "metadata"
    || value === "download_only"
    || value === "unsupported"
    ? value
    : null
}

function normalizeStorageProvider(value: unknown): ArtifactStorageProvider | null {
  return value === "local" || value === "supabase" || value === "hybrid" ? value : null
}

function chooseStorageProvider({
  requested,
  current,
  storageBucket,
  storageObjectPath,
}: {
  requested: ArtifactStorageProvider | null
  current?: ArtifactStorageProvider | null
  storageBucket?: string | null
  storageObjectPath?: string | null
}): ArtifactStorageProvider {
  if (requested) {
    return requested
  }
  if (current && (current !== "local" || storageObjectPath || storageBucket)) {
    return current
  }
  return storageObjectPath && storageBucket ? "supabase" : "local"
}

function normalizeToken(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function normalizeHref(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null
  }
  const href = value.trim()
  if (/^(?:javascript|data|vbscript):/iu.test(href)) {
    return null
  }
  return href.slice(0, 2048)
}

function safeSummary(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.replace(/\s+/gu, " ").trim().slice(0, 180)
    : null
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
