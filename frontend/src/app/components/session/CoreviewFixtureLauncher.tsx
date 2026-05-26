"use client"

import { useState } from "react"
import { Eye, X } from "lucide-react"

import { useArtifactCoReview } from "../../hooks/useArtifactCoReview"
import type { CoReviewMediaTransport } from "../../lib/co-review-transport"
import { CoReviewControls } from "./CoReviewControls"
import { CoreviewFixtureArtifact, COREVIEW_FIXTURE_ARTIFACT_ID } from "./CoreviewFixtureArtifact"

interface CoreviewFixtureLauncherProps {
  isVisible: boolean
  sessionId?: string | null
  normalSessionId?: string | null
  threadId?: string | null
  coReviewTransport?: CoReviewMediaTransport
}

const LOCAL_FIXTURE_SESSION_ID = "local-coreview-fixture-session"
const LOCAL_FIXTURE_THREAD_ID = "local-coreview-fixture-thread"

export function CoreviewFixtureLauncher({
  isVisible,
  sessionId,
  normalSessionId,
  threadId,
  coReviewTransport,
}: CoreviewFixtureLauncherProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [fixtureRoot, setFixtureRoot] = useState<HTMLDivElement | null>(null)
  const fixtureSessionId = sessionId || LOCAL_FIXTURE_SESSION_ID
  const fixtureNormalSessionId = normalSessionId || fixtureSessionId
  const fixtureThreadId = threadId || LOCAL_FIXTURE_THREAD_ID
  const coReview = useArtifactCoReview({
    sessionId: fixtureSessionId,
    normalSessionId: fixtureNormalSessionId,
    threadId: fixtureThreadId,
    artifactId: COREVIEW_FIXTURE_ARTIFACT_ID,
    artifactRoot: fixtureRoot,
    featureEnabled: isVisible,
    transport: coReviewTransport,
  })

  if (!isVisible) return null

  return (
    <>
      <div
        className="fixed left-3 top-3 z-[9999] flex max-w-[260px] flex-col gap-1.5 rounded-lg border px-3 py-2 text-xs shadow-2xl"
        data-testid="coreview-fixture-root-launcher"
        style={{
          borderColor: "color-mix(in srgb, var(--sophia-purple) 36%, var(--cosmic-border-soft))",
          background: "color-mix(in srgb, var(--cosmic-panel) 96%, black 10%)",
          color: "var(--cosmic-text-strong)",
        }}
      >
        <button
          type="button"
          aria-label="Open Coreview Fixture"
          onClick={() => setIsOpen(true)}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-2.5 font-medium transition hover:bg-white/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
          style={{
            borderColor: "color-mix(in srgb, var(--sophia-purple) 30%, var(--cosmic-border-soft))",
            background: "color-mix(in srgb, var(--sophia-purple) 12%, transparent)",
          }}
        >
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Open Coreview Fixture</span>
        </button>
        <p style={{ color: "var(--cosmic-text-muted)" }}>Coreview fixture flag: on</p>
        <p style={{ color: "var(--cosmic-text-muted)" }}>Still frame flag: on</p>
      </div>

      {isOpen ? (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center px-4 py-6"
          role="dialog"
          aria-label="Coreview fixture"
          style={{
            background: "rgba(4, 3, 10, 0.72)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
          }}
        >
          <div
            className="relative w-full max-w-[520px] rounded-xl border p-4 shadow-2xl"
            style={{
              borderColor: "color-mix(in srgb, var(--sophia-purple) 28%, var(--cosmic-border-soft))",
              background: "color-mix(in srgb, var(--cosmic-panel) 96%, black 8%)",
            }}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p
                  className="text-[10px] uppercase tracking-[0.18em]"
                  style={{ color: "var(--cosmic-text-faint)" }}
                >
                  dev co-review fixture
                </p>
                <h2
                  className="font-cormorant text-[24px] leading-tight"
                  style={{ color: "var(--cosmic-text-strong)" }}
                >
                  Q3 Launch Review
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close Coreview Fixture"
                onClick={() => {
                  void coReview.stopReview()
                  setIsOpen(false)
                }}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border transition hover:bg-white/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
                style={{
                  borderColor: "var(--cosmic-border-soft)",
                  color: "var(--cosmic-text-muted)",
                }}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div ref={setFixtureRoot}>
              <CoreviewFixtureArtifact
                sessionId={fixtureSessionId}
                normalSessionId={fixtureNormalSessionId}
              />
            </div>

            <div className="mt-4 flex flex-col items-center gap-3">
              <CoReviewControls
                state={coReview.state}
                transportStatus={coReview.transportStatus}
                onStart={() => { void coReview.startReview() }}
                onStop={() => { void coReview.stopReview() }}
                canStart={coReview.canStart}
                featureEnabled={coReview.enabled}
                className="justify-center"
              />
              <div
                className="grid w-full gap-1 rounded-lg border px-3 py-2 text-[11px]"
                style={{
                  borderColor: "var(--cosmic-border-soft)",
                  color: "var(--cosmic-text-muted)",
                  background: "color-mix(in srgb, var(--cosmic-panel-soft) 72%, transparent)",
                }}
              >
                <DiagnosticRow label="artifact id" value={COREVIEW_FIXTURE_ARTIFACT_ID} />
                <DiagnosticRow label="session id" value={fixtureSessionId} />
                <DiagnosticRow label="thread id" value={fixtureThreadId} />
                <DiagnosticRow label="capture mode" value="still_frame" />
                <DiagnosticRow label="tool status" value={coReview.state.error ?? coReview.transportStatus.statusText} />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="uppercase tracking-[0.14em]">{label}</span>
      <span className="truncate text-right" style={{ color: "var(--cosmic-text-strong)" }}>
        {value}
      </span>
    </div>
  )
}
