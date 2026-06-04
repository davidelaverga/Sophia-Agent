import type { BuilderArtifactV1 } from '../types/builder-artifact';
import type { RitualArtifacts } from '../types/session';

import {
  formatBuilderArtifactTypeLabel,
  getBuilderArtifactFiles,
} from './builder-artifacts';

export const COREVIEW_FIXTURE_EXACT_TEXT = [
  'Q3 Launch Review',
  'Strengths',
  'Risks',
  'North = 42',
  'budget delta is 17.4%',
].join('\n');

export type CoreviewArtifactTextSource =
  | 'fixture'
  | 'builder_metadata'
  | 'builder_file'
  | 'pdf_text_extraction'
  | 'artifact_store'
  | 'unsupported';

export interface CoreviewArtifactTextSuccess {
  ok: true;
  artifact_id: string;
  source: CoreviewArtifactTextSource;
  text: string;
  truncated: boolean;
  char_count: number;
  page_count?: number | null;
}

export interface CoreviewArtifactTextFailure {
  ok: false;
  artifact_id: string;
  status: 'not_found' | 'unavailable' | 'forbidden' | 'unsupported' | 'extraction_pending' | 'extraction_failed';
  safe_reason: string;
  source?: CoreviewArtifactTextSource;
  page_count?: number | null;
  char_count?: number | null;
  truncated?: boolean | null;
}

export type CoreviewArtifactTextResponse = CoreviewArtifactTextSuccess | CoreviewArtifactTextFailure;

export interface CoreviewArtifactTextRegistration {
  artifactId: string;
  source: CoreviewArtifactTextSource;
  text: string;
  pageCount?: number | null;
  charCount?: number | null;
  truncated?: boolean | null;
  sessionIds?: Array<string | null | undefined>;
  threadId?: string | null;
}

export interface CoreviewArtifactTextStatusRegistration {
  artifactId: string;
  source: CoreviewArtifactTextSource;
  status: 'loading' | 'failed' | 'unavailable';
  safeReason?: string | null;
  pageCount?: number | null;
  charCount?: number | null;
  truncated?: boolean | null;
  sessionIds?: Array<string | null | undefined>;
  threadId?: string | null;
}

export interface CoreviewArtifactTextReadInput {
  artifactId: string;
  sessionId?: string | null;
  threadId?: string | null;
}

const MAX_ARTIFACT_TEXT_CHARS = 12_000;
const registry = new Map<string, CoreviewArtifactTextRegistration[]>();
const statusRegistry = new Map<string, CoreviewArtifactTextStatusRegistration[]>();

export function registerCoreviewArtifactText(
  registration: CoreviewArtifactTextRegistration,
): () => void {
  const artifactId = normalizeToken(registration.artifactId);
  const text = typeof registration.text === 'string' ? registration.text : '';
  if (!artifactId || !text.trim()) {
    return () => undefined;
  }

  const entry: CoreviewArtifactTextRegistration = {
    artifactId,
    source: registration.source,
    text,
    pageCount: normalizePositiveInteger(registration.pageCount),
    charCount: normalizeNonNegativeInteger(registration.charCount),
    truncated: typeof registration.truncated === 'boolean' ? registration.truncated : null,
    sessionIds: normalizeSessionIds(registration.sessionIds),
    threadId: normalizeToken(registration.threadId),
  };
  const entries = registry.get(artifactId) ?? [];
  entries.push(entry);
  registry.set(artifactId, entries);

  return () => {
    const current = registry.get(artifactId);
    if (!current) {
      return;
    }
    const next = current.filter((candidate) => candidate !== entry);
    if (next.length > 0) {
      registry.set(artifactId, next);
    } else {
      registry.delete(artifactId);
    }
  };
}

export function registerCoreviewArtifactTextStatus(
  registration: CoreviewArtifactTextStatusRegistration,
): () => void {
  const artifactId = normalizeToken(registration.artifactId);
  if (!artifactId) {
    return () => undefined;
  }

  const entry: CoreviewArtifactTextStatusRegistration = {
    artifactId,
    source: registration.source,
    status: registration.status,
    safeReason: normalizeToken(registration.safeReason),
    pageCount: normalizePositiveInteger(registration.pageCount),
    charCount: normalizeNonNegativeInteger(registration.charCount),
    truncated: typeof registration.truncated === 'boolean' ? registration.truncated : null,
    sessionIds: normalizeSessionIds(registration.sessionIds),
    threadId: normalizeToken(registration.threadId),
  };
  const entries = statusRegistry.get(artifactId) ?? [];
  entries.push(entry);
  statusRegistry.set(artifactId, entries);

  return () => {
    const current = statusRegistry.get(artifactId);
    if (!current) {
      return;
    }
    const next = current.filter((candidate) => candidate !== entry);
    if (next.length > 0) {
      statusRegistry.set(artifactId, next);
    } else {
      statusRegistry.delete(artifactId);
    }
  };
}

export function readCoreviewArtifactTextSideband({
  artifactId,
  sessionId = null,
  threadId = null,
}: CoreviewArtifactTextReadInput): CoreviewArtifactTextResponse {
  const normalizedArtifactId = normalizeToken(artifactId);
  if (!normalizedArtifactId) {
    return failure('', 'not_found', 'No artifact_id was supplied for the trusted text read.');
  }

  const scope = { sessionId, threadId };
  const entries = registry.get(normalizedArtifactId) ?? [];
  const matchingEntry = [...entries].reverse().find((entry) => registrationMatches(entry, { sessionId, threadId }));
  if (matchingEntry) {
    return success(normalizedArtifactId, matchingEntry);
  }

  const statusEntries = statusRegistry.get(normalizedArtifactId) ?? [];
  const matchingStatus = [...statusEntries].reverse().find((entry) => registrationMatches(entry, scope));
  if (matchingStatus) {
    return statusFailure(normalizedArtifactId, matchingStatus);
  }

  if (entries.length > 0 || statusEntries.length > 0) {
    return failure(
      normalizedArtifactId,
      'forbidden',
      'The artifact text source is registered for a different session or thread.',
    );
  }

  return failure(
    normalizedArtifactId,
    'not_found',
    'No trusted artifact text source is registered in this app session.',
  );
}

export function clearCoreviewArtifactTextRegistryForTests(): void {
  registry.clear();
  statusRegistry.clear();
}

export function buildCoreviewBuilderMetadataText(builderArtifact: BuilderArtifactV1): string {
  const files = getBuilderArtifactFiles(builderArtifact);
  const decisions = builderArtifact.decisionsMade?.filter(Boolean) ?? [];
  const sources = builderArtifact.sourcesUsed?.filter(Boolean) ?? [];
  const lines = [
    `Title: ${builderArtifact.artifactTitle || 'Builder deliverable'}`,
    `Artifact type: ${formatBuilderArtifactTypeLabel(builderArtifact.artifactType)}`,
    `File count: ${files.length}`,
  ];

  if (files.length > 0) {
    lines.push('Files:');
    lines.push(...files.map((file) => `- ${file.label}`));
  }

  if (builderArtifact.companionSummary) {
    lines.push(`Summary: ${builderArtifact.companionSummary}`);
  }
  if (builderArtifact.userNextAction) {
    lines.push(`Next action: ${builderArtifact.userNextAction}`);
  }
  if (typeof builderArtifact.confidence === 'number' && Number.isFinite(builderArtifact.confidence)) {
    lines.push(`Confidence: ${Math.round(builderArtifact.confidence * 100)}%`);
  }
  if (typeof builderArtifact.stepsCompleted === 'number' && Number.isFinite(builderArtifact.stepsCompleted)) {
    lines.push(`Steps completed: ${Math.max(0, Math.round(builderArtifact.stepsCompleted))}`);
  }

  if (decisions.length > 0) {
    lines.push('Decisions:');
    lines.push(...decisions.map((decision) => `- ${decision}`));
  }
  if (sources.length > 0) {
    lines.push('Sources:');
    lines.push(...sources.map((source) => `- ${source}`));
  }

  lines.push('Builder file contents: unsupported in Coreview exact-text mode unless a trusted file reader is added.');
  return lines.join('\n');
}

export function buildCoreviewCompanionArtifactText(artifacts: RitualArtifacts): string | null {
  const lines: string[] = [];
  const takeaway = artifacts.takeaway?.trim();
  if (takeaway) {
    lines.push(`Takeaway: ${takeaway}`);
  }

  const reflection = artifacts.reflection_candidate;
  if (reflection?.prompt?.trim()) {
    lines.push(`Reflection: ${reflection.prompt.trim()}`);
    if (reflection.why?.trim()) {
      lines.push(`Reflection reason: ${reflection.why.trim()}`);
    }
  }

  const memories = artifacts.memory_candidates ?? [];
  if (memories.length > 0) {
    lines.push(`Memory candidate count: ${memories.length}`);
    lines.push('Memory candidates:');
    lines.push(...memories.slice(0, 5).map((memory) => `- ${memory.memory || memory.category}`));
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

function success(
  artifactId: string,
  registration: CoreviewArtifactTextRegistration,
): CoreviewArtifactTextSuccess {
  const { source, text } = registration;
  const charCount = text.length;
  const reportedCharCount = registration.charCount ?? charCount;
  const truncated = Boolean(registration.truncated) || reportedCharCount > MAX_ARTIFACT_TEXT_CHARS;
  return {
    ok: true,
    artifact_id: artifactId,
    source,
    text: text.slice(0, MAX_ARTIFACT_TEXT_CHARS),
    truncated,
    char_count: reportedCharCount,
    page_count: registration.pageCount ?? null,
  };
}

function failure(
  artifactId: string,
  status: CoreviewArtifactTextFailure['status'],
  safeReason: string,
): CoreviewArtifactTextFailure {
  return {
    ok: false,
    artifact_id: artifactId,
    status,
    safe_reason: safeReason,
  };
}

function statusFailure(
  artifactId: string,
  registration: CoreviewArtifactTextStatusRegistration,
): CoreviewArtifactTextFailure {
  const status = registration.status === 'loading'
    ? 'extraction_pending'
    : registration.status === 'failed'
      ? 'extraction_failed'
      : 'unavailable';
  const defaultReason = status === 'extraction_pending'
    ? 'exact_text_unavailable: extraction_pending'
    : status === 'extraction_failed'
      ? 'exact_text_unavailable: extraction_failed'
      : 'exact_text_unavailable';

  return {
    ok: false,
    artifact_id: artifactId,
    status,
    safe_reason: registration.safeReason ?? defaultReason,
    source: registration.source,
    page_count: registration.pageCount ?? null,
    char_count: registration.charCount ?? null,
    truncated: registration.truncated ?? null,
  };
}

function registrationMatches(
  registration: CoreviewArtifactTextRegistration | CoreviewArtifactTextStatusRegistration,
  scope: Pick<CoreviewArtifactTextReadInput, 'sessionId' | 'threadId'>,
): boolean {
  const requestedSessionId = normalizeToken(scope.sessionId);
  const registeredSessionIds = normalizeSessionIds(registration.sessionIds);
  if (
    requestedSessionId
    && registeredSessionIds.length > 0
    && !registeredSessionIds.includes(requestedSessionId)
  ) {
    return false;
  }

  const requestedThreadId = normalizeToken(scope.threadId);
  const registeredThreadId = normalizeToken(registration.threadId);
  if (requestedThreadId && registeredThreadId && requestedThreadId !== registeredThreadId) {
    return false;
  }

  return true;
}

function normalizeSessionIds(values: Array<string | null | undefined> | undefined): string[] {
  return [...new Set((values ?? []).map(normalizeToken).filter((value): value is string => Boolean(value)))];
}

function normalizeToken(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function normalizeNonNegativeInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}
