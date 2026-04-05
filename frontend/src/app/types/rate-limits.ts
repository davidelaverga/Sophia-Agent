export type UsageLimitReason = "voice" | "text" | "reflections";
export type PlanTier = "FREE" | "FOUNDING_SUPPORTER";

export type UsageLimitError = {
  error: "USAGE_LIMIT_REACHED";
  reason: UsageLimitReason;
  plan_tier: PlanTier;
  limit: number;
  used: number;
  message?: string;
  body?: string;
};

export type UsageLimitInfo = {
  reason: UsageLimitReason;
  plan_tier: PlanTier;
  limit: number;
  used: number;
};

export const FOUNDING_PRICE = {
  monthly: "€12 / month",
  yearly: "€99 / year",
} as const;

export const FREE_LIMITS = {
  voice: { minutes: 10, description: "10 minutes of voice chat daily" },
  text: { minutes: 30, description: "30 minutes of text chat daily" },
  reflections: { count: 4, description: "4 Reflection Cards per month" },
} as const;

export const FOUNDING_LIMITS = {
  voice: { minutes: 60, description: "60 minutes of voice chat daily" },
  text: { minutes: 120, description: "120 minutes of text chat daily" },
  reflections: { count: 30, description: "30 Reflection Cards per month" },
} as const;

