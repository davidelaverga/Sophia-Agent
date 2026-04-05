"use client";

import { useEffect, useMemo, useState } from "react";
import { Clipboard, Bug, Trash2, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";
import { clearLocalSessionData, getDebugSnapshot } from "../lib/debug-tools";
import { useUiStore } from "../stores/ui-store";

export function DevDiagnosticsPanel() {
  const showToast = useUiStore((state) => state.showToast);
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState(() => getDebugSnapshot());

  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      setEnabled(true);
    }
    // 🔒 SECURITY: ?debug=1 production bypass removed — panel is dev-only
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setSnapshot(getDebugSnapshot()), open ? 1000 : 3000);
    return () => clearInterval(timer);
  }, [enabled, open]);

  const details = useMemo(() => {
    return [
      { label: "conversationId", value: snapshot.conversationId },
      { label: "session_id", value: snapshot.session_id },
      { label: "thread_id", value: snapshot.thread_id },
      { label: "activeReplyId", value: snapshot.activeReplyId },
      { label: "lastCompletedTurnId", value: snapshot.lastCompletedTurnId },
      { label: "streamStatus", value: snapshot.streamStatus },
      { label: "streamAttempt", value: snapshot.streamAttempt },
      { label: "pendingInterrupt", value: snapshot.pendingInterrupt ? "true" : "false" },
      { label: "pendingInterruptCount", value: snapshot.pendingInterruptCount },
      { label: "artifactsStatus", value: snapshot.artifactsStatus },
      { label: "memoryCommitStatus", value: snapshot.memoryCommitStatus },
      { label: "connectivityStatus", value: snapshot.connectivityStatus },
    ];
  }, [snapshot]);

  if (!enabled) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <div className="flex flex-col items-end gap-2">
        {open && (
          <div
            className={cn(
              "w-[320px] rounded-2xl border border-sophia-surface-border bg-sophia-surface/95",
              "p-4 shadow-soft",
              "backdrop-blur",
              "motion-safe:animate-fadeIn"
            )}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sophia-text">
                <Bug className="h-4 w-4 text-sophia-purple" />
                <span className="text-sm font-semibold">Diagnostics</span>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg p-1 text-sophia-text2 hover:bg-sophia-surface-alt"
                aria-label="Collapse diagnostics"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-3 space-y-2 text-xs">
              {details.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-3">
                  <span className="text-sophia-text2">{item.label}</span>
                  <span className="max-w-[180px] truncate text-sophia-text" title={String(item.value ?? "")}> 
                    {item.value ?? "—"}
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
                    showToast({ message: "Debug snapshot copied", variant: "success", durationMs: 1800 });
                  } catch {
                    showToast({ message: "Could not copy snapshot", variant: "error", durationMs: 1800 });
                  }
                }}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium",
                  "bg-sophia-purple/10 text-sophia-purple",
                  "hover:bg-sophia-purple/20 transition-all"
                )}
              >
                <Clipboard className="h-3.5 w-3.5" />
                Copy snapshot
              </button>
              <button
                type="button"
                onClick={() => {
                  clearLocalSessionData();
                  showToast({ message: "Local session cleared", variant: "warning", durationMs: 2000 });
                }}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium",
                  "bg-sophia-surface-alt text-sophia-text2",
                  "hover:bg-sophia-surface-border transition-all"
                )}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear local
              </button>
            </div>
          </div>
        )}

        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={cn(
              "flex items-center gap-2 rounded-full border border-sophia-surface-border bg-sophia-surface/90",
              "px-3 py-2 text-xs font-medium text-sophia-text2",
              "shadow-soft hover:border-sophia-purple/30 hover:text-sophia-text",
              "transition-all"
            )}
          >
            <Bug className="h-3.5 w-3.5 text-sophia-purple" />
            Debug
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
