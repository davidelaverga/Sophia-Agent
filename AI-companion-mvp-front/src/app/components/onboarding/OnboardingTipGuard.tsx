'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  getContextualTipById,
  OnboardingTooltip,
  resolveOnboardingCopy,
  useOnboardingReducedMotion,
  useOnboardingVoice,
  useTargetRect,
} from '../../onboarding';
import type { ContextualTipId } from '../../onboarding/types';
import { useOnboardingStore } from '../../stores/onboarding-store';

interface OnboardingTipGuardProps {
  tipId: ContextualTipId;
  isTriggered: boolean;
}

function matchesRoutePattern(pathname: string, routePattern: string): boolean {
  if (pathname === routePattern) {
    return true;
  }

  if (!routePattern.includes('[') && pathname.startsWith(`${routePattern}/`)) {
    return true;
  }

  const pathnameSegments = pathname.split('/').filter(Boolean);
  const patternSegments = routePattern.split('/').filter(Boolean);

  if (pathnameSegments.length !== patternSegments.length) {
    return false;
  }

  return patternSegments.every((segment, index) => {
    if (segment.startsWith('[') && segment.endsWith(']')) {
      return pathnameSegments[index].length > 0;
    }

    return pathnameSegments[index] === segment;
  });
}

export function OnboardingTipGuard({ tipId, isTriggered }: OnboardingTipGuardProps) {
  const pathname = usePathname();
  const tip = useMemo(() => getContextualTipById(tipId), [tipId]);
  const reducedMotion = useOnboardingReducedMotion();
  const { speak, stop } = useOnboardingVoice(reducedMotion);

  const firstRunStatus = useOnboardingStore((state) => state.firstRun.status);
  const tipSeen = useOnboardingStore((state) => state.contextualTips[tipId]?.seen ?? false);
  const activeContextualTipId = useOnboardingStore((state) => state.activeContextualTipId);
  const requestContextualTip = useOnboardingStore((state) => state.requestContextualTip);
  const clearActiveContextualTip = useOnboardingStore((state) => state.clearActiveContextualTip);
  const dismissTip = useOnboardingStore((state) => state.dismissTip);

  const [isOpen, setIsOpen] = useState(false);

  const routeMatches = Boolean(tip && matchesRoutePattern(pathname, tip.route));
  const targetSelector = typeof tip?.target.selector === 'string'
    ? tip.target.selector
    : tip?.target.selector?.[0];
  const shouldAttempt = Boolean(
    tip &&
    isTriggered &&
    routeMatches &&
    !tipSeen &&
    (firstRunStatus === 'completed' || firstRunStatus === 'skipped')
  );

  const { rect: targetRect } = useTargetRect(targetSelector, {
    enabled: shouldAttempt,
    attempts: 5,
    delayMs: 120,
    scrollIntoViewIfNeeded: false,
  });

  useEffect(() => {
    if (!tip || !shouldAttempt || !targetRect) {
      if (!shouldAttempt) {
        setIsOpen(false);
      }
      return undefined;
    }

    if (activeContextualTipId && activeContextualTipId !== tipId) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      if (requestContextualTip(tipId)) {
        setIsOpen(true);
      }
    }, tip.delayMs);

    return () => window.clearTimeout(timer);
  }, [activeContextualTipId, requestContextualTip, shouldAttempt, targetRect, tip, tipId]);

  useEffect(() => {
    if (activeContextualTipId && activeContextualTipId !== tipId && isOpen) {
      setIsOpen(false);
    }
  }, [activeContextualTipId, isOpen, tipId]);

  useEffect(() => {
    if (!tip || !isOpen || !tip.content.voiceLine) {
      stop();
      return undefined;
    }

    const timer = window.setTimeout(() => {
      void speak(resolveOnboardingCopy(tip.content.voiceLine));
    }, 200);

    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [isOpen, speak, stop, tip]);

  useEffect(() => () => {
    stop();
    clearActiveContextualTip(tipId);
  }, [clearActiveContextualTip, stop, tipId]);

  if (!tip || !shouldAttempt || !targetRect || !isOpen) {
    return null;
  }

  const handleDismiss = () => {
    stop();
    dismissTip(tipId);
    clearActiveContextualTip(tipId);
    setIsOpen(false);
  };

  return (
    <OnboardingTooltip
      open
      ariaModal={false}
      title={resolveOnboardingCopy(tip.content.title)}
      body={resolveOnboardingCopy(tip.content.body)}
      voiceLabel={tip.content.voiceLine ? resolveOnboardingCopy(tip.content.voiceLine) : null}
      preferredPosition={tip.content.position}
      targetRect={targetRect}
      primaryActionLabel={tip.content.primaryActionLabel}
      onPrimaryAction={handleDismiss}
    />
  );
}