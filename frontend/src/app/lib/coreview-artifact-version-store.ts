import type { ArtifactRendererKind } from "./artifact-renderers"
import { normalizeBuilderArtifactPath } from "./builder-artifacts"

export type CoreviewArtifactVersionSource = "builder_update" | "manual_select" | "restore_original"

export interface CoreviewArtifactVersionEntry {
  versionId: string
  parentVersionId?: string | null
  logicalArtifactId: string
  workspaceArtifactId?: string | null
  artifactStableIdentity: string | null
  artifactPath: string
  artifactTitle: string | null
  rendererKind: ArtifactRendererKind
  source: CoreviewArtifactVersionSource
  createdAt: string
  builderTaskId?: string | null
  requestedChangeSummary?: string | null
}

export interface CoreviewArtifactVersionState {
  logicalArtifactId: string
  originalVersionId: string
  currentVersionId: string
  versions: CoreviewArtifactVersionEntry[]
}

export type CoreviewArtifactVersionTelemetry = {
  coreviewArtifactVersioningEnabled: boolean
  coreviewArtifactLogicalId: string | null
  coreviewArtifactOriginalVersionIdPresent: boolean
  coreviewArtifactCurrentVersionIdPresent: boolean
  coreviewArtifactVersionCount: number
  coreviewHtmlUpdatePreviousPathHash: string | null
  coreviewHtmlUpdateCurrentPathHash: string | null
  coreviewHtmlUpdateRestoreAvailable: boolean
}

type VersionArtifactInput = {
  artifactStableIdentity?: string | null
  artifactPath?: string | null
  artifactTitle?: string | null
  rendererKind: ArtifactRendererKind
}

export type CoreviewCreateVersionFromBuilderOutputInput = {
  workspaceKey: string | null | undefined
  logicalArtifactId?: string | null
  workspaceArtifactId?: string | null
  original: VersionArtifactInput
  output: VersionArtifactInput
  builderTaskId?: string | null
  requestedChangeSummary?: string | null
  createdAt?: string | null
}

export type CoreviewSelectArtifactVersionInput = {
  workspaceKey: string | null | undefined
  logicalArtifactId: string | null | undefined
  versionId: string | null | undefined
}

export type CoreviewRestoreOriginalVersionInput = {
  workspaceKey: string | null | undefined
  logicalArtifactId: string | null | undefined
}

const STORAGE_PREFIX = "sophia:coreview-artifact-versions:v1:"
const states = new Map<string, CoreviewArtifactVersionState>()
const restoredKeys = new Set<string>()

export function createVersionFromBuilderOutput(
  input: CoreviewCreateVersionFromBuilderOutputInput,
): CoreviewArtifactVersionState | null {
  const workspaceKey = normalizeToken(input.workspaceKey)
  const originalPath = normalizeBuilderArtifactPath(input.original.artifactPath)
  const outputPath = normalizeBuilderArtifactPath(input.output.artifactPath)
  const logicalArtifactId = normalizeLogicalArtifactId(
    input.logicalArtifactId
      ?? input.workspaceArtifactId
      ?? input.original.artifactStableIdentity
      ?? originalPath,
  )
  if (!workspaceKey || !logicalArtifactId || !originalPath || !outputPath) {
    return null
  }

  const key = stateKey(workspaceKey, logicalArtifactId)
  const existing = restoreState(workspaceKey, logicalArtifactId)
  const createdAt = normalizeIsoDate(input.createdAt) ?? new Date().toISOString()
  const originalVersion = existing?.versions.find((version) => version.versionId === existing.originalVersionId)
    ?? buildOriginalVersion({
      logicalArtifactId,
      workspaceArtifactId: input.workspaceArtifactId,
      artifact: {
        ...input.original,
        artifactPath: originalPath,
      },
      createdAt,
    })
  const nextVersionNumber = existing
    ? Math.max(existing.versions.length + 1, 2)
    : 2
  const versionId = versionIdFor(logicalArtifactId, nextVersionNumber)
  const versions = [
    originalVersion,
    ...(existing?.versions.filter((version) => version.versionId !== originalVersion.versionId) ?? []),
  ]
  const existingOutput = versions.find((version) => (
    normalizeBuilderArtifactPath(version.artifactPath) === outputPath
      && version.source === "builder_update"
  ))
  const outputVersion: CoreviewArtifactVersionEntry = existingOutput
    ? {
        ...existingOutput,
        artifactTitle: normalizeToken(input.output.artifactTitle) ?? existingOutput.artifactTitle,
        artifactStableIdentity: normalizeToken(input.output.artifactStableIdentity) ?? existingOutput.artifactStableIdentity,
        builderTaskId: normalizeToken(input.builderTaskId) ?? existingOutput.builderTaskId ?? null,
        requestedChangeSummary: safeSummary(input.requestedChangeSummary) ?? existingOutput.requestedChangeSummary ?? null,
      }
    : {
        versionId,
        parentVersionId: originalVersion.versionId,
        logicalArtifactId,
        workspaceArtifactId: normalizeToken(input.workspaceArtifactId),
        artifactStableIdentity: normalizeToken(input.output.artifactStableIdentity),
        artifactPath: outputPath,
        artifactTitle: normalizeToken(input.output.artifactTitle),
        rendererKind: input.output.rendererKind,
        source: "builder_update",
        createdAt,
        builderTaskId: normalizeToken(input.builderTaskId),
        requestedChangeSummary: safeSummary(input.requestedChangeSummary),
      }
  const nextVersions = existingOutput
    ? versions.map((version) => version.versionId === existingOutput.versionId ? outputVersion : version)
    : [...versions, outputVersion]
  const state: CoreviewArtifactVersionState = {
    logicalArtifactId,
    originalVersionId: originalVersion.versionId,
    currentVersionId: outputVersion.versionId,
    versions: nextVersions,
  }
  states.set(key, state)
  persistState(workspaceKey, logicalArtifactId, state)
  return state
}

export function selectArtifactVersion(
  input: CoreviewSelectArtifactVersionInput,
): CoreviewArtifactVersionState | null {
  const workspaceKey = normalizeToken(input.workspaceKey)
  const logicalArtifactId = normalizeLogicalArtifactId(input.logicalArtifactId)
  const versionId = normalizeToken(input.versionId)
  if (!workspaceKey || !logicalArtifactId || !versionId) {
    return null
  }
  const state = restoreState(workspaceKey, logicalArtifactId)
  if (state?.versions.some((version) => version.versionId === versionId) !== true) {
    return null
  }
  const next = {
    ...state,
    currentVersionId: versionId,
  }
  states.set(stateKey(workspaceKey, logicalArtifactId), next)
  persistState(workspaceKey, logicalArtifactId, next)
  return next
}

export function restoreOriginalVersion(
  input: CoreviewRestoreOriginalVersionInput,
): CoreviewArtifactVersionState | null {
  const workspaceKey = normalizeToken(input.workspaceKey)
  const logicalArtifactId = normalizeLogicalArtifactId(input.logicalArtifactId)
  if (!workspaceKey || !logicalArtifactId) {
    return null
  }
  const state = restoreState(workspaceKey, logicalArtifactId)
  if (!state) {
    return null
  }
  return selectArtifactVersion({
    workspaceKey,
    logicalArtifactId,
    versionId: state.originalVersionId,
  })
}

export function getCurrentVersion(
  state: CoreviewArtifactVersionState | null | undefined,
): CoreviewArtifactVersionEntry | null {
  if (!state) {
    return null
  }
  return state.versions.find((version) => version.versionId === state.currentVersionId) ?? null
}

export function getOriginalVersion(
  state: CoreviewArtifactVersionState | null | undefined,
): CoreviewArtifactVersionEntry | null {
  if (!state) {
    return null
  }
  return state.versions.find((version) => version.versionId === state.originalVersionId) ?? null
}

export function getArtifactVersionState(
  workspaceKey: string | null | undefined,
  logicalArtifactId: string | null | undefined,
): CoreviewArtifactVersionState | null {
  const normalizedWorkspaceKey = normalizeToken(workspaceKey)
  const normalizedLogicalArtifactId = normalizeLogicalArtifactId(logicalArtifactId)
  if (!normalizedWorkspaceKey || !normalizedLogicalArtifactId) {
    return null
  }
  return restoreState(normalizedWorkspaceKey, normalizedLogicalArtifactId)
}

export function getVersionTelemetry(
  state: CoreviewArtifactVersionState | null | undefined,
): CoreviewArtifactVersionTelemetry {
  const original = getOriginalVersion(state)
  const current = getCurrentVersion(state)
  return {
    coreviewArtifactVersioningEnabled: Boolean(state),
    coreviewArtifactLogicalId: state?.logicalArtifactId ?? null,
    coreviewArtifactOriginalVersionIdPresent: Boolean(original?.versionId),
    coreviewArtifactCurrentVersionIdPresent: Boolean(current?.versionId),
    coreviewArtifactVersionCount: state?.versions.length ?? 0,
    coreviewHtmlUpdatePreviousPathHash: hashCoreviewArtifactVersionPath(original?.artifactPath),
    coreviewHtmlUpdateCurrentPathHash: hashCoreviewArtifactVersionPath(current?.artifactPath),
    coreviewHtmlUpdateRestoreAvailable: Boolean(
      state
        && original
        && current
        && state.currentVersionId !== state.originalVersionId,
    ),
  }
}

export function hashCoreviewArtifactVersionPath(path: string | null | undefined): string | null {
  const normalized = normalizeBuilderArtifactPath(path)
  return normalized ? stableHash(normalized) : null
}

export function clearCoreviewArtifactVersionStoreForTests(): void {
  states.clear()
  restoredKeys.clear()
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
    // Test cleanup is best-effort when storage is unavailable.
  }
}

function buildOriginalVersion({
  logicalArtifactId,
  workspaceArtifactId,
  artifact,
  createdAt,
}: {
  logicalArtifactId: string
  workspaceArtifactId?: string | null
  artifact: VersionArtifactInput & { artifactPath: string }
  createdAt: string
}): CoreviewArtifactVersionEntry {
  return {
    versionId: versionIdFor(logicalArtifactId, 1),
    parentVersionId: null,
    logicalArtifactId,
    workspaceArtifactId: normalizeToken(workspaceArtifactId),
    artifactStableIdentity: normalizeToken(artifact.artifactStableIdentity),
    artifactPath: artifact.artifactPath,
    artifactTitle: normalizeToken(artifact.artifactTitle),
    rendererKind: artifact.rendererKind,
    source: "manual_select",
    createdAt,
    builderTaskId: null,
    requestedChangeSummary: null,
  }
}

function restoreState(workspaceKey: string, logicalArtifactId: string): CoreviewArtifactVersionState | null {
  const key = stateKey(workspaceKey, logicalArtifactId)
  if (states.has(key)) {
    return states.get(key) ?? null
  }
  if (restoredKeys.has(key)) {
    return null
  }
  restoredKeys.add(key)
  const storage = getLocalStorage()
  if (!storage) {
    return null
  }
  try {
    const raw = storage.getItem(storageKey(workspaceKey, logicalArtifactId))
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as unknown
    const restored = stateFromStorage(parsed, logicalArtifactId)
    if (!restored) {
      storage.removeItem(storageKey(workspaceKey, logicalArtifactId))
      return null
    }
    states.set(key, restored)
    return restored
  } catch {
    try {
      storage.removeItem(storageKey(workspaceKey, logicalArtifactId))
    } catch {
      // Ignore storage cleanup failures.
    }
    return null
  }
}

function persistState(
  workspaceKey: string,
  logicalArtifactId: string,
  state: CoreviewArtifactVersionState,
): void {
  const storage = getLocalStorage()
  if (!storage) {
    return
  }
  try {
    storage.setItem(storageKey(workspaceKey, logicalArtifactId), JSON.stringify({
      version: 1,
      logicalArtifactId,
      state,
      updatedAt: new Date().toISOString(),
    }))
  } catch {
    // Local version persistence is best-effort.
  }
}

function stateFromStorage(
  value: unknown,
  expectedLogicalArtifactId: string,
): CoreviewArtifactVersionState | null {
  if (!isRecord(value) || value.version !== 1 || value.logicalArtifactId !== expectedLogicalArtifactId) {
    return null
  }
  if (!isRecord(value.state)) {
    return null
  }
  const state = value.state
  const logicalArtifactId = normalizeLogicalArtifactId(state.logicalArtifactId)
  const originalVersionId = normalizeToken(state.originalVersionId)
  const currentVersionId = normalizeToken(state.currentVersionId)
  if (!logicalArtifactId || logicalArtifactId !== expectedLogicalArtifactId || !originalVersionId || !currentVersionId || !Array.isArray(state.versions)) {
    return null
  }
  const versions = state.versions
    .map((entry) => versionFromStorage(entry, logicalArtifactId))
    .filter((entry): entry is CoreviewArtifactVersionEntry => entry !== null)
  if (versions.length === 0 || !versions.some((entry) => entry.versionId === originalVersionId) || !versions.some((entry) => entry.versionId === currentVersionId)) {
    return null
  }
  return {
    logicalArtifactId,
    originalVersionId,
    currentVersionId,
    versions,
  }
}

function versionFromStorage(
  value: unknown,
  expectedLogicalArtifactId: string,
): CoreviewArtifactVersionEntry | null {
  if (!isRecord(value)) {
    return null
  }
  const versionId = normalizeToken(value.versionId)
  const logicalArtifactId = normalizeLogicalArtifactId(value.logicalArtifactId)
  const artifactPath = normalizeBuilderArtifactPath(
    typeof value.artifactPath === "string" ? value.artifactPath : null,
  )
  const rendererKind = normalizeRendererKind(value.rendererKind)
  const source = normalizeSource(value.source)
  const createdAt = normalizeIsoDate(value.createdAt)
  if (!versionId || logicalArtifactId !== expectedLogicalArtifactId || !artifactPath || !rendererKind || !source || !createdAt) {
    return null
  }
  return {
    versionId,
    parentVersionId: normalizeToken(value.parentVersionId),
    logicalArtifactId,
    workspaceArtifactId: normalizeToken(value.workspaceArtifactId),
    artifactStableIdentity: normalizeToken(value.artifactStableIdentity),
    artifactPath,
    artifactTitle: normalizeToken(value.artifactTitle),
    rendererKind,
    source,
    createdAt,
    builderTaskId: normalizeToken(value.builderTaskId),
    requestedChangeSummary: safeSummary(value.requestedChangeSummary),
  }
}

function versionIdFor(logicalArtifactId: string, versionNumber: number): string {
  return `${logicalArtifactId}::v${versionNumber}`
}

function stateKey(workspaceKey: string, logicalArtifactId: string): string {
  return `${workspaceKey}::${logicalArtifactId}`
}

function storageKey(workspaceKey: string, logicalArtifactId: string): string {
  return `${STORAGE_PREFIX}${stableHash(stateKey(workspaceKey, logicalArtifactId))}`
}

function normalizeLogicalArtifactId(value: unknown): string | null {
  return normalizeToken(value)
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

function normalizeSource(value: unknown): CoreviewArtifactVersionSource | null {
  return value === "builder_update" || value === "manual_select" || value === "restore_original"
    ? value
    : null
}

function safeSummary(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.replace(/\s+/gu, " ").trim().slice(0, 160)
    : null
}

function normalizeToken(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
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
