"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useCopy, useTranslation } from "../copy";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useUsageLimitStore } from "../stores/usage-limit-store";
import type { UsageLimitInfo } from "../types/rate-limits";

import { FoundingSupporterBadge } from "./FoundingSupporterBadge";

type UsageLimitModalProps = {
  open: boolean;
  onClose: () => void;
  info?: UsageLimitInfo;
};

export function UsageLimitModal({ open, onClose, info }: UsageLimitModalProps) {
  const copy = useCopy()
  const { t } = useTranslation()
  const router = useRouter()

  const isAtLimit = useUsageLimitStore((state) => state.isAtLimit)
  const isFoundingSupporter = useUsageLimitStore((state) => state.isFoundingSupporter())
  const { containerRef, restoreFocus } = useFocusTrap();

  // Handle Escape key to close modal (but not when at 100% limit)
  useEffect(() => {
    if (!open) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isAtLimit) {
        handleClose();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isAtLimit]);

  const handleClose = () => {
    restoreFocus();
    onClose();
  };

  if (!open) return null;

  const handleUpgrade = () => {
    const checkoutUrl = process.env.NEXT_PUBLIC_FOUNDING_CHECKOUT_URL;
    if (checkoutUrl) {
      window.location.href = checkoutUrl;
    } else {
      router.push("/founding-supporter");
    }
  };

  const getUsageText = () => {
    if (!info) return null;
    
    switch (info.reason) {
      case "voice":
        return t("usageLimit.voiceUsed", {
          used: Math.round(info.used / 60),
          limit: Math.round(info.limit / 60),
        })
      case "text":
        return t("usageLimit.textUsed", { used: info.used, limit: info.limit })
      case "reflections":
        return t("usageLimit.reflectionsUsed", { used: info.used, limit: info.limit })
      default:
        return null;
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="usage-limit-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-sophia-bg/70 backdrop-blur-sm p-4"
      ref={containerRef}
      onClick={(e) => {
        // Prevent closing modal by clicking backdrop - user must use button
        e.stopPropagation()
      }}
    >
      <div className="w-full max-w-lg rounded-3xl bg-sophia-surface p-6 shadow-soft">
        <h2 id="usage-limit-title" className="text-xl font-semibold text-sophia-text">
          {isFoundingSupporter ? copy.usageLimit.supporter.modalTitle : copy.usageLimit.modalTitle}
        </h2>

        {info && (
          <p className="mt-2 text-sm text-sophia-text2">
            {getUsageText()}
          </p>
        )}

        {isFoundingSupporter ? (
          // Founding Supporter content - just thank them and show reset time
          <div className="mt-4 space-y-3 text-sm leading-relaxed text-sophia-text">
            <div className="flex items-center gap-2">
              <FoundingSupporterBadge compact />
              <span className="text-sophia-text2">{copy.usageLimit.supporter.thanks}</span>
            </div>
            <p>
              {copy.usageLimit.supporter.body1}
            </p>
            <p>
              {copy.usageLimit.supporter.body2}
            </p>
            <p className="font-medium text-sophia-purple">{copy.usageLimit.supporter.seeYouSoon}</p>
          </div>
        ) : (
          // Regular user content - show upgrade CTA
          <div className="mt-4 space-y-3 text-sm leading-relaxed text-sophia-text">
            {/* Empathetic opening in Sophia's voice */}
            <div className="rounded-xl bg-sophia-purple/5 p-3 border border-sophia-purple/10">
              <p className="italic text-sophia-purple">&quot;{copy.usageLimit.wishWeCouldTalkLonger}&quot;</p>
              <p className="mt-1.5 text-sophia-text2 text-xs">{copy.usageLimit.limitExistsForEveryone}</p>
            </div>

            <p>{copy.usageLimit.intro}</p>
            <p>{copy.usageLimit.ifYouFelt}</p>
            
            <ul className="space-y-1.5 pl-5">
              {copy.usageLimit.benefits.map((benefit, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="mt-1 text-sophia-purple">●</span>
                  <span>{benefit}</span>
                </li>
              ))}
            </ul>

            <p>{copy.usageLimit.noPressure}</p>
            <p className="font-medium">{copy.usageLimit.thankYou}</p>
          </div>
        )}

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => {
              // Don't allow closing if at 100% limit and not a supporter
              if (!isAtLimit || isFoundingSupporter) {
                handleClose();
              }
            }}
            disabled={isAtLimit && !isFoundingSupporter}
            className={`w-full rounded-2xl border border-sophia-surface-border bg-sophia-button px-4 py-2.5 text-sm font-medium text-sophia-text transition hover:bg-sophia-user sm:w-auto ${
              isAtLimit && !isFoundingSupporter ? "opacity-50 cursor-not-allowed" : ""
            }`}
          >
            {isFoundingSupporter ? copy.usageLimit.supporter.gotIt : copy.usageLimit.ctaSecondary}
          </button>
          {!isFoundingSupporter && (
            <button
              type="button"
              onClick={handleUpgrade}
              className="w-full rounded-2xl bg-sophia-purple px-4 py-2.5 text-sm font-semibold text-sophia-bg shadow-soft transition hover:bg-sophia-glow sm:w-auto"
            >
              {copy.usageLimit.ctaPrimary}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

