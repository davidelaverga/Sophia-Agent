'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  FIRST_RUN_ONBOARDING_STEPS,
  getUnionTargetRect,
  getFirstRunStepById,
  getFirstRunStepIndex,
  getNextFirstRunStepId,
  getPreviousFirstRunStepId,
  resolveOnboardingCopy,
} from '../../onboarding';
import { OnboardingTooltip, SpotlightOverlay, useOnboardingReducedMotion, useOnboardingVoice, useTargetRects } from '../../onboarding';
import { useOnboardingStore } from '../../stores/onboarding-store';
import {
  ArtifactsConceptPreview,
  MemoryConceptPreview,
} from './OnboardingConceptPreview';
import { debugWarn } from '../../lib/debug-logger';

function getConceptPreview(stepId: string): React.ReactNode | null {
  switch (stepId) {
    case 'artifacts-concept':
      return <ArtifactsConceptPreview />;
    case 'memory-concept':
      return <MemoryConceptPreview />;
    default:
      return null;
  }
}

export function OnboardingOrchestrator() {
  const router = useRouter();
  const pathname = usePathname();
  const firstRun = useOnboardingStore((state) => state.firstRun);
  const currentStepId = useOnboardingStore((state) => state.currentStepId);
  const startOnboarding = useOnboardingStore((state) => state.startOnboarding);
  const advanceStep = useOnboardingStore((state) => state.advanceStep);
  const goToStep = useOnboardingStore((state) => state.goToStep);
  const skipOnboarding = useOnboardingStore((state) => state.skipOnboarding);

  const [isVisible, setIsVisible] = useState(false);
  const skippedMissingTargetRef = useRef<string | null>(null);
  const reducedMotion = useOnboardingReducedMotion();
  const { speak, stop, isPlaying, voiceOverEnabled, toggleVoiceOver } = useOnboardingVoice(reducedMotion);

  const currentStep = useMemo(() => getFirstRunStepById(currentStepId), [currentStepId]);
  const shouldShowFirstRun = firstRun.status === 'not_started' || firstRun.status === 'in_progress';
  const activeRoute = currentStep?.route ?? '/';
  const isRouteEligible = pathname === activeRoute;
  const targetSelectors = useMemo(() => {
    const selector = currentStep?.target?.selector;
    if (!selector) {
      return [];
    }

    return Array.isArray(selector) ? selector : [selector];
  }, [currentStep?.target?.selector]);

  const { rects: targetRects, isResolved } = useTargetRects(targetSelectors, {
    enabled: Boolean(isVisible && targetSelectors.length > 0 && isRouteEligible),
    attempts: 3,
    delayMs: 100,
    scrollIntoViewIfNeeded: true,
  });
  const targetRect = useMemo(() => getUnionTargetRect(targetRects), [targetRects]);

  const navigateToStep = useCallback((stepId: string | null) => {
    if (!stepId) {
      advanceStep();
      return;
    }

    const nextStep = getFirstRunStepById(stepId as never);
    if (!nextStep) {
      advanceStep();
      return;
    }

    goToStep(nextStep.id);

    if (nextStep.route !== pathname) {
      router.push(nextStep.route);
    }
  }, [advanceStep, goToStep, pathname, router]);

  useEffect(() => {
    if (!shouldShowFirstRun || !isRouteEligible) {
      setIsVisible(false);
      return undefined;
    }

    const timer = setTimeout(() => {
      if (firstRun.status === 'not_started' || !currentStepId) {
        startOnboarding();
      }
      setIsVisible(true);
    }, 300);

    return () => clearTimeout(timer);
  }, [currentStepId, firstRun.status, isRouteEligible, shouldShowFirstRun, startOnboarding]);

  useEffect(() => {
    if (!currentStep?.target || !isVisible || !isResolved || targetRects.length > 0) {
      return;
    }

    if (skippedMissingTargetRef.current === currentStep.id) {
      return;
    }

    skippedMissingTargetRef.current = currentStep.id;
    debugWarn('Onboarding', 'Missing target for step, advancing safely', {
      stepId: currentStep.id,
    });
    advanceStep();
  }, [advanceStep, currentStep, isResolved, isVisible, targetRects.length]);

  useEffect(() => {
    skippedMissingTargetRef.current = null;
  }, [currentStepId]);

  useEffect(() => {
    if (!shouldShowFirstRun || !isRouteEligible || !isVisible) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        stop();
        skipOnboarding();
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        stop();
        navigateToStep(getNextFirstRunStepId(currentStepId));
        return;
      }

      if (event.key === 'ArrowLeft' && currentStepId) {
        const previousStepId = getPreviousFirstRunStepId(currentStepId);
        if (!previousStepId) {
          return;
        }

        event.preventDefault();
        stop();
        navigateToStep(previousStepId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentStepId, isRouteEligible, isVisible, navigateToStep, shouldShowFirstRun, skipOnboarding, stop]);

  useEffect(() => {
    if (!isVisible || !resolvedStepLike(currentStep, firstRun.currentStepId)?.content.voiceLine) {
      stop();
      return undefined;
    }

    const activeStep = resolvedStepLike(currentStep, firstRun.currentStepId);
    if (!activeStep) {
      stop();
      return undefined;
    }

    const timer = setTimeout(() => {
      void speak(resolveOnboardingCopy(activeStep.content.voiceLine));
    }, 200);

    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [currentStep, firstRun.currentStepId, isVisible, speak, stop]);

  if (!shouldShowFirstRun || !isRouteEligible || !isVisible) {
    return null;
  }

  const resolvedStep = resolvedStepLike(currentStep, firstRun.currentStepId);
  if (!resolvedStep) {
    return null;
  }

  const currentStepIndex = Math.max(0, getFirstRunStepIndex(resolvedStep.id));
  const previousStepId = getPreviousFirstRunStepId(resolvedStep.id);
  const preview = getConceptPreview(resolvedStep.id);

  return (
    <>
      <SpotlightOverlay
        open
        targetRect={resolvedStep.target ? targetRect : null}
        targetRects={resolvedStep.target ? targetRects : []}
        shape={resolvedStep.target?.shape ?? 'rounded-rect'}
        padding={resolvedStep.target?.padding ?? 12}
      />
      <OnboardingTooltip
        open
        title={resolveOnboardingCopy(resolvedStep.content.title)}
        body={resolveOnboardingCopy(resolvedStep.content.body)}
        voiceLabel={resolvedStep.content.voiceLine ? resolveOnboardingCopy(resolvedStep.content.voiceLine) : null}
        preferredPosition={resolvedStep.content.position}
        targetRect={resolvedStep.target ? targetRect : null}
        primaryActionLabel={resolvedStep.content.primaryActionLabel}
        onPrimaryAction={() => {
          stop();
          navigateToStep(getNextFirstRunStepId(resolvedStep.id));
        }}
        canGoBack={resolvedStep.canGoBack && Boolean(previousStepId)}
        onBack={previousStepId ? () => {
          stop();
          navigateToStep(previousStepId);
        } : undefined}
        onSkip={() => {
          stop();
          skipOnboarding();
        }}
        showStepDots
        currentStepIndex={currentStepIndex}
        totalSteps={FIRST_RUN_ONBOARDING_STEPS.length}
        showVoiceToggle
        isVoiceMuted={!voiceOverEnabled}
        isVoicePlaying={isPlaying}
        onToggleVoice={() => {
          stop();
          toggleVoiceOver();
        }}
        manageFocus
      >
        {preview}
      </OnboardingTooltip>
    </>
  );
}

function resolvedStepLike(currentStep: ReturnType<typeof getFirstRunStepById>, currentStepId: string | null) {
  return currentStep ?? getFirstRunStepById(currentStepId as never)
}