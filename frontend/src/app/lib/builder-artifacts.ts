import type {
  BuilderArtifactFileV1,
  BuilderArtifactV1,
} from '../types/builder-artifact';

import { asRecord, readNumber, readString } from './record-parsers';

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function coerceString(record: Record<string, unknown>, snakeKey: string, camelKey?: string): string | undefined {
  return readString(record, snakeKey) ?? (camelKey ? readString(record, camelKey) : undefined);
}

function coerceStringArray(record: Record<string, unknown>, snakeKey: string, camelKey?: string): string[] {
  return readStringArray(record[snakeKey] ?? (camelKey ? record[camelKey] : undefined));
}

function coerceNumber(record: Record<string, unknown>, snakeKey: string, camelKey?: string): number | undefined {
  return readNumber(record, snakeKey) ?? (camelKey ? readNumber(record, camelKey) : undefined);
}

function sanitizeArtifactPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^file:\/\//, '');
}

export function normalizeBuilderArtifactPath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') {
    return null;
  }

  const sanitized = sanitizeArtifactPath(path);
  if (!sanitized) {
    return null;
  }

  if (sanitized.startsWith('/mnt/user-data/outputs/')) {
    return sanitized.slice(1);
  }

  if (sanitized.startsWith('mnt/user-data/outputs/')) {
    return sanitized;
  }

  const userDataOutputsIndex = sanitized.indexOf('/user-data/outputs/');
  if (userDataOutputsIndex >= 0) {
    return `mnt${sanitized.slice(userDataOutputsIndex)}`;
  }

  if (sanitized.startsWith('/user-data/outputs/')) {
    return `mnt${sanitized}`;
  }

  if (sanitized.startsWith('user-data/outputs/')) {
    return `mnt/${sanitized}`;
  }

  if (sanitized.startsWith('/outputs/')) {
    return `mnt/user-data${sanitized}`;
  }

  if (sanitized.startsWith('outputs/')) {
    return `mnt/user-data/${sanitized}`;
  }

  return sanitized.replace(/^\/+/, '');
}

function getFallbackTitle(artifactPath: string | undefined): string {
  if (!artifactPath) {
    return 'Builder deliverable';
  }

  const name = artifactPath.split('/').filter(Boolean).pop() || artifactPath;
  return name;
}

export function normalizeBuilderArtifactPayload(raw: unknown): BuilderArtifactV1 | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  const rawArtifactTitle = coerceString(record, 'artifact_title', 'artifactTitle');
  const artifactPath = normalizeBuilderArtifactPath(
    coerceString(record, 'artifact_path', 'artifactPath')
  ) || undefined;
  const supportingFiles = coerceStringArray(record, 'supporting_files', 'supportingFiles')
    .map((path) => normalizeBuilderArtifactPath(path))
    .filter((path): path is string => typeof path === 'string');
  const decisionsMade = coerceStringArray(record, 'decisions_made', 'decisionsMade').slice(0, 4);
  const sourcesUsed = coerceStringArray(record, 'sources_used', 'sourcesUsed');
  const artifactTitle = rawArtifactTitle || getFallbackTitle(artifactPath);
  const companionSummary = coerceString(record, 'companion_summary', 'companionSummary');
  const userNextAction = coerceString(record, 'user_next_action', 'userNextAction');

  if (
    !artifactPath &&
    supportingFiles.length === 0 &&
    !companionSummary &&
    !userNextAction &&
    !rawArtifactTitle
  ) {
    return null;
  }

  return {
    ...(artifactPath ? { artifactPath } : {}),
    artifactType: coerceString(record, 'artifact_type', 'artifactType') || 'unknown',
    artifactTitle,
    ...(supportingFiles.length > 0 ? { supportingFiles } : {}),
    ...(coerceNumber(record, 'steps_completed', 'stepsCompleted') !== undefined
      ? { stepsCompleted: coerceNumber(record, 'steps_completed', 'stepsCompleted') }
      : {}),
    decisionsMade,
    ...(sourcesUsed.length > 0 ? { sourcesUsed } : {}),
    ...(companionSummary ? { companionSummary } : {}),
    ...(coerceString(record, 'companion_tone_hint', 'companionToneHint')
      ? { companionToneHint: coerceString(record, 'companion_tone_hint', 'companionToneHint') }
      : {}),
    ...(userNextAction ? { userNextAction } : {}),
    ...(coerceNumber(record, 'confidence') !== undefined
      ? { confidence: coerceNumber(record, 'confidence') }
      : {}),
  };
}

function getFileLabel(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

export function getBuilderArtifactFiles(builderArtifact: BuilderArtifactV1 | null | undefined): BuilderArtifactFileV1[] {
  if (!builderArtifact) {
    return [];
  }

  const seen = new Set<string>();
  const files: BuilderArtifactFileV1[] = [];

  const addFile = (path: string | undefined, isPrimary: boolean) => {
    if (!path || seen.has(path)) {
      return;
    }

    seen.add(path);
    files.push({
      path,
      name: getFileLabel(path),
      label: getFileLabel(path),
      isPrimary,
    });
  };

  addFile(builderArtifact.artifactPath, true);
  for (const supportingFile of builderArtifact.supportingFiles || []) {
    addFile(supportingFile, false);
  }

  return files;
}

export function buildThreadArtifactHref(
  threadId: string | null | undefined,
  artifactPath: string | null | undefined,
  options?: { download?: boolean },
): string | null {
  if (!threadId) {
    return null;
  }

  const normalizedPath = normalizeBuilderArtifactPath(artifactPath);
  if (!normalizedPath) {
    return null;
  }

  const encodedPath = normalizedPath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  const baseHref = `/api/threads/${encodeURIComponent(threadId)}/artifacts/${encodedPath}`;
  return options?.download ? `${baseHref}?download=true` : baseHref;
}

export function formatBuilderArtifactTypeLabel(type: string | undefined): string {
  if (!type) {
    return 'Deliverable';
  }

  return type
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}