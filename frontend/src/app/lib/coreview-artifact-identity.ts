import type { ArtifactRendererKind } from "./artifact-renderers"
import { normalizeBuilderArtifactPath } from "./builder-artifacts"

export interface CoreviewArtifactIdentityInput {
  userId?: string | null
  threadId?: string | null
  parentThreadId?: string | null
  builderTaskThreadId?: string | null
  artifactPath?: string | null
  rendererKind?: ArtifactRendererKind | string | null
}

export interface CoreviewWorkspaceKeyInput {
  userId?: string | null
  threadId?: string | null
  voiceAgentSessionId?: string | null
}

export interface CoreviewWorkspaceKeyIdentity {
  userId: string | null
  threadId: string | null
  key: string
}

export interface CoreviewArtifactIdentity {
  userId: string | null
  threadId: string | null
  parentThreadId: string | null
  builderTaskThreadId: string | null
  artifactPath: string | null
  rendererKind: string | null
  key: string
}

export function normalizeCoreviewArtifactPath(path: string | null | undefined): string | null {
  const normalized = normalizeBuilderArtifactPath(path)
  if (!normalized) {
    return null
  }

  const segments = normalized.split("/").filter(Boolean)
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    return null
  }

  return segments.join("/")
}

export function buildCoreviewWorkspaceKey(
  input: CoreviewWorkspaceKeyInput,
): CoreviewWorkspaceKeyIdentity {
  const userId = normalizeIdentityToken(input.userId)
  const threadId = normalizeIdentityToken(input.threadId)

  return {
    userId,
    threadId,
    key: `user:${userId ?? "unknown"}|thread:${threadId ?? "unknown"}`,
  }
}

export function buildCoreviewArtifactStableIdentity(
  input: CoreviewArtifactIdentityInput,
): CoreviewArtifactIdentity {
  const userId = normalizeIdentityToken(input.userId)
  const threadId = normalizeIdentityToken(input.threadId)
  const parentThreadId = normalizeIdentityToken(input.parentThreadId)
  const builderTaskThreadId = normalizeIdentityToken(input.builderTaskThreadId)
  const artifactPath = normalizeCoreviewArtifactPath(input.artifactPath)
  const rendererKind = normalizeIdentityToken(input.rendererKind)
  const ownerThreadId = parentThreadId ?? threadId

  return {
    userId,
    threadId,
    parentThreadId,
    builderTaskThreadId,
    artifactPath,
    rendererKind,
    key: [
      `user:${userId ?? "unknown"}`,
      `thread:${ownerThreadId ?? "unknown"}`,
      builderTaskThreadId ? `builder:${builderTaskThreadId}` : null,
      `path:${artifactPath ?? "unknown"}`,
      `renderer:${rendererKind ?? "unknown"}`,
    ].filter((part): part is string => Boolean(part)).join("|"),
  }
}

export function normalizeCoreviewArtifactKey(value: string | null | undefined): string | null {
  const normalized = normalizeIdentityToken(value)
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
    const originalPath = part.slice("path:".length)
    const canonicalPath = normalizeCoreviewArtifactPath(originalPath)
    if (!canonicalPath || canonicalPath === originalPath) {
      return part
    }
    changed = true
    return `path:${canonicalPath}`
  })

  return changed ? canonicalParts.join("|") : normalized
}

function normalizeIdentityToken(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null
  }
  const normalized = value.trim()
  return normalized || null
}
