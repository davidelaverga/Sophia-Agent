
import { asRecord } from '../lib/record-parsers';
import type { RitualArtifacts } from '../lib/session-types';

const FALLBACK_REFLECTIONS = new Set([
  'what mattered most in this conversation?',
  'general reflection prompt',
  'general reflection',
]);

const FALLBACK_TAKEAWAYS = new Set([
  'session completed',
  'companion error - fallback response',
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isRealReflection(prompt: string | undefined): boolean {
  if (!prompt) return false;
  return !FALLBACK_REFLECTIONS.has(prompt.trim().toLowerCase());
}

export function isRealTakeaway(takeaway: string | undefined): boolean {
  if (!takeaway) return false;
  if (takeaway.trim().length === 0) return false;
  return !FALLBACK_TAKEAWAYS.has(takeaway.trim().toLowerCase());
}

export function normalizeMemoryCandidates(raw: unknown): RitualArtifacts['memory_candidates'] {
  if (!Array.isArray(raw)) return [];

  const allowedCategories = [
    'identity_profile',
    'relationship_context',
    'goals_projects',
    'emotional_patterns',
    'regulation_tools',
    'preferences_boundaries',
    'wins_pride',
    'temporary_context',
    'episodic',
    'emotional',
    'reflective',
  ];

  return raw
    .map((candidate) => {
      const record = asRecord(candidate);
      if (!record) return null;
      const text = record.text || record.memory || record.content;
      if (!isNonEmptyString(text)) return null;

      const categoryRaw = typeof record.category === 'string' ? record.category.toLowerCase() : undefined;
      const category = allowedCategories.includes(categoryRaw || '')
        ? (categoryRaw as RitualArtifacts['memory_candidates'][number]['category'])
        : 'episodic';

      const confidence = typeof record.confidence === 'number' ? record.confidence : 0.8;
      const tags = Array.isArray(record.tags)
        ? record.tags.filter((tag): tag is string => typeof tag === 'string')
        : undefined;
      const id = typeof record.id === 'string'
        ? record.id
        : typeof record.candidate_id === 'string'
          ? record.candidate_id
          : undefined;
      const createdAt = typeof record.created_at === 'string' ? record.created_at : undefined;
      const reason = typeof record.reason === 'string' ? record.reason : undefined;

      return {
        ...(id ? { id } : {}),
        memory: String(text),
        category,
        confidence,
        ...(createdAt ? { created_at: createdAt } : {}),
        ...(reason ? { reason } : {}),
        ...(tags ? { tags } : {}),
      };
    })
    .filter((candidate): candidate is RitualArtifacts['memory_candidates'][number] => candidate !== null)
    .slice(0, 3);
}

function extractReflectionCandidate(raw: unknown): { prompt: string; why?: string } | undefined {
  if (isNonEmptyString(raw)) {
    return { prompt: raw };
  }
  const record = asRecord(raw);
  if (!record) return undefined;
  if (!isNonEmptyString(record.prompt)) return undefined;
  const why = isNonEmptyString(record.why) ? record.why : undefined;
  return { prompt: record.prompt, ...(why ? { why } : {}) };
}

export function mergeRitualArtifacts(
  current: RitualArtifacts | null | undefined,
  incoming: unknown,
  options?: {
    filterFallbackTakeaway?: boolean;
    filterFallbackReflection?: boolean;
    mergeMemoryCandidates?: boolean;
  }
): { merged: RitualArtifacts; normalizedMemoryCandidates: RitualArtifacts['memory_candidates'] } {
  const currentArtifacts: RitualArtifacts = current || { takeaway: '' };

  const payload = asRecord(incoming);
  if (!payload) {
    return { merged: currentArtifacts, normalizedMemoryCandidates: [] };
  }

  const filterFallbackTakeaway = options?.filterFallbackTakeaway ?? false;
  const filterFallbackReflection = options?.filterFallbackReflection ?? false;
  const mergeMemoryCandidates = options?.mergeMemoryCandidates ?? true;

  const rawTakeaway = isNonEmptyString(payload.takeaway) ? payload.takeaway : undefined;
  const takeaway = filterFallbackTakeaway ? (isRealTakeaway(rawTakeaway) ? rawTakeaway : undefined) : rawTakeaway;

  const reflectionCandidate = extractReflectionCandidate(
    payload.reflection_candidate ?? payload.reflection
  );
  const validReflection = filterFallbackReflection
    ? (reflectionCandidate?.prompt && isRealReflection(reflectionCandidate.prompt) ? reflectionCandidate : undefined)
    : reflectionCandidate;

  const normalizedMemoryCandidates = mergeMemoryCandidates
    ? normalizeMemoryCandidates(payload.memory_candidates)
    : [];

  const baseTakeaway = takeaway ?? currentArtifacts.takeaway ?? '';

  const merged: RitualArtifacts = {
    ...currentArtifacts,
    takeaway: baseTakeaway,
    ...(validReflection ? { reflection_candidate: validReflection } : {}),
    ...(normalizedMemoryCandidates.length > 0 ? { memory_candidates: normalizedMemoryCandidates } : {}),
  };

  return { merged, normalizedMemoryCandidates };
}

export function getLiveArtifactStatus(artifacts: RitualArtifacts): {
  takeaway: 'waiting' | 'capturing' | 'ready';
  reflection: 'waiting' | 'capturing' | 'ready';
  memories: 'waiting' | 'capturing' | 'ready';
} {
  const hasReflection = !!artifacts.reflection_candidate?.prompt;
  const hasMemories = (artifacts.memory_candidates?.length ?? 0) > 0;

  return {
    takeaway: artifacts.takeaway ? 'ready' : 'capturing',
    reflection: hasReflection ? 'ready' : artifacts.takeaway ? 'capturing' : 'waiting',
    memories: hasMemories ? 'ready' : 'waiting',
  };
}

export function getPersistedArtifactStatus(artifacts: RitualArtifacts): {
  takeaway: 'waiting' | 'capturing' | 'ready';
  reflection: 'waiting' | 'capturing' | 'ready';
  memories: 'waiting' | 'capturing' | 'ready';
} {
  const hasReflection = !!artifacts.reflection_candidate?.prompt;
  const hasMemories = (artifacts.memory_candidates?.length ?? 0) > 0;

  return {
    takeaway: artifacts.takeaway ? 'ready' : 'waiting',
    reflection: hasReflection ? 'ready' : artifacts.takeaway ? 'capturing' : 'waiting',
    memories: hasMemories ? 'ready' : 'waiting',
  };
}
