import { recordSophiaCaptureEvent } from '../lib/session-capture';

let annotationNavigationSuppressedUntil = 0;
let coreviewBuilderUpdateNavigationSuppressedUntil = 0;

export function suppressSessionLeaveGuardForAnnotation(durationMs = 12000) {
  annotationNavigationSuppressedUntil = Math.max(
    annotationNavigationSuppressedUntil,
    Date.now() + durationMs,
  );

  recordSophiaCaptureEvent({
    category: 'voice-session',
    name: 'session-leave-guard-suppressed-for-annotation',
    payload: {
      annotationCommandPreventedNavigation: true,
      sessionLeaveGuardSuppressedForAnnotation: true,
      rawTranscriptExcluded: true,
      rawCommentTextExcluded: true,
      rawArtifactTextExcluded: true,
      rawFrameExcluded: true,
    },
  });
}

export function isSessionLeaveGuardSuppressedForAnnotation(nowMs = Date.now()) {
  return nowMs <= annotationNavigationSuppressedUntil;
}

export function suppressSessionLeaveGuardForCoreviewBuilderUpdate(durationMs = 12000) {
  coreviewBuilderUpdateNavigationSuppressedUntil = Math.max(
    coreviewBuilderUpdateNavigationSuppressedUntil,
    Date.now() + durationMs,
  );

  recordSophiaCaptureEvent({
    category: 'voice-session',
    name: 'session-leave-guard-suppressed-for-coreview-builder-update',
    payload: {
      coreviewBuilderUpdatePreventedNavigation: true,
      sessionLeaveGuardSuppressedForCoreviewBuilderUpdate: true,
      preservedMic: true,
      preservedReview: true,
      artifactStageUnmountPrevented: true,
      rawTranscriptExcluded: true,
      rawCommentTextExcluded: true,
      rawArtifactTextExcluded: true,
      rawFrameExcluded: true,
    },
  });
}

export function isSessionLeaveGuardSuppressedForInSessionActivity(nowMs = Date.now()) {
  return (
    isSessionLeaveGuardSuppressedForAnnotation(nowMs)
    || nowMs <= coreviewBuilderUpdateNavigationSuppressedUntil
  );
}

export function clearSessionLeaveGuardAnnotationSuppressionForTests() {
  annotationNavigationSuppressedUntil = 0;
  coreviewBuilderUpdateNavigationSuppressedUntil = 0;
}
