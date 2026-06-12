import {
  artifactRegistryRecordToSessionMetadata,
  normalizeRegistryArtifactPath,
  normalizeRendererKind,
  type ArtifactOpenResponse,
  type ArtifactRegistryRecord,
} from './artifact-registry';
import type { ArtifactRendererKind } from './artifact-renderers';
import type { ArtifactSessionIndexContext, RegisterArtifactInput } from './session-artifact-index';

const HANDOFF_STORAGE_KEY = 'sophia:artifact-library-open:v1';
const HANDOFF_VERSION = 1;
const HANDOFF_TTL_MS = 5 * 60 * 1000;

export type ArtifactLibraryOpenHandoff = {
  version: typeof HANDOFF_VERSION;
  createdAt: string;
  userId?: string | null;
  threadId: string;
  sessionId?: string | null;
  artifactId: string;
  artifactPath: string;
  rendererKind: ArtifactRendererKind;
  metadata: Partial<Omit<RegisterArtifactInput, 'context' | 'localPath'>>;
};

export function saveArtifactLibraryOpenHandoff(response: ArtifactOpenResponse): boolean {
  const handoff = buildArtifactLibraryOpenHandoff(response);
  if (!handoff) {
    return false;
  }
  const storage = getSessionStorage();
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(handoff));
    return true;
  } catch {
    return false;
  }
}

export function buildArtifactLibraryOpenHandoff(
  response: ArtifactOpenResponse,
): ArtifactLibraryOpenHandoff | null {
  const record = response.artifact;
  const target = response.canvas_target;
  const artifactPath = normalizeRegistryArtifactPath(target.artifact_path || record.local_path);
  if (!artifactPath || !target.thread_id || !record.artifact_id) {
    return null;
  }

  return {
    version: HANDOFF_VERSION,
    createdAt: new Date().toISOString(),
    userId: record.user_id,
    threadId: target.thread_id,
    sessionId: target.session_id ?? record.session_id ?? null,
    artifactId: record.artifact_id,
    artifactPath,
    rendererKind: normalizeRendererKind(target.renderer_kind),
    metadata: artifactRegistryRecordToSessionMetadata({
      ...record,
      renderer_kind: target.renderer_kind,
      mime_type: target.mime_type ?? record.mime_type ?? null,
    } satisfies ArtifactRegistryRecord),
  };
}

export function consumeArtifactLibraryOpenHandoff(
  context: ArtifactSessionIndexContext,
): ArtifactLibraryOpenHandoff | null {
  const storage = getSessionStorage();
  if (!storage || !context.threadId) {
    return null;
  }

  const handoff = readArtifactLibraryOpenHandoff(storage.getItem(HANDOFF_STORAGE_KEY));
  if (!handoff) {
    try {
      storage.removeItem(HANDOFF_STORAGE_KEY);
    } catch {
      // Storage cleanup is best-effort.
    }
    return null;
  }

  if (Date.now() - Date.parse(handoff.createdAt) > HANDOFF_TTL_MS) {
    storage.removeItem(HANDOFF_STORAGE_KEY);
    return null;
  }

  if (handoff.threadId !== context.threadId) {
    return null;
  }
  if (handoff.userId && context.userId && handoff.userId !== context.userId) {
    return null;
  }

  storage.removeItem(HANDOFF_STORAGE_KEY);
  return handoff;
}

function readArtifactLibraryOpenHandoff(raw: string | null): ArtifactLibraryOpenHandoff | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ArtifactLibraryOpenHandoff>;
    const artifactPath = normalizeRegistryArtifactPath(parsed.artifactPath);
    if (
      parsed.version !== HANDOFF_VERSION
      || !parsed.threadId
      || !parsed.artifactId
      || !artifactPath
      || !parsed.createdAt
      || Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      return null;
    }
    return {
      version: HANDOFF_VERSION,
      createdAt: parsed.createdAt,
      userId: parsed.userId ?? null,
      threadId: parsed.threadId,
      sessionId: parsed.sessionId ?? null,
      artifactId: parsed.artifactId,
      artifactPath,
      rendererKind: normalizeRendererKind(parsed.rendererKind),
      metadata: parsed.metadata ?? {},
    };
  } catch {
    return null;
  }
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
