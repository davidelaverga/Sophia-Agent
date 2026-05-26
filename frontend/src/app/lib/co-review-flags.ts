'use client';

export const SOPHIA_COREVIEW_FEATURE_FLAG = 'NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED';

export function isSophiaCoReviewEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SOPHIA_COREVIEW_ENABLED === 'true';
}
