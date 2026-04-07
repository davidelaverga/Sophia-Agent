"use client"

import {
  ArrowLeft,
  History,
  Brain,
  RefreshCw,
  Target,
  Wind,
  MessageCircle,
  BookOpen,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, useMemo, useCallback } from "react"

import { haptic } from "../hooks/useHaptics"
import { humanizeTime } from "../lib/humanize-time"
import type { PresetType } from "../lib/session-types"
import {
  useConversationStore,
  selectIsLoadingConversation,
} from "../stores/conversation-store"
import { useRecapStore } from "../stores/recap-store"
import { useSessionHistoryStore, type SessionHistoryEntry } from "../stores/session-history-store"
import { useUiStore } from "../stores/ui-store"

// ─── Tab definitions ──────────────────────────────────────────────────────────

type HistoryTab = "sessions" | "memories"

const PRESET_LABELS: Record<PresetType, string> = {
  prepare: "Pre-game",
  debrief: "Post-game",
  reset: "Reset",
  vent: "Vent",
  open: "Chat",
  chat: "Chat",
}

const PRESET_ICONS: Record<PresetType, typeof Target> = {
  prepare: Target,
  debrief: MessageCircle,
  reset: RefreshCw,
  vent: Wind,
  open: MessageCircle,
  chat: MessageCircle,
}

const MEMORY_CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  identity: { bg: "bg-sophia-purple/12", text: "text-sophia-purple" },
  goals: { bg: "bg-sophia-accent/12", text: "text-sophia-accent" },
  emotions: { bg: "bg-sophia-warning/12", text: "text-sophia-warning" },
  relationships: { bg: "bg-sophia-purple/8", text: "text-sophia-text" },
  preferences: { bg: "bg-sophia-surface/60", text: "text-sophia-text2" },
  wins: { bg: "bg-sophia-accent/10", text: "text-sophia-accent" },
}

const CONTEXT_MODE_BADGE: Record<string, string> = {
  gaming: "bg-sophia-accent/12 text-sophia-accent",
  work: "bg-sophia-purple/12 text-sophia-purple",
}

// ─── Page Component ───────────────────────────────────────────────────────────

export default function HistoryPage() {
  const router = useRouter()
  const showToast = useUiStore((s) => s.showToast)

  const [activeTab, setActiveTab] = useState<HistoryTab>("sessions")

  // ── Conversation loader (for session playback) ──
  const isLoadingConversation = useConversationStore(selectIsLoadingConversation)
  const loadConversationAction = useConversationStore((s) => s.loadConversation)

  // ── Session history  ──
  const sessions = useSessionHistoryStore((s) => s.sessions)

  // ── Recap store for memories ──
  const recapArtifacts = useRecapStore((s) => s.artifacts)
  const recapDecisions = useRecapStore((s) => s.decisions)

  // ── Handlers ──

  const handleBack = useCallback(() => {
    router.back()
  }, [router])

  const handleSessionClick = useCallback(
    async (session: SessionHistoryEntry) => {
      haptic("light")
      const success = await loadConversationAction(session.sessionId, "backend")
      if (success) {
        router.push("/session")
      } else {
        showToast({ message: "Couldn't open that session.", variant: "warning", durationMs: 3200 })
      }
    },
    [loadConversationAction, router, showToast],
  )

  const handleViewRecap = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation()
      haptic("light")
      router.push(`/recap/${sessionId}`)
    },
    [router],
  )

  // ── Memories data (collected from recap artifacts + sessions) ──
  const memoriesTimeline = useMemo(() => {
    const entries: Array<{
      sessionId: string
      presetType: PresetType
      contextMode: string
      endedAt: string
      memories: Array<{
        id: string
        text: string
        category?: string
        decision?: string
      }>
    }> = []

    for (const session of sessions) {
      const artifacts = recapArtifacts[session.sessionId]
      const decisions = recapDecisions[session.sessionId] || []

      // Only include sessions that have approved/committed memories
      const approvedMemories = (artifacts?.memoryCandidates || [])
        .map((m) => {
          const d = decisions.find((dec) => dec.candidateId === m.id)
          return { ...m, decision: d?.decision || d?.status }
        })
        .filter((m) => m.decision === "approved" || m.decision === "edited" || m.decision === "committed")

      if (approvedMemories.length > 0) {
        entries.push({
          sessionId: session.sessionId,
          presetType: session.presetType,
          contextMode: session.contextMode,
          endedAt: session.endedAt,
          memories: approvedMemories.map((m) => ({
            id: m.id,
            text: m.text,
            category: m.category,
            decision: m.decision,
          })),
        })
      }
    }

    // Also check recap artifacts that may not have a matching session-history entry
    for (const [sessionId, artifacts] of Object.entries(recapArtifacts)) {
      if (entries.some((e) => e.sessionId === sessionId)) continue
      const decisions = recapDecisions[sessionId] || []
      const approvedMemories = (artifacts.memoryCandidates || [])
        .map((m) => {
          const d = decisions.find((dec) => dec.candidateId === m.id)
          return { ...m, decision: d?.decision || d?.status }
        })
        .filter((m) => m.decision === "approved" || m.decision === "edited" || m.decision === "committed")

      if (approvedMemories.length > 0) {
        entries.push({
          sessionId,
          presetType: artifacts.sessionType,
          contextMode: artifacts.contextMode,
          endedAt: artifacts.endedAt || "",
          memories: approvedMemories.map((m) => ({
            id: m.id,
            text: m.text,
            category: m.category,
            decision: m.decision,
          })),
        })
      }
    }

    // Sort newest first
    return entries.sort((a, b) => new Date(b.endedAt).getTime() - new Date(a.endedAt).getTime())
  }, [sessions, recapArtifacts, recapDecisions])

  // ── Tab counts ──
  const counts = useMemo(
    () => ({
      sessions: sessions.length,
      memories: memoriesTimeline.reduce((sum, e) => sum + e.memories.length, 0),
    }),
    [sessions, memoriesTimeline],
  )

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-dvh bg-sophia-bg flex flex-col">
      {/* ── Sticky Header ── */}
      <header className="sticky top-0 z-30 bg-sophia-bg/90 backdrop-blur-lg border-b border-sophia-surface-border">
        <div className="max-w-2xl mx-auto flex items-center gap-3 px-4 py-3">
          <button
            onClick={handleBack}
            className="p-2 -ml-2 rounded-xl hover:bg-sophia-surface/60 transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft className="w-5 h-5 text-sophia-text2" />
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-semibold text-sophia-text">History</h1>
            <p className="text-xs text-sophia-text2/60">Your sessions & memories</p>
          </div>
        </div>

        {/* ── Tab bar ── */}
        <div className="max-w-2xl mx-auto px-4 pb-3">
          <div className="flex gap-1 p-1 rounded-xl bg-sophia-surface/40 border border-sophia-surface-border">
            {(
              [
                { key: "sessions", icon: History, label: "Sessions" },
                { key: "memories", icon: Brain, label: "Memories" },
              ] as const
            ).map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                onClick={() => {
                  haptic("selection")
                  setActiveTab(key)
                }}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg text-xs font-medium transition-all ${
                  activeTab === key
                    ? "bg-sophia-purple text-sophia-bg shadow-lg shadow-sophia-purple/20"
                    : "text-sophia-text2 hover:text-sophia-text hover:bg-sophia-surface/50"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
                {counts[key] > 0 && (
                  <span
                    className={`ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                      activeTab === key ? "bg-sophia-bg/20" : "bg-sophia-purple/15 text-sophia-purple"
                    }`}
                  >
                    {counts[key]}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* ── Loading indicator ── */}
      {isLoadingConversation && (
        <div className="max-w-2xl mx-auto w-full px-4 mt-3">
          <div className="px-4 py-2.5 bg-sophia-purple/10 border border-sophia-purple/20 rounded-xl text-sophia-purple text-xs flex items-center gap-2">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            <span>Loading session…</span>
          </div>
        </div>
      )}

      {/* ── Content ── */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-4">
          {/* ─── Sessions Tab ─── */}
          {activeTab === "sessions" && (
            <SessionsTab sessions={sessions} onSessionClick={handleSessionClick} />
          )}

          {/* ─── Memories Tab ─── */}
          {activeTab === "memories" && (
            <MemoriesTimeline timeline={memoriesTimeline} onViewRecap={handleViewRecap} />
          )}
        </div>
      </main>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Sessions Tab ─────────────────────────────────────────────────────────────

function SessionsTab({
  sessions,
  onSessionClick,
}: {
  sessions: SessionHistoryEntry[]
  onSessionClick: (s: SessionHistoryEntry) => void
}) {
  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="w-14 h-14 rounded-2xl bg-sophia-surface/50 border border-sophia-surface-border flex items-center justify-center mb-4">
          <History className="w-6 h-6 text-sophia-text2/40" />
        </div>
        <p className="text-sm font-medium text-sophia-text">No sessions yet</p>
        <p className="text-xs text-sophia-text2/60 mt-1.5">Complete a session to see it here</p>
      </div>
    )
  }

  // Group sessions by date
  const grouped = groupSessionsByDate(sessions)

  return (
    <div className="space-y-6">
      {grouped.map(({ label, items }) => (
        <div key={label}>
          <h3 className="text-xs font-semibold text-sophia-text2/50 uppercase tracking-wider mb-3 px-1">
            {label}
          </h3>
          <div className="space-y-4">
            {items.map((session) => {
              const Icon = PRESET_ICONS[session.presetType]
              const presetLabel = PRESET_LABELS[session.presetType]
              const timeAgo = humanizeTime(session.endedAt)

              return (
                <button
                  key={session.sessionId}
                  onClick={() => onSessionClick(session)}
                  className={`
                    w-full rounded-2xl text-left transition-all duration-200 group/s
                    border border-sophia-surface-border p-4
                    bg-sophia-surface/70 shadow-soft
                    hover:border-sophia-purple/30 hover:bg-sophia-surface hover:shadow-md hover:-translate-y-0.5
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple focus-visible:ring-inset
                    ${!session.recapViewed ? "ring-1 ring-sophia-purple/20" : ""}
                  `}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`
                      w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors
                      ${!session.recapViewed ? "bg-sophia-purple/15" : "bg-sophia-surface-border/40 group-hover/s:bg-sophia-purple/10"}
                    `}
                    >
                      <Icon
                        className={`w-4 h-4 transition-colors ${
                          !session.recapViewed
                            ? "text-sophia-purple"
                            : "text-sophia-text2/70 group-hover/s:text-sophia-purple"
                        }`}
                      />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-sophia-text">{presetLabel}</span>
                        <span
                          className={`text-[10px] capitalize px-1.5 py-0.5 rounded-full ${
                            CONTEXT_MODE_BADGE[session.contextMode] || "bg-sophia-surface/70 text-sophia-text2"
                          }`}
                        >
                          {session.contextMode}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 mt-1">
                        <span className="text-[11px] text-sophia-text2/50" title={timeAgo.tooltip}>
                          {timeAgo.text}
                        </span>
                        {session.messageCount > 0 && (
                          <>
                            <span className="text-sophia-text2/30">·</span>
                            <span className="text-[11px] text-sophia-text2/50">
                              {session.messageCount} msgs
                            </span>
                          </>
                        )}
                      </div>

                      {session.takeawayPreview && (
                        <p className="text-[12px] text-sophia-text2/70 mt-2 line-clamp-2">
                          {session.takeawayPreview}
                        </p>
                      )}

                      <div className="flex items-center gap-2 mt-2">
                        {!session.recapViewed && (
                          <span className="text-[9px] font-medium text-sophia-purple bg-sophia-purple/10 px-1.5 py-0.5 rounded-full">
                            NEW
                          </span>
                        )}
                        {session.memoriesApproved && (
                          <span className="text-[9px] font-medium text-sophia-accent bg-sophia-accent/12 px-1.5 py-0.5 rounded-full">
                            ✓ Memories saved
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Memories Timeline ────────────────────────────────────────────────────────

function MemoriesTimeline({
  timeline,
  onViewRecap,
}: {
  timeline: Array<{
    sessionId: string
    presetType: PresetType
    contextMode: string
    endedAt: string
    memories: Array<{
      id: string
      text: string
      category?: string
      decision?: string
    }>
  }>
  onViewRecap: (e: React.MouseEvent, sessionId: string) => void
}) {
  if (timeline.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="w-14 h-14 rounded-2xl bg-sophia-surface/50 border border-sophia-surface-border flex items-center justify-center mb-4">
          <Brain className="w-6 h-6 text-sophia-text2/40" />
        </div>
        <p className="text-sm font-medium text-sophia-text">No memories yet</p>
        <p className="text-xs text-sophia-text2/60 mt-1.5 text-center max-w-[260px]">
          Sophia will remember what matters after each session. Approve memories in your recap.
        </p>
      </div>
    )
  }

  return (
    <div className="relative">
      {/* Timeline line */}
      <div className="absolute left-[18px] top-4 bottom-4 w-px bg-sophia-surface-border" />

      <div className="space-y-0">
        {timeline.map((entry) => {
          const presetLabel = PRESET_LABELS[entry.presetType]
          const timeAgo = humanizeTime(entry.endedAt)

          return (
            <div key={entry.sessionId} className="relative pl-11 pb-8 last:pb-0">
              {/* Timeline dot */}
              <div className="absolute left-2.5 top-1 w-[13px] h-[13px] rounded-full border-2 border-sophia-purple bg-sophia-bg z-10" />

              {/* Session header */}
              <div className="flex items-center gap-2 mb-2.5">
                <span className="text-xs font-semibold text-sophia-text">{presetLabel}</span>
                <span
                  className={`text-[10px] capitalize px-1.5 py-0.5 rounded-full ${
                    CONTEXT_MODE_BADGE[entry.contextMode] || "bg-sophia-surface/70 text-sophia-text2"
                  }`}
                >
                  {entry.contextMode}
                </span>
                <span className="text-[10px] text-sophia-text2/40 ml-auto" title={timeAgo.tooltip}>
                  {timeAgo.text}
                </span>
              </div>

              {/* Memory chips */}
              {entry.memories.length > 0 && (
                <div className="space-y-1.5">
                  {entry.memories.map((m) => {
                    const catColor = MEMORY_CATEGORY_COLORS[m.category || ""] || {
                      bg: "bg-sophia-surface/50",
                      text: "text-sophia-text2",
                    }
                    return (
                      <div
                        key={m.id}
                        className="flex items-start gap-2.5 p-2.5 rounded-lg bg-sophia-bg/40 border border-sophia-surface-border"
                      >
                        <Brain className="w-3.5 h-3.5 text-sophia-purple/60 mt-0.5 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-[12px] text-sophia-text leading-relaxed">{m.text}</p>
                          {m.category && (
                            <span
                              className={`inline-block mt-1.5 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${catColor.bg} ${catColor.text}`}
                            >
                              {m.category}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* View recap link */}
              <button
                onClick={(e) => onViewRecap(e, entry.sessionId)}
                className="mt-2.5 text-[11px] text-sophia-purple/70 hover:text-sophia-purple font-medium flex items-center gap-1 transition-colors"
              >
                <BookOpen className="w-3 h-3" />
                View full recap
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function groupSessionsByDate(sessions: SessionHistoryEntry[]) {
  const groups: { label: string; items: SessionHistoryEntry[] }[] = []
  const now = new Date()
  const todayStr = now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = yesterday.toDateString()

  const buckets: Record<string, SessionHistoryEntry[]> = {}

  for (const s of sessions) {
    const d = new Date(s.endedAt)
    const ds = d.toDateString()
    let label: string

    if (ds === todayStr) {
      label = "Today"
    } else if (ds === yesterdayStr) {
      label = "Yesterday"
    } else {
      // Week label
      const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000)
      if (diffDays < 7) {
        label = "This week"
      } else if (diffDays < 30) {
        label = "This month"
      } else {
        label = d.toLocaleDateString("en-US", { month: "long", year: "numeric" })
      }
    }

    if (!buckets[label]) buckets[label] = []
    buckets[label].push(s)
  }

  // Keep chronological order of labels as they appear  
  const seen = new Set<string>()
  for (const s of sessions) {
    const d = new Date(s.endedAt)
    const ds = d.toDateString()
    let label: string

    if (ds === todayStr) label = "Today"
    else if (ds === yesterdayStr) label = "Yesterday"
    else {
      const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000)
      if (diffDays < 7) label = "This week"
      else if (diffDays < 30) label = "This month"
      else label = d.toLocaleDateString("en-US", { month: "long", year: "numeric" })
    }

    if (!seen.has(label)) {
      seen.add(label)
      groups.push({ label, items: buckets[label] })
    }
  }

  return groups
}
