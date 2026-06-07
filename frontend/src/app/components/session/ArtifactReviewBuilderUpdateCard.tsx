"use client"

import {
  CheckCircle2,
  Eye,
  RotateCcw,
  Sparkles,
  XCircle,
  type LucideIcon,
} from "lucide-react"

import { cn } from "../../lib/utils"

export type ArtifactReviewBuilderUpdateCardStatus =
  | "starting"
  | "updating"
  | "applying"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "preview_not_refreshed"
  | "failed"
  | "unsupported"

export type ArtifactReviewBuilderUpdateCardProps = {
  artifactTitle: string
  requestedChangeSummary: string
  status: ArtifactReviewBuilderUpdateCardStatus
  currentStep?: string | null
  unsupportedReason?: string | null
  cancellable?: boolean
  onCancel?: () => void
  cancelPending?: boolean
  outputTitle?: string | null
  outputPath?: string | null
  onViewUpdatedVersion?: () => void
  autoApplied?: boolean
  nonHtmlOutput?: boolean
  versionLabel?: string | null
  restoreAvailable?: boolean
  onRestoreOriginal?: () => void
  restorePending?: boolean
  className?: string
}

const STATUS_META: Record<ArtifactReviewBuilderUpdateCardStatus, {
  label: string
  tone: string
  icon: LucideIcon
}> = {
  starting: { label: "Sophia is updating this artifact…", tone: "var(--cosmic-amber)", icon: Sparkles },
  updating: { label: "Sophia is updating this artifact…", tone: "var(--sophia-purple)", icon: Sparkles },
  applying: { label: "Applying update...", tone: "var(--sophia-purple)", icon: Sparkles },
  cancelling: { label: "Cancelling", tone: "var(--cosmic-amber)", icon: RotateCcw },
  cancelled: { label: "Cancelled", tone: "var(--cosmic-text-faint)", icon: XCircle },
  completed: { label: "New version ready", tone: "var(--cosmic-teal)", icon: CheckCircle2 },
  preview_not_refreshed: { label: "Update built, but preview did not refresh.", tone: "var(--cosmic-amber)", icon: XCircle },
  failed: { label: "Failed", tone: "var(--sophia-error, #f87171)", icon: XCircle },
  unsupported: { label: "Unsupported", tone: "var(--cosmic-amber)", icon: XCircle },
}

export function ArtifactReviewBuilderUpdateCard({
  artifactTitle,
  requestedChangeSummary,
  status,
  currentStep,
  unsupportedReason,
  cancellable = false,
  onCancel,
  cancelPending = false,
  outputTitle,
  outputPath,
  onViewUpdatedVersion,
  autoApplied = false,
  nonHtmlOutput = false,
  versionLabel,
  restoreAvailable = false,
  onRestoreOriginal,
  restorePending = false,
  className,
}: ArtifactReviewBuilderUpdateCardProps) {
  const meta = status === "completed" && autoApplied
    ? { ...STATUS_META.completed, label: "Preview updated" }
    : status === "completed" && nonHtmlOutput
      ? { ...STATUS_META.completed, label: "New artifact created" }
      : STATUS_META[status]
  const Icon = meta.icon
  const showViewUpdatedVersion = status === "completed" && !autoApplied && Boolean(outputPath && onViewUpdatedVersion)
  const showRestoreOriginal = status === "completed" && restoreAvailable && Boolean(onRestoreOriginal)
  const statusDetail = status === "completed" && autoApplied
    ? "Original preserved"
    : status === "completed" && nonHtmlOutput
      ? "A new artifact was created, but it is not an HTML update."
      : status === "preview_not_refreshed"
        ? "Original preserved"
      : status === "failed"
        ? "Couldn’t apply the update. Original preserved."
        : status === "applying"
          ? "Version built. Refreshing preview..."
          : status === "starting" || status === "updating"
            ? "Applying changes…"
          : null

  return (
    <div
      role="status"
      aria-live={status === "updating" || status === "starting" || status === "applying" ? "polite" : "assertive"}
      data-testid="artifact-review-builder-update-card"
      data-coreview-builder-update-status={status}
      className={cn(
        "mb-2 rounded-lg border px-3 py-2.5 backdrop-blur-xl",
        "bg-[color-mix(in_srgb,var(--cosmic-panel)_88%,transparent)]",
        className,
      )}
      style={{
        borderColor: `color-mix(in srgb, ${meta.tone} 22%, var(--cosmic-border-soft))`,
        boxShadow: `0 12px 26px color-mix(in srgb, ${meta.tone} 8%, transparent)`,
      }}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <div
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border"
          style={{
            color: meta.tone,
            borderColor: `color-mix(in srgb, ${meta.tone} 28%, transparent)`,
            background: `color-mix(in srgb, ${meta.tone} 10%, transparent)`,
          }}
        >
          <Icon className={cn("h-3.5 w-3.5", (status === "starting" || status === "updating" || status === "applying") && "animate-pulse")} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className="text-[10px] font-medium tracking-[0.12em]"
              style={{ color: meta.tone }}
            >
              {meta.label}
            </span>
            <span
              className="max-w-full truncate text-[10px]"
              style={{ color: "var(--cosmic-text-faint)" }}
              title={artifactTitle}
            >
              {artifactTitle}
            </span>
          </div>
          <p
            className="mt-1 line-clamp-2 text-[11px] leading-5 [overflow-wrap:anywhere]"
            style={{ color: "var(--cosmic-text-strong)" }}
          >
            {requestedChangeSummary}
          </p>
          {statusDetail && (
            <p
              className="mt-1 text-[10px] font-medium"
              style={{ color: status === "failed" || status === "preview_not_refreshed" ? "var(--sophia-error, #f87171)" : "var(--cosmic-text-faint)" }}
            >
              {statusDetail}
            </p>
          )}
          {status === "completed" && autoApplied && versionLabel && (
            <p
              className="mt-1 text-[10px] font-medium"
              style={{ color: "var(--cosmic-teal)" }}
            >
              {versionLabel}
            </p>
          )}
          {currentStep && (
            <p
              className="mt-1 truncate text-[10px]"
              style={{ color: "var(--cosmic-text-faint)" }}
              title={currentStep}
            >
              {currentStep}
            </p>
          )}
          {status === "unsupported" && unsupportedReason && (
            <p
              className="mt-1 line-clamp-2 text-[10px] leading-4 [overflow-wrap:anywhere]"
              style={{ color: "var(--cosmic-text-faint)" }}
            >
              {unsupportedReason}
            </p>
          )}
          {(showViewUpdatedVersion || showRestoreOriginal) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {showRestoreOriginal && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[10px] font-medium tracking-[0.06em] transition-opacity hover:opacity-90 disabled:opacity-45"
                  style={{
                    borderColor: "color-mix(in srgb, var(--cosmic-border-soft) 90%, transparent)",
                    background: "color-mix(in srgb, var(--cosmic-panel-soft) 62%, transparent)",
                    color: "var(--cosmic-text-faint)",
                  }}
                  disabled={restorePending}
                  aria-label="Restore original artifact version"
                  onClick={onRestoreOriginal}
                >
                  <RotateCcw className="h-3 w-3" />
                  Restore original
                </button>
              )}
              {showViewUpdatedVersion && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[10px] font-medium tracking-[0.06em] transition-opacity hover:opacity-90"
                  style={{
                    borderColor: "color-mix(in srgb, var(--cosmic-teal) 35%, transparent)",
                    background: "color-mix(in srgb, var(--cosmic-teal) 12%, transparent)",
                    color: "var(--cosmic-teal)",
                  }}
                  aria-label={`${nonHtmlOutput ? "Open artifact" : "View updated version"}${outputTitle ? ` of ${outputTitle}` : ""}`}
                  onClick={onViewUpdatedVersion}
                >
                  <Eye className="h-3 w-3" />
                  {nonHtmlOutput ? "Open artifact" : "View updated version"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {cancellable && onCancel && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelPending}
            className="rounded-md border px-2.5 py-1 text-[10px] font-medium tracking-[0.06em] transition-opacity hover:opacity-90 disabled:opacity-45"
            style={{
              borderColor: "color-mix(in srgb, var(--cosmic-border-soft) 90%, transparent)",
              color: "var(--cosmic-text-faint)",
              background: "color-mix(in srgb, var(--cosmic-panel-soft) 64%, transparent)",
            }}
          >
            {cancelPending ? "Cancelling" : "Cancel update"}
          </button>
        </div>
      )}
    </div>
  )
}
