import { useCallback, useEffect, useRef, useState } from 'react';

import type { UIMessage } from '../components/session';
import { debugInfo, debugWarn } from '../lib/debug-logger';
import type { ConnectivityStatus } from '../stores/connectivity-store';

type ReflectionInput = { prompt: string; why?: string };
type ReflectionSource = 'tap' | 'voice-command';

type ChatMessage = {
  id: string;
  role: 'system' | 'user' | 'assistant';
  parts: Array<{
    type?: string;
    text?: string;
    [key: string]: unknown;
  }>;
};

interface UseSessionReflectionVoiceFlowParams {
  reflectionPrefix: string;
  messages: UIMessage[];
  isStreaming: boolean;
  chatStatus: 'submitted' | 'streaming' | 'ready' | 'error';
  isTyping: boolean;
  voiceStatus: 'ready' | 'listening' | 'thinking' | 'speaking';
  isReflectionTtsActive: boolean;
  speakText: (text: string, traceId?: string) => Promise<boolean>;
  sendMessage: (params: { text: string }) => Promise<void>;
  connectivityStatus: ConnectivityStatus;
  queueMessage: (content: string, sessionId: string) => string;
  sessionId: string;
  setChatMessages: (messages: ChatMessage[] | ((messages: ChatMessage[]) => ChatMessage[])) => void;
  showToast: (input: {
    message: string;
    variant?: 'info' | 'success' | 'warning' | 'error';
    durationMs?: number;
    action?: { label: string; onClick: () => void };
  }) => void;
}

const MIN_REFLECTION_SPEAK_CHARS = 80;
export const SESSION_REFLECTION_PREFIX = "Let's reflect on: ";

export function useSessionReflectionVoiceFlow({
  reflectionPrefix,
  messages,
  isStreaming,
  chatStatus,
  isTyping,
  voiceStatus,
  isReflectionTtsActive,
  speakText,
  sendMessage,
  connectivityStatus,
  queueMessage,
  sessionId,
  setChatMessages,
  showToast,
}: UseSessionReflectionVoiceFlowParams) {
  const [isReflectionVoiceFlowActive, setIsReflectionVoiceFlowActive] = useState(false);
  const reflectionWhyMapRef = useRef<Map<string, string>>(new Map());
  const pendingVoiceReflectionPromptRef = useRef<string | null>(null);
  const spokenReflectionResponseIdRef = useRef<string | null>(null);
  const reflectionVoicePlaybackInFlightRef = useRef(false);
  const pendingVoiceReflectionTraceIdRef = useRef<string | null>(null);
  const reflectionVoiceAttemptedTraceIdsRef = useRef<Set<string>>(new Set());
  const reflectionVoiceLastBlockKeyRef = useRef<string | null>(null);
  const reflectionVoiceFlowTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const logReflectionVoice = useCallback((stage: string, payload?: Record<string, unknown>) => {
    if (process.env.NODE_ENV === 'production') return;
    debugInfo('reflection-voice', stage, payload || {});
  }, []);

  const logReflectionVoiceBlocked = useCallback((reason: string, payload: Record<string, unknown>) => {
    const key = `${reason}:${payload.traceId ?? 'no-trace'}`;
    if (reflectionVoiceLastBlockKeyRef.current === key) return;
    reflectionVoiceLastBlockKeyRef.current = key;
    logReflectionVoice(`blocked:${reason}`, payload);
  }, [logReflectionVoice]);

  const handleReflectionTap = useCallback((reflection: ReflectionInput, source: ReflectionSource = 'tap') => {
    if (isTyping) return;
    if (!reflection.prompt) return;

    if (reflection.why) {
      reflectionWhyMapRef.current.set(reflection.prompt, reflection.why);
    }

    const reflectionText = `${reflectionPrefix}${reflection.prompt}`;

    if (connectivityStatus === 'offline' || connectivityStatus === 'degraded') {
      const queuedId = queueMessage(reflectionText, sessionId);
      setChatMessages((prev) => [
        ...prev,
        {
          id: `queued-${queuedId}`,
          role: 'user',
          parts: [{ type: 'text', text: reflectionText }],
        },
      ]);
      showToast({
        message: "I'm offline right now, so I saved your reflection and I'll send it automatically when we're back online.",
        variant: 'info',
        durationMs: 3600,
      });
      return;
    }

    if (source === 'voice-command') {
      pendingVoiceReflectionPromptRef.current = reflection.prompt;
      spokenReflectionResponseIdRef.current = null;
      pendingVoiceReflectionTraceIdRef.current = `rv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setIsReflectionVoiceFlowActive(true);
      if (reflectionVoiceFlowTimeoutRef.current) {
        clearTimeout(reflectionVoiceFlowTimeoutRef.current);
      }
      reflectionVoiceFlowTimeoutRef.current = setTimeout(() => {
        setIsReflectionVoiceFlowActive(false);
        reflectionVoiceFlowTimeoutRef.current = null;
      }, 45000);
      logReflectionVoice('queued', {
        traceId: pendingVoiceReflectionTraceIdRef.current,
        promptPreview: reflection.prompt.slice(0, 80),
      });
    }

    void sendMessage({ text: reflectionText });
  }, [
    connectivityStatus,
    isTyping,
    logReflectionVoice,
    queueMessage,
    reflectionPrefix,
    sendMessage,
    sessionId,
    setChatMessages,
    showToast,
  ]);

  useEffect(() => {
    const targetPrompt = pendingVoiceReflectionPromptRef.current;
    if (!targetPrompt || messages.length < 2) return;
    const traceId = pendingVoiceReflectionTraceIdRef.current || `rv-${Date.now()}-fallback`;

    if (isStreaming) {
      logReflectionVoiceBlocked('isStreaming', { traceId, chatStatus });
      return;
    }
    if (isTyping) {
      logReflectionVoiceBlocked('isTyping', { traceId });
      return;
    }
    if (voiceStatus !== 'ready') {
      logReflectionVoiceBlocked('voiceNotReady', { traceId, voiceStatus });
      return;
    }
    if (reflectionVoicePlaybackInFlightRef.current) {
      logReflectionVoiceBlocked('inFlight', { traceId });
      return;
    }
    if (reflectionVoiceAttemptedTraceIdsRef.current.has(traceId)) {
      logReflectionVoiceBlocked('alreadyAttempted', { traceId });
      return;
    }

    let latest: UIMessage | null = null;
    let previous: UIMessage | null = null;
    for (let index = messages.length - 1; index > 0; index -= 1) {
      const candidateAssistant = messages[index];
      const candidateUser = messages[index - 1];
      const assistantText = candidateAssistant?.content?.trim?.() || '';
      if (
        candidateAssistant?.role === 'assistant' &&
        candidateUser?.role === 'user' &&
        candidateUser.content.startsWith(reflectionPrefix) &&
        assistantText.length >= MIN_REFLECTION_SPEAK_CHARS
      ) {
        latest = candidateAssistant;
        previous = candidateUser;
        break;
      }
    }

    if (!latest || !previous) {
      logReflectionVoiceBlocked('noReflectionPair', { traceId, messageCount: messages.length });
      return;
    }

    const textToSpeak = latest.content?.trim();
    if (!textToSpeak) {
      logReflectionVoice('blocked:emptyAssistantText', { traceId, assistantId: latest.id });
      return;
    }
    if (spokenReflectionResponseIdRef.current === latest.id) {
      logReflectionVoice('blocked:alreadySpoken', { traceId, assistantId: latest.id });
      return;
    }

    reflectionVoicePlaybackInFlightRef.current = true;
    reflectionVoiceAttemptedTraceIdsRef.current.add(traceId);
    pendingVoiceReflectionPromptRef.current = null;
    pendingVoiceReflectionTraceIdRef.current = null;
    reflectionVoiceLastBlockKeyRef.current = null;
    logReflectionVoice('speak:start', {
      traceId,
      assistantId: latest.id,
      textLength: textToSpeak.length,
    });

    let cancelled = false;
    void (async () => {
      try {
        const spoken = await speakText(textToSpeak, traceId);
        if (!cancelled && spoken) {
          spokenReflectionResponseIdRef.current = latest.id;
          logReflectionVoice('speak:success', { traceId, assistantId: latest.id });
        } else if (!cancelled) {
          setIsReflectionVoiceFlowActive(false);
          logReflectionVoice('speak:returnFalse', { traceId, assistantId: latest.id });
        }
      } catch (error) {
        if (!cancelled) {
          setIsReflectionVoiceFlowActive(false);
          logReflectionVoice('speak:error', {
            traceId,
            message: error instanceof Error ? error.message : String(error),
          });
          debugWarn('SessionPage', 'reflection voice playback failed', error);
        }
      } finally {
        if (!cancelled) {
          reflectionVoicePlaybackInFlightRef.current = false;
        }
      }
    })();

    return () => {
      cancelled = true;
      reflectionVoicePlaybackInFlightRef.current = false;
      logReflectionVoice('effect:cleanup', { traceId });
    };
  }, [
    chatStatus,
    isStreaming,
    isTyping,
    logReflectionVoice,
    logReflectionVoiceBlocked,
    messages,
    reflectionPrefix,
    speakText,
    voiceStatus,
  ]);

  useEffect(() => {
    if (!isReflectionVoiceFlowActive) return;
    if (isStreaming) return;
    if (voiceStatus !== 'ready') return;
    if (isReflectionTtsActive) return;
    if (reflectionVoicePlaybackInFlightRef.current) return;

    setIsReflectionVoiceFlowActive(false);
    if (reflectionVoiceFlowTimeoutRef.current) {
      clearTimeout(reflectionVoiceFlowTimeoutRef.current);
      reflectionVoiceFlowTimeoutRef.current = null;
    }
  }, [isReflectionTtsActive, isReflectionVoiceFlowActive, isStreaming, voiceStatus]);

  useEffect(() => {
    return () => {
      if (reflectionVoiceFlowTimeoutRef.current) {
        clearTimeout(reflectionVoiceFlowTimeoutRef.current);
      }
    };
  }, []);

  const getReflectionWhy = useCallback((prompt?: string) => {
    if (!prompt) return undefined;
    return reflectionWhyMapRef.current.get(prompt);
  }, []);

  return {
    isReflectionVoiceFlowActive,
    handleReflectionTap,
    getReflectionWhy,
  };
}
