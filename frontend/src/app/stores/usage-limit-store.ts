"use client"

import { create } from "zustand";

import type { UsageLimitInfo, PlanTier } from "../types/rate-limits";

// Type for backend usage response (from /api/v1/chat/text)
// Now includes ALL usage data: text, tokens, AND voice
export type BackendUsageData = {
  plan_tier?: string;
  today: {
    text_messages: number;
    text_tokens: number;
    voice_seconds: number;
  };
  limits: {
    daily_text_messages: number;
    daily_text_tokens: number;
    daily_voice_seconds: number;
  };
  remaining: {
    text_messages: number;
    text_tokens: number;
    voice_seconds: number;
  };
};

const TOAST_COOLDOWN_MS = 20 * 60 * 1000;
const TOAST_MIN_PERCENT_DELTA = 5;

const calculateUsagePercent = (info: UsageLimitInfo): number => {
  if (info.limit <= 0) return 0;
  return Math.min(100, (info.used / info.limit) * 100);
};

type UsageLimitStore = {
  isOpen: boolean;
  limitInfo?: UsageLimitInfo;
  hintInfo?: UsageLimitInfo; // Subtle footer hint (50-79%)
  toastInfo?: UsageLimitInfo; // Gentle toast (80-99%)
  lastToastDismissedAt?: number; // Timestamp when toast was last dismissed
  lastToastPercent?: number; // Last percentage when toast was shown
  lastModalDismissedAt?: number; // Timestamp when modal was last dismissed
  isAtLimit: boolean; // True if user is at 100% usage (blocks all requests)
  planTier: PlanTier; // Current user plan tier
  currentUsage?: {
    voicePercent: number;
    textPercent: number;
    user_id?: string; // Store user_id for passing to backend
  };
  showModal: (info: UsageLimitInfo, force?: boolean) => void;
  closeModal: () => void;
  showHint: (info: UsageLimitInfo) => void;
  dismissHint: () => void;
  showToast: (info: UsageLimitInfo) => void;
  dismissToast: () => void;
  applyUsageInfo: (info: UsageLimitInfo) => void;
  setUsageData: (voicePercent: number, textPercent: number, user_id?: string) => void;
  setPlanTier: (tier: PlanTier) => void;
  isFoundingSupporter: () => boolean;
  updateFromBackendUsage: (usage: BackendUsageData) => void; // NEW: Update from inline response
};

export const useUsageLimitStore = create<UsageLimitStore>((set, get) => ({
  isOpen: false,
  limitInfo: undefined,
  hintInfo: undefined,
  toastInfo: undefined,
  lastToastDismissedAt: undefined,
  lastToastPercent: undefined,
  isAtLimit: false,
  planTier: "FREE",
  currentUsage: undefined,
  showModal: (info, force = false) => {
    const state = get()
    
    // Force parameter bypasses all checks (used by demo controls)
    if (force) {
      set({ isOpen: true, limitInfo: info })
      return
    }
    
    // If user is at 100% limit, always show modal (ignore dismissal time)
    // Otherwise, only show if it wasn't just dismissed (prevent immediate re-opening)
    if (state.isAtLimit) {
      // At 100%, always show modal regardless of dismissal time
      set({ isOpen: true, limitInfo: info })
    } else {
      const timeSinceDismiss = state.lastModalDismissedAt ? Date.now() - state.lastModalDismissedAt : Infinity
      const oneMinute = 60 * 1000
      
      if (timeSinceDismiss < oneMinute && state.lastModalDismissedAt) {
        // Modal was recently dismissed, don't show again immediately
        return
      }
      
      set({ isOpen: true, limitInfo: info })
    }
  },
  closeModal: () => {
    // If user is still at 100%, keep blocking even if modal is closed
    // The modal will reappear if they try to use Sophia
    set({ 
      isOpen: false, 
      limitInfo: undefined,
      lastModalDismissedAt: Date.now(),
    })
  },
  showHint: (info) => set({ hintInfo: info }),
  dismissHint: () => set({ hintInfo: undefined }),
  showToast: (info) => set({ toastInfo: info }),
  dismissToast: () => {
    const state = get()
    const percent = state.toastInfo ? (state.toastInfo.used / state.toastInfo.limit) * 100 : undefined
    set({ 
      toastInfo: undefined,
      lastToastDismissedAt: Date.now(),
      lastToastPercent: percent,
    })
  },
  applyUsageInfo: (info) => {
    if (!info || info.limit <= 0) return;

    const usagePercent = calculateUsagePercent(info);
    const state = get();

    if (usagePercent >= 100) {
      if (!state.isAtLimit) {
        set({ isAtLimit: true });
      }
      state.showModal(info);
      state.dismissToast();
      state.dismissHint();
      return;
    }

    if (usagePercent >= 80) {
      if (state.isOpen) {
        state.dismissToast();
        state.dismissHint();
        return;
      }

      const now = Date.now();
      const timeSinceDismiss = state.lastToastDismissedAt ? now - state.lastToastDismissedAt : Infinity;
      const percentIncrease = typeof state.lastToastPercent === "number" ? usagePercent - state.lastToastPercent : Infinity;

      const shouldShowToast =
        !state.toastInfo &&
        !state.isOpen &&
        (timeSinceDismiss > TOAST_COOLDOWN_MS || percentIncrease >= TOAST_MIN_PERCENT_DELTA);

      if (shouldShowToast) {
        state.showToast(info);
      }

      state.dismissHint();
      return;
    }

    if (usagePercent >= 50) {
      if (!state.isOpen) {
        state.showHint(info);
      }
      return;
    }

    state.dismissHint();
    state.dismissToast();

    if (typeof state.lastToastPercent === "number" && usagePercent < 50) {
      set({
        lastToastDismissedAt: undefined,
        lastToastPercent: undefined,
      });
    }
  },
  setUsageData: (voicePercent: number, textPercent: number, user_id?: string) => {
    const isAtLimit = voicePercent >= 100 || textPercent >= 100
    set({ 
      isAtLimit,
      currentUsage: { voicePercent, textPercent, user_id },
    })
  },
  setPlanTier: (tier: PlanTier) => set({ planTier: tier }),
  isFoundingSupporter: () => get().planTier === "FOUNDING_SUPPORTER",
  
  // NEW: Update usage data from backend response (inline in chat/text response)
  // This reduces the need for separate /usage endpoint polling
  updateFromBackendUsage: (usage: BackendUsageData) => {
    if (!usage) return;
    
    const state = get();
    const currentUserId = state.currentUsage?.user_id;
    
    // Calculate text usage percentage
    const textLimit = usage.limits.daily_text_messages;
    const textUsed = usage.today.text_messages;
    const textPercent = textLimit > 0 ? (textUsed / textLimit) * 100 : 0;
    
    // Calculate voice usage percentage (now included in response!)
    const voiceLimit = usage.limits.daily_voice_seconds;
    const voiceUsed = usage.today.voice_seconds;
    const voicePercent = voiceLimit > 0 ? (voiceUsed / voiceLimit) * 100 : 0;
    
    // Update plan tier (optional field, keep existing if not provided)
    const planTier = usage.plan_tier 
      ? (usage.plan_tier.toUpperCase() as PlanTier)
      : state.planTier;
    
    // Check if at limit
    const isAtLimit = textPercent >= 100 || voicePercent >= 100;
    
    set({
      planTier,
      isAtLimit,
      currentUsage: { voicePercent, textPercent, user_id: currentUserId },
    });
    
    const textInfo: UsageLimitInfo = {
      reason: "text",
      plan_tier: planTier,
      limit: textLimit,
      used: textUsed,
    };
    const voiceInfo: UsageLimitInfo = {
      reason: "voice",
      plan_tier: planTier,
      limit: voiceLimit,
      used: voiceUsed,
    };

    get().applyUsageInfo(textInfo);
    get().applyUsageInfo(voiceInfo);
  },
}));
