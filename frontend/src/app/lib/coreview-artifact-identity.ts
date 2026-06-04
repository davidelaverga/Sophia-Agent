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

function normalizeIdentityToken(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null
  }
  const normalized = value.trim()
  return normalized || null
}
