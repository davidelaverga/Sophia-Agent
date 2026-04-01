import { mapBackendArtifactsToRecapV1 } from '../lib/artifacts-adapter';
import type { RitualArtifacts, MemoryCategory } from '../types/session';
import type { BackendArtifactsPayload } from '../types/recap';
import type { RecapArtifactsV1 } from '../types/recap';

type PersistArtifacts = (sessionId: string, artifacts: RecapArtifactsV1) => void;

type IngestChatVoiceArtifactsParams = {
  artifacts: Record<string, unknown>;
  conversationId?: string;
  setArtifacts: PersistArtifacts;
};

type ApplyChatRouteArtifactsParams = IngestChatVoiceArtifactsParams & {
  setEmotion?: (emotion: string) => void;
};

function resolveArtifactsSessionId(payload: BackendArtifactsPayload, conversationId?: string): string | null {
  const payloadSessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  if (payloadSessionId) return payloadSessionId;

  const fallbackConversationId = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (fallbackConversationId) return fallbackConversationId;

  return null;
}

export function resolveChatArtifactsSessionId(
  artifacts: Record<string, unknown>,
  conversationId?: string
): string | null {
  return resolveArtifactsSessionId(artifacts as BackendArtifactsPayload, conversationId);
}

export function ingestChatVoiceArtifacts({
  artifacts,
  conversationId,
  setArtifacts,
}: IngestChatVoiceArtifactsParams): boolean {
  const payload = artifacts as BackendArtifactsPayload;
  const resolvedSessionId = resolveArtifactsSessionId(payload, conversationId);

  if (!resolvedSessionId) {
    return false;
  }

  const mapped = mapBackendArtifactsToRecapV1(payload, resolvedSessionId);
  if (!mapped) {
    return false;
  }

  setArtifacts(resolvedSessionId, mapped);
  return true;
}

export function applyChatRouteArtifacts({
  artifacts,
  conversationId,
  setArtifacts,
  setEmotion,
}: ApplyChatRouteArtifactsParams): boolean {
  const primaryEmotion = artifacts.voice_emotion_primary;
  if (typeof primaryEmotion === 'string' && primaryEmotion.trim().length > 0) {
    setEmotion?.(primaryEmotion);
  }

  return ingestChatVoiceArtifacts({
    artifacts,
    conversationId,
    setArtifacts,
  });
}

const ALLOWED_MEMORY_CATEGORIES = new Set<MemoryCategory>([
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
]);

function normalizeMemoryCategory(category: string | undefined): MemoryCategory {
  if (!category) return 'episodic';
  const normalized = category.trim().toLowerCase();
  return ALLOWED_MEMORY_CATEGORIES.has(normalized as MemoryCategory)
    ? (normalized as MemoryCategory)
    : 'episodic';
}

export function mapRecapArtifactsToRitualArtifacts(
  artifacts?: RecapArtifactsV1
): RitualArtifacts | null {
  if (!artifacts) return null;

  const takeaway = artifacts.takeaway?.trim() || '';
  const reflectionPrompt = artifacts.reflectionCandidate?.prompt?.trim() || '';
  const memoryCandidates = (artifacts.memoryCandidates || [])
    .filter((candidate) => {
      const text = (candidate.text || candidate.memory || '').trim();
      return text.length > 0;
    })
    .map((candidate) => ({
      memory: (candidate.text || candidate.memory || '').trim(),
      category: normalizeMemoryCategory(candidate.category),
      confidence: typeof candidate.confidence === 'number' ? candidate.confidence : 0.8,
    }));

  const hasReflection = reflectionPrompt.length > 0;
  const hasMemories = memoryCandidates.length > 0;
  const hasTakeaway = takeaway.length > 0;

  if (!hasTakeaway && !hasReflection && !hasMemories) {
    return null;
  }

  return {
    takeaway,
    ...(hasReflection
      ? {
          reflection_candidate: {
            prompt: reflectionPrompt,
          },
        }
      : {}),
    ...(hasMemories
      ? {
          memory_candidates: memoryCandidates,
        }
      : {}),
    session_type: artifacts.sessionType,
    preset_context: artifacts.contextMode,
    timestamp: artifacts.endedAt || artifacts.startedAt,
  };
}
