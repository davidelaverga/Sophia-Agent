"use client";

import { useMemo } from "react";
import { Wifi, WifiOff, RotateCw, AlertTriangle } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { useConnectivityStore } from "../stores/connectivity-store";
import { cn } from "../lib/utils";
import { errorCopy } from "../lib/error-copy";

export function ConnectionStatusBanner() {
  const streamStatus = useChatStore((state) => state.streamStatus);
  const streamAttempt = useChatStore((state) => state.streamAttempt);
  const retryStream = useChatStore((state) => state.retryStream);
  const dismissInterrupted = useChatStore((state) => state.dismissInterrupted);
  const connectivityStatus = useConnectivityStore((state) => state.status);

  const state = useMemo(() => {
    const isOffline = connectivityStatus === "offline";
    const isReconnecting = streamStatus === "reconnecting";
    const isInterrupted = streamStatus === "interrupted" || streamStatus === "error";

    if (isOffline) return "offline" as const;
    if (isInterrupted) return "interrupted" as const;
    if (isReconnecting) return "reconnecting" as const;
    return "connected" as const;
  }, [connectivityStatus, streamStatus]);

  const label =
    state === "offline"
      ? "Offline"
      : state === "interrupted"
        ? "Interrupted"
        : state === "reconnecting"
          ? "Reconnecting…"
          : "Connected";

  const Icon =
    state === "offline"
      ? WifiOff
      : state === "reconnecting"
        ? RotateCw
        : state === "interrupted"
          ? AlertTriangle
          : Wifi;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        "sticky top-0 z-20",
        "-mx-4 sm:-mx-6 md:-mx-8",
        "border-b border-sophia-surface-border bg-sophia-bg/80 backdrop-blur",
        "motion-safe:animate-fadeIn"
      )}
    >
      <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-2 text-xs sm:px-6">
        <div className="flex items-center gap-2 text-sophia-text2">
          <Icon className={cn("h-3.5 w-3.5", state === "reconnecting" && "motion-safe:animate-spin")} />
          <span className="font-medium text-sophia-text">{label}</span>
          {state === "reconnecting" && streamAttempt > 0 && (
            <span className="text-sophia-text2/70">Attempt {streamAttempt}</span>
          )}
        </div>

        {state === "offline" && (
          <button
            type="button"
            onClick={retryStream}
            aria-label="Retry connection"
            className={cn(
              "rounded-lg px-2.5 py-1 text-xs font-medium",
              "bg-sophia-purple/10 text-sophia-purple",
              "hover:bg-sophia-purple/20 transition-all",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
            )}
          >
            Retry
          </button>
        )}

        {state === "interrupted" && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={retryStream}
              aria-label="Retry last reply"
              className={cn(
                "rounded-lg px-2.5 py-1 text-xs font-medium",
                "bg-sophia-purple/10 text-sophia-purple",
                "hover:bg-sophia-purple/20 transition-all",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
              )}
            >
              Retry last reply
            </button>
            <button
              type="button"
              onClick={dismissInterrupted}
              aria-label="Dismiss notification"
              className={cn(
                "rounded-lg px-2.5 py-1 text-xs font-medium",
                "text-sophia-text2 hover:bg-sophia-surface-alt transition-all",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
              )}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {state === "offline" && (
        <div className="mx-auto max-w-2xl px-4 pb-2 text-[11px] text-sophia-text2 sm:px-6">
          {errorCopy.couldntReachSophia}
        </div>
      )}

      {state === "interrupted" && (
        <div className="mx-auto max-w-2xl px-4 pb-2 text-[11px] text-sophia-text2 sm:px-6">
          {errorCopy.connectionInterrupted}
        </div>
      )}
    </div>
  );
}
