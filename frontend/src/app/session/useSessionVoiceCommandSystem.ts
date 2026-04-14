import { useCallback, useEffect, useRef } from 'react';

import { logger } from '../lib/error-logger';
import type { InterruptPayload } from '../lib/session-types';

type ReflectionCandidate = {
  prompt?: string;
  why?: string;
} | null | undefined;

type VoiceStateLike = {
  bargeIn: () => void;
};

interface UseSessionVoiceCommandSystemParams {
  onUserTranscript: (text: string) => void;
  reflectionCandidate: ReflectionCandidate;
  handleReflectionTap: (reflection: { prompt: string; why?: string }, source: 'tap' | 'voice-command') => void;
  canDownloadBuilderArtifact?: boolean;
  handleDownloadBuilderArtifact?: () => boolean;

  pendingInterrupt: InterruptPayload | null;
  isResuming: boolean;
  handleInterruptSelectWithRetry: (optionId: string) => Promise<void>;
  handleInterruptDismiss: () => void;
  handleInterruptSnooze: () => void;

  isEnding: boolean;
  isReadOnly: boolean;
  handleVoiceEndSession: () => Promise<void>;

  voiceState: VoiceStateLike;
  showToast: (args: { message: string; variant: 'info' | 'warning' | 'success' | 'error'; durationMs?: number }) => void;
  setOnUserTranscriptHandler?: (handler: (text: string) => void) => void;
  setAssistantResponseSuppressedChecker?: (checker: () => boolean) => void;
}

export function useSessionVoiceCommandSystem({
  onUserTranscript,
  reflectionCandidate,
  handleReflectionTap,
  canDownloadBuilderArtifact = false,
  handleDownloadBuilderArtifact,
  pendingInterrupt,
  isResuming,
  handleInterruptSelectWithRetry,
  handleInterruptDismiss,
  handleInterruptSnooze,
  isEnding,
  isReadOnly,
  handleVoiceEndSession,
  voiceState,
  showToast,
  setOnUserTranscriptHandler,
  setAssistantResponseSuppressedChecker,
}: UseSessionVoiceCommandSystemParams) {
  const normalizeVoiceCommand = useCallback((value: string) => {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }, []);

  const isReflectionVoiceCommand = useCallback((normalizedTranscript: string) => {
    const englishPatterns = [
      /^(sophia|sofia)\s+(start|trigger|begin)\s+reflection(\s+now)?$/,
      /^(sophia|sofia)\s+reflection\s+now$/,
      /^(sophia|sofia)\s+reflect\s+now$/,
    ];

    const spanishPatterns = [
      /^(sophia|sofia)\s+(activar|iniciar)\s+reflexion(\s+ahora)?$/,
      /^(sophia|sofia)\s+reflexion\s+ahora$/,
    ];

    return [...englishPatterns, ...spanishPatterns].some((pattern) => pattern.test(normalizedTranscript));
  }, []);

  const isDownloadVoiceCommand = useCallback((normalizedCommand: string) => {
    const englishPatterns = [
      /^download(\s+(it|that|file|artifact|deliverable))?(\s+now)?(\s+please)?$/,
      /^download\s+the\s+(file|artifact|deliverable)(\s+now)?(\s+please)?$/,
    ];

    const spanishPatterns = [
      /^descarga(r)?(\s+(el|lo|la))?(\s+(archivo|artefacto|entregable))?(\s+ahora)?(\s+por\s+favor)?$/,
      /^descarga\s+el\s+(archivo|artefacto|entregable)(\s+ahora)?(\s+por\s+favor)?$/,
    ];

    return [...englishPatterns, ...spanishPatterns].some((pattern) => pattern.test(normalizedCommand));
  }, []);

  const suppressVoiceAssistantFromCommandRef = useRef(false);
  const suppressVoiceAssistantResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (suppressVoiceAssistantResetTimerRef.current) {
        clearTimeout(suppressVoiceAssistantResetTimerRef.current);
      }
    };
  }, []);

  const interceptVoiceAssistant = useCallback((resetAfterMs: number, logLabel: string) => {
    suppressVoiceAssistantFromCommandRef.current = true;
    if (suppressVoiceAssistantResetTimerRef.current) {
      clearTimeout(suppressVoiceAssistantResetTimerRef.current);
    }
    suppressVoiceAssistantResetTimerRef.current = setTimeout(() => {
      suppressVoiceAssistantFromCommandRef.current = false;
      suppressVoiceAssistantResetTimerRef.current = null;
    }, resetAfterMs);

    try {
      voiceState.bargeIn();
    } catch (error) {
      logger.logError(error, {
        component: 'SessionPage',
        action: `${logLabel}_barge_in`,
      });
    }
  }, [
    voiceState,
    suppressVoiceAssistantFromCommandRef,
    suppressVoiceAssistantResetTimerRef,
  ]);

  const routeSessionCommand = useCallback((text: string) => {
    if (isEnding || isReadOnly) return false;

    const normalizedTranscript = normalizeVoiceCommand(text);
    if (!normalizedTranscript.startsWith('sophia ') && !normalizedTranscript.startsWith('sofia ')) {
      return false;
    }

    const command = normalizedTranscript.replace(/^(sophia|sofia)\s+/, '').trim();
    if (!command) return false;

    const matchesAny = (patterns: string[]) => patterns.some((pattern) => command === pattern || command.includes(pattern));

    const isGoBackCommand = matchesAny([
      'go back',
      'back',
      'exit session',
      'leave session',
      'salir',
      'salir de la sesion',
      'volver',
    ]);

    const isEndSessionCommand = matchesAny([
      'end session',
      'finish session',
      'close session',
      'stop session',
      'terminar sesion',
      'finalizar sesion',
      'cerrar sesion',
    ]);

    if (!isGoBackCommand && !isEndSessionCommand) return false;

    interceptVoiceAssistant(12000, 'session voice command');
    void handleVoiceEndSession();
    showToast({
      message: 'Ending session by voice command.',
      variant: 'info',
      durationMs: 1800,
    });

    return true;
  }, [
    isEnding,
    isReadOnly,
    normalizeVoiceCommand,
    interceptVoiceAssistant,
    handleVoiceEndSession,
    showToast,
  ]);

  const routeDownloadCommand = useCallback((text: string) => {
    if (isEnding || isReadOnly) return false;

    const normalizedTranscript = normalizeVoiceCommand(text);
    if (!normalizedTranscript) return false;

    const hasWakeWord = /^(sophia|sofia)\s+/.test(normalizedTranscript);
    const command = normalizedTranscript.replace(/^(sophia|sofia)\s+/, '').trim();

    if (!isDownloadVoiceCommand(command)) {
      return false;
    }

    if (!canDownloadBuilderArtifact) {
      if (!hasWakeWord) {
        return false;
      }

      showToast({
        message: 'No deliverable ready to download yet.',
        variant: 'warning',
        durationMs: 2400,
      });
      return true;
    }

    interceptVoiceAssistant(10000, 'download voice command');
    const started = handleDownloadBuilderArtifact?.() ?? false;

    showToast({
      message: started ? 'Downloading deliverable.' : 'Download unavailable right now.',
      variant: started ? 'success' : 'error',
      durationMs: started ? 2200 : 2600,
    });

    return true;
  }, [
    isEnding,
    isReadOnly,
    normalizeVoiceCommand,
    isDownloadVoiceCommand,
    canDownloadBuilderArtifact,
    showToast,
    interceptVoiceAssistant,
    handleDownloadBuilderArtifact,
  ]);

  const routeInterruptCommand = useCallback((text: string) => {
    if (!pendingInterrupt || isResuming) return false;

    const normalizedTranscript = normalizeVoiceCommand(text);
    if (!normalizedTranscript) return false;

    const command = normalizedTranscript.replace(/^(sophia|sofia)\s+/, '').trim();
    if (!command) return false;

    const options = pendingInterrupt.options || [];
    if (options.length === 0) return false;

    const primaryOption = options.find((option) => option.style === 'primary');
    const secondaryOption = options.find((option) => option.style === 'secondary' || option.style !== 'primary');
    const visibleOptions = [primaryOption, secondaryOption].filter(Boolean);

    const optionById = (optionId: string) => options.find((option) => option.id === optionId);
    const selectOption = (optionId: string) => {
      const selected = optionById(optionId);
      if (!selected) return false;
      interceptVoiceAssistant(10000, 'interrupt voice command');
      void handleInterruptSelectWithRetry(selected.id);
      return true;
    };

    const matchesAny = (patterns: string[]) => patterns.some((pattern) => command === pattern || command.includes(pattern));

    if (matchesAny(['dismiss', 'close', 'ignore', 'cancel', 'skip', 'descartar', 'cerrar', 'ignorar', 'cancelar', 'omitir'])) {
      interceptVoiceAssistant(10000, 'interrupt voice command');
      handleInterruptDismiss();
      return true;
    }

    const canSnooze = pendingInterrupt.kind !== 'MICRO_DIALOG' && 'snooze' in pendingInterrupt && pendingInterrupt.snooze;
    if (canSnooze && matchesAny(['snooze', 'remind me later', 'later', 'mas tarde', 'recordarme luego', 'recuerdame luego'])) {
      interceptVoiceAssistant(10000, 'interrupt voice command');
      handleInterruptSnooze();
      return true;
    }

    const firstOption = visibleOptions[0];
    const secondOption = visibleOptions[1];

    if (
      firstOption &&
      matchesAny([
        'option one', 'option 1', 'first option', 'first', 'primary',
        'opcion uno', 'opcion 1', 'primera opcion', 'primera',
      ])
    ) {
      return selectOption(firstOption.id);
    }

    if (
      secondOption &&
      matchesAny([
        'option two', 'option 2', 'second option', 'second', 'secondary',
        'opcion dos', 'opcion 2', 'segunda opcion', 'segunda',
      ])
    ) {
      return selectOption(secondOption.id);
    }

    if (matchesAny(['yes', 'si', 'accept', 'do it', 'lets do it', 'hagamoslo', 'aqui estoy'])) {
      if (optionById('accept')) return selectOption('accept');
      if (optionById('here')) return selectOption('here');
      if (firstOption) return selectOption(firstOption.id);
    }

    if (matchesAny(['no', 'decline', 'not now', 'im fine', 'i m fine', 'ahora no', 'estoy bien'])) {
      if (optionById('decline')) return selectOption('decline');
      if (optionById('busy')) return selectOption('busy');
      if (secondOption) return selectOption(secondOption.id);
    }

    if (matchesAny(['later', 'after one more game', 'despues de una partida mas', 'despues'])) {
      if (optionById('later')) return selectOption('later');
    }

    if (optionById('option_0') && matchesAny(['option 0', 'option zero', 'first', 'primera'])) {
      return selectOption('option_0');
    }
    if (optionById('option_1') && matchesAny(['option 1', 'option one', 'second', 'segunda'])) {
      return selectOption('option_1');
    }

    for (const option of visibleOptions) {
      const normalizedLabel = normalizeVoiceCommand(option.label);
      if (!normalizedLabel) continue;
      if (
        command === normalizedLabel ||
        command.includes(normalizedLabel) ||
        (command.length >= 6 && normalizedLabel.includes(command))
      ) {
        return selectOption(option.id);
      }
    }

    return false;
  }, [
    pendingInterrupt,
    isResuming,
    normalizeVoiceCommand,
    interceptVoiceAssistant,
    handleInterruptSelectWithRetry,
    handleInterruptDismiss,
    handleInterruptSnooze,
  ]);

  const routeReflectionCommand = useCallback((text: string) => {
    const normalizedTranscript = normalizeVoiceCommand(text);

    if (!isReflectionVoiceCommand(normalizedTranscript)) return false;

    if (reflectionCandidate?.prompt) {
      interceptVoiceAssistant(15000, 'reflection command');
      handleReflectionTap(
        {
          prompt: reflectionCandidate.prompt,
          why: reflectionCandidate.why,
        },
        'voice-command',
      );
      showToast({
        message: 'Reflection activated by voice command.',
        variant: 'info',
        durationMs: 2200,
      });
    } else {
      showToast({
        message: 'No reflection available yet. Keep chatting and try again.',
        variant: 'warning',
        durationMs: 2600,
      });
    }

    return true;
  }, [
    normalizeVoiceCommand,
    isReflectionVoiceCommand,
    reflectionCandidate,
    interceptVoiceAssistant,
    handleReflectionTap,
    showToast,
  ]);

  const routeVoiceCommand = useCallback((text: string) => {
    return (
      routeSessionCommand(text) ||
      routeDownloadCommand(text) ||
      routeInterruptCommand(text) ||
      routeReflectionCommand(text)
    );
  }, [routeSessionCommand, routeDownloadCommand, routeInterruptCommand, routeReflectionCommand]);

  const handleVoiceTranscript = useCallback((text: string) => {
    if (routeVoiceCommand(text)) {
      return;
    }
    onUserTranscript(text);
  }, [onUserTranscript, routeVoiceCommand]);

  const isAssistantResponseSuppressed = useCallback(() => {
    return suppressVoiceAssistantFromCommandRef.current;
  }, []);

  useEffect(() => {
    if (!setOnUserTranscriptHandler || !setAssistantResponseSuppressedChecker) return;
    setOnUserTranscriptHandler(handleVoiceTranscript);
    setAssistantResponseSuppressedChecker(isAssistantResponseSuppressed);
  }, [
    handleVoiceTranscript,
    isAssistantResponseSuppressed,
    setOnUserTranscriptHandler,
    setAssistantResponseSuppressedChecker,
  ]);

  return {
    handleVoiceTranscript,
    isAssistantResponseSuppressed,
  };
}
