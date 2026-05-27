'use client'

import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Brain,
  CheckCircle,
  Copy,
  Download,
  MessageCircle,
  RotateCcw,
  Shield,
  Sparkles,
  Target,
} from 'lucide-react'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'

import { cn } from '@/app/lib/utils'

import {
  buildRunRecordMarkdownSummary,
  buildRunRecordPayload,
  computeOverallScore,
  createDefaultRunRecorderDraft,
  createRunRecordDownloadFilename,
  DOGFOOD_RUN_RECORDER_STORAGE_KEY,
  getProviderConfig,
  mergeStoredRunRecorderDraft,
  PROVIDERS,
  SCENARIOS,
  SCORE_FIELDS,
  type ProviderId,
  type Recommendation,
  type RunRecorderDraft,
  type ScenarioId,
  type ScoreKey,
  type TriState,
} from './run-recorder'

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
type FeedbackState = { tone: Tone; message: string } | null

const INTERNAL_DOGFOOD_ENABLED = process.env.NODE_ENV !== 'production'

export default function RealtimeDogfoodPage() {
  const [draft, setDraft] = useState<RunRecorderDraft>(() => createDefaultRunRecorderDraft())
  const [feedback, setFeedback] = useState<FeedbackState>(null)
  const [hasLoadedDraft, setHasLoadedDraft] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    try {
      const stored = window.localStorage.getItem(DOGFOOD_RUN_RECORDER_STORAGE_KEY)
      if (stored) {
        setDraft(mergeStoredRunRecorderDraft(JSON.parse(stored)))
      }
    } catch {
      setFeedback({ tone: 'warning', message: 'Saved draft could not be restored. A fresh recorder state was loaded instead.' })
    } finally {
      setHasLoadedDraft(true)
    }
  }, [])

  useEffect(() => {
    if (!hasLoadedDraft || typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem(DOGFOOD_RUN_RECORDER_STORAGE_KEY, JSON.stringify(draft))
  }, [draft, hasLoadedDraft])

  const selectedProvider = getProviderConfig(draft.provider)
  const overallScore = useMemo(() => computeOverallScore(draft.scores), [draft.scores])
  const executedScenarioCount = useMemo(
    () => SCENARIOS.filter((scenario) => draft.scenarios[scenario.id].executed).length,
    [draft.scenarios],
  )

  const updateDraft = <Key extends keyof RunRecorderDraft>(key: Key, value: RunRecorderDraft[Key]) => {
    setDraft((current) => ({
      ...current,
      [key]: value,
    }))
  }

  const updateEventHealth = <Key extends keyof RunRecorderDraft['eventHealth']>(
    key: Key,
    value: RunRecorderDraft['eventHealth'][Key],
  ) => {
    setDraft((current) => ({
      ...current,
      eventHealth: {
        ...current.eventHealth,
        [key]: value,
      },
    }))
  }

  const updateTransportHealth = <Key extends keyof RunRecorderDraft['transportHealth']>(
    key: Key,
    value: RunRecorderDraft['transportHealth'][Key],
  ) => {
    setDraft((current) => ({
      ...current,
      transportHealth: {
        ...current.transportHealth,
        [key]: value,
      },
    }))
  }

  const updateScenario = (scenarioId: ScenarioId, nextScenario: Partial<RunRecorderDraft['scenarios'][ScenarioId]>) => {
    setDraft((current) => ({
      ...current,
      scenarios: {
        ...current.scenarios,
        [scenarioId]: {
          ...current.scenarios[scenarioId],
          ...nextScenario,
        },
      },
    }))
  }

  const updateScore = (key: ScoreKey, value: number) => {
    setDraft((current) => ({
      ...current,
      scores: {
        ...current.scores,
        [key]: value,
      },
    }))
  }

  const handleDownloadJson = () => {
    if (typeof document === 'undefined') {
      setFeedback({ tone: 'danger', message: 'The JSON export helper is unavailable in this environment.' })
      return
    }

    try {
      const payload = buildRunRecordPayload(draft)
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const href = URL.createObjectURL(blob)
      const anchor = document.createElement('a')

      anchor.href = href
      anchor.download = createRunRecordDownloadFilename(draft)
      anchor.click()
      URL.revokeObjectURL(href)
      setFeedback({ tone: 'success', message: 'Run record JSON exported.' })
    } catch {
      setFeedback({ tone: 'danger', message: 'The JSON export failed before the run record could be downloaded.' })
    }
  }

  const handleCopySummary = async () => {
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
      setFeedback({ tone: 'danger', message: 'Clipboard access is unavailable. Use the JSON export instead.' })
      return
    }

    try {
      await navigator.clipboard.writeText(buildRunRecordMarkdownSummary(draft))
      setFeedback({ tone: 'success', message: 'Markdown summary copied.' })
    } catch {
      setFeedback({ tone: 'danger', message: 'The summary could not be copied to the clipboard.' })
    }
  }

  const handleResetDraft = () => {
    const nextDraft = createDefaultRunRecorderDraft()
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(DOGFOOD_RUN_RECORDER_STORAGE_KEY)
    }
    setDraft(nextDraft)
    setFeedback({ tone: 'warning', message: 'Recorder draft reset to its default state.' })
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(124,92,170,0.16),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(47,126,145,0.14),_transparent_38%),linear-gradient(180deg,var(--bg)_0%,rgba(236,240,246,0.86)_100%)] text-sophia-text">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
        <SectionCard className="overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(124,92,170,0.18),_transparent_34%),radial-gradient(circle_at_bottom_left,_rgba(47,126,145,0.12),_transparent_40%)]" aria-hidden="true" />
          <div className="relative flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill label="Internal comparative hub" tone="warning" />
                <StatusPill label="Experimental only" tone="danger" />
                <StatusPill label="No production voice changes" tone="accent" />
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-semibold tracking-tight text-sophia-text">Realtime Provider Dogfood</h1>
                <p className="max-w-3xl text-sm leading-6 text-sophia-text2 sm:text-base">
                  Internal comparison hub for the already-complete OpenAI and Gemini realtime dogfood pages. Use this
                  route to launch the provider pages, run the same Phase 9 scenarios for both transports, and export a
                  structured manual run record without adding backend persistence.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:min-w-[280px]">
              <MiniStatus label="Selected provider" value={selectedProvider.label} tone="accent" />
              <MiniStatus label="Executed scenarios" value={`${executedScenarioCount}/${SCENARIOS.length}`} tone={executedScenarioCount > 0 ? 'success' : 'neutral'} />
              <MiniStatus label="Overall score" value={`${overallScore.toFixed(1)}/5`} tone={overallScore >= 4 ? 'success' : overallScore >= 3 ? 'accent' : 'warning'} />
            </div>
          </div>
        </SectionCard>

        {!INTERNAL_DOGFOOD_ENABLED && (
          <AlertCard
            title="Internal debug context only"
            message="This comparison hub is intended for local or approved internal environments. It records manual dogfood evidence only and does not expose a production runtime path."
          />
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {PROVIDERS.map((provider) => (
            <SectionCard key={provider.id}>
              <SectionHeader
                icon={provider.id === 'openai_realtime' ? Sparkles : Brain}
                title={provider.label}
                description={provider.description}
                accentClassName={provider.accentClassName}
              />

              <div className="mt-5 space-y-4">
                <DetailBlock label="Transport distinction" value={provider.shortTransport} tone="accent" />
                <p className="text-sm leading-6 text-sophia-text2">
                  {provider.id === 'openai_realtime'
                    ? 'OpenAI uses browser WebRTC plus a trusted backend sideband attached to the rtc_* call id.'
                    : 'Gemini uses a browser-owned Live WebSocket plus a backend relay for documented server messages.'}
                </p>
                <Link
                  href={provider.route}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-medium transition-all',
                    provider.id === 'openai_realtime'
                      ? 'bg-sophia-purple text-white hover:scale-[1.01] hover:shadow-lg'
                      : 'bg-[#2f7e91] text-white hover:scale-[1.01] hover:shadow-lg',
                  )}
                >
                  {provider.id === 'openai_realtime' ? 'Open OpenAI dogfood' : 'Open Gemini dogfood'}
                  <ArrowUpRight className="h-4 w-4" />
                </Link>
              </div>
            </SectionCard>
          ))}
        </div>

        <SectionCard>
          <SectionHeader
            icon={BookOpen}
            title="Comparison note"
            description="Run the same scenario matrix for both providers before judging them."
          />

          <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-start">
            <div className="space-y-3 text-sm leading-6 text-sophia-text2">
              <p>Run the same scenarios for OpenAI and Gemini in the same order whenever possible. Do not score a provider from memory or from a different network, prompt, or interruption pattern.</p>
              <p>The manual protocol stays in docs/testing/sophia-realtime-comparative-dogfood-phase-9.md. This page is only the launcher and manual recorder on top of that protocol.</p>
            </div>
            <div className="rounded-3xl border border-sophia-surface-border bg-sophia-bg/60 px-4 py-3 text-xs text-sophia-text2">
              <div className="font-semibold uppercase tracking-[0.18em] text-sophia-text2/75">Protocol path</div>
              <div className="mt-2 font-mono text-[11px] text-sophia-text">docs/testing/sophia-realtime-comparative-dogfood-phase-9.md</div>
            </div>
          </div>
        </SectionCard>

        <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="grid gap-6">
            <SectionCard>
              <SectionHeader
                icon={MessageCircle}
                title="Run recorder"
                description="Record one provider run at a time, then export JSON and copy a compact Markdown summary."
              />

              <fieldset className="mt-5 space-y-4">
                <legend className="text-sm font-medium text-sophia-text">Provider under review</legend>
                <div className="grid gap-3 md:grid-cols-2">
                  {PROVIDERS.map((provider) => {
                    const checked = draft.provider === provider.id

                    return (
                      <label
                        key={provider.id}
                        className={cn(
                          'flex cursor-pointer items-start gap-3 rounded-3xl border px-4 py-4 transition-colors',
                          checked
                            ? 'border-sophia-purple/45 bg-sophia-surface shadow-soft'
                            : 'border-sophia-surface-border bg-sophia-bg/60 hover:border-sophia-purple/25',
                        )}
                      >
                        <input
                          type="radio"
                          name="provider"
                          value={provider.id}
                          checked={checked}
                          onChange={() => updateDraft('provider', provider.id as ProviderId)}
                          className="mt-1 h-4 w-4"
                        />
                        <div className="space-y-1">
                          <div className="text-sm font-medium text-sophia-text">{provider.label}</div>
                          <div className="text-xs text-sophia-text2">{provider.shortTransport}</div>
                        </div>
                      </label>
                    )
                  })}
                </div>
              </fieldset>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <TextField
                  label="Tester"
                  value={draft.tester}
                  onChange={(value) => updateDraft('tester', value)}
                  placeholder="Edward"
                />
                <TextField
                  label="Date / time"
                  type="datetime-local"
                  value={draft.recordedAtLocal}
                  onChange={(value) => updateDraft('recordedAtLocal', value)}
                />
                <TextField
                  label="Branch"
                  value={draft.branch}
                  onChange={(value) => updateDraft('branch', value)}
                  placeholder="feat/realtime-comparative-launcher-phase-9-7-hub"
                />
                <TextField
                  label="Model"
                  value={draft.model}
                  onChange={(value) => updateDraft('model', value)}
                  placeholder={draft.provider === 'openai_realtime' ? 'gpt-realtime-2' : 'gemini-3.1-flash-live-preview'}
                />
                <TextField
                  label="Session id"
                  value={draft.sessionId}
                  onChange={(value) => updateDraft('sessionId', value)}
                  placeholder="browser-openai-1"
                />
                <TextField
                  label="User id"
                  value={draft.userId}
                  onChange={(value) => updateDraft('userId', value)}
                  placeholder="dev-user"
                />
                <TextField
                  label="Browser / device"
                  value={draft.device}
                  onChange={(value) => updateDraft('device', value)}
                  placeholder="Chrome 136 on macOS"
                />
                <TextField
                  label="Network"
                  value={draft.network}
                  onChange={(value) => updateDraft('network', value)}
                  placeholder="Home Wi-Fi"
                />
              </div>

              <div className="mt-6 grid gap-3 lg:grid-cols-2">
                <DetailBlock label="Runtime mode" value={selectedProvider.runtimeMode} tone="accent" mono />
                <DetailBlock label="Transport type" value={selectedProvider.transportType} tone="accent" mono />
              </div>

              <div className="mt-6">
                <TextAreaField
                  label="Run notes"
                  value={draft.notes}
                  onChange={(value) => updateDraft('notes', value)}
                  rows={4}
                  placeholder="Record the strongest impression, the main failure, or anything that should appear in the copied summary."
                />
              </div>
            </SectionCard>

            <SectionCard>
              <SectionHeader
                icon={BookOpen}
                title="Scenario matrix"
                description="Track S01-S15 with a checkbox per scenario and a compact note field when something matters."
              />

              <div className="mt-5 grid gap-3 lg:grid-cols-2">
                {SCENARIOS.map((scenario) => {
                  const scenarioDraft = draft.scenarios[scenario.id]

                  return (
                    <div key={scenario.id} className="rounded-3xl border border-sophia-surface-border bg-sophia-bg/60 p-4">
                      <label className="flex items-start gap-3 text-sm text-sophia-text">
                        <input
                          type="checkbox"
                          checked={scenarioDraft.executed}
                          onChange={(event) => updateScenario(scenario.id, { executed: event.target.checked })}
                          className="mt-1 h-4 w-4"
                        />
                        <span>
                          <span className="font-medium">{scenario.id}</span>
                          <span className="text-sophia-text2">{' · '}{scenario.title}</span>
                        </span>
                      </label>

                      {(scenarioDraft.executed || scenarioDraft.notes.length > 0) && (
                        <div className="mt-4">
                          <TextAreaField
                            label={`Notes for ${scenario.id}`}
                            value={scenarioDraft.notes}
                            onChange={(value) => updateScenario(scenario.id, { notes: value })}
                            rows={3}
                            placeholder="Capture the key latency, transcript, audio, event, or failure note for this scenario."
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </SectionCard>

            <SectionCard>
              <SectionHeader
                icon={Target}
                title="Scorecard"
                description="Use 1-5 for the Phase 9 rubric. Neutral defaults start at 3 so the export stays valid before you tune each category."
              />

              <div className="mt-5 grid gap-4 md:grid-cols-2">
                {SCORE_FIELDS.map((field) => (
                  <SelectField
                    key={field.key}
                    label={field.label}
                    value={String(draft.scores[field.key])}
                    onChange={(value) => updateScore(field.key, Number.parseInt(value, 10) || 3)}
                    options={[
                      { value: '1', label: '1' },
                      { value: '2', label: '2' },
                      { value: '3', label: '3' },
                      { value: '4', label: '4' },
                      { value: '5', label: '5' },
                    ]}
                  />
                ))}
              </div>
            </SectionCard>
          </div>

          <div className="grid gap-6 self-start">
            <SectionCard>
              <SectionHeader
                icon={CheckCircle}
                title="Event evidence"
                description="Capture the minimum schema-backed event health fields that keep the export aligned with the Phase 9 run record."
              />

              <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-1">
                <TextField
                  label="sophia.* event count"
                  type="number"
                  min="0"
                  value={draft.eventHealth.sophiaEventCount}
                  onChange={(value) => updateEventHealth('sophiaEventCount', value)}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <CheckboxField
                    label="agent_started observed"
                    checked={draft.eventHealth.agentStartedObserved}
                    onChange={(checked) => updateEventHealth('agentStartedObserved', checked)}
                  />
                  <CheckboxField
                    label="agent_ended observed"
                    checked={draft.eventHealth.agentEndedObserved}
                    onChange={(checked) => updateEventHealth('agentEndedObserved', checked)}
                  />
                  <CheckboxField
                    label="Final transcript observed"
                    checked={draft.eventHealth.finalTranscriptObserved}
                    onChange={(checked) => updateEventHealth('finalTranscriptObserved', checked)}
                  />
                  <CheckboxField
                    label="Artifact observed"
                    checked={draft.eventHealth.artifactObserved}
                    onChange={(checked) => updateEventHealth('artifactObserved', checked)}
                  />
                </div>
                <SelectField
                  label="Builder task observed"
                  value={draft.eventHealth.builderTaskObserved}
                  onChange={(value) => updateEventHealth('builderTaskObserved', value as TriState)}
                  options={[
                    { value: 'n/a', label: 'n/a' },
                    { value: 'yes', label: 'yes' },
                    { value: 'no', label: 'no' },
                  ]}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label="Interruption markers"
                    type="number"
                    min="0"
                    value={draft.eventHealth.interruptionMarkers}
                    onChange={(value) => updateEventHealth('interruptionMarkers', value)}
                  />
                  <TextField
                    label="Provider error markers"
                    type="number"
                    min="0"
                    value={draft.eventHealth.providerErrorMarkers}
                    onChange={(value) => updateEventHealth('providerErrorMarkers', value)}
                  />
                </div>
                <TextAreaField
                  label="Provider event leaks"
                  value={draft.eventHealth.providerEventLeaks}
                  onChange={(value) => updateEventHealth('providerEventLeaks', value)}
                  rows={3}
                  placeholder="Leave blank for none, or list leaked provider event names separated by commas or new lines."
                />
                <TextAreaField
                  label="Missing required events"
                  value={draft.eventHealth.missingRequiredEvents}
                  onChange={(value) => updateEventHealth('missingRequiredEvents', value)}
                  rows={3}
                  placeholder="List missing lifecycle evidence such as sophia.artifact or agent_ended when relevant."
                />
              </div>
            </SectionCard>

            <SectionCard>
              <SectionHeader
                icon={Shield}
                title="Transport health"
                description="Record the provider-specific transport detail that should not be reconstructed from memory later."
              />

              <div className="mt-5 grid gap-4">
                {draft.provider === 'openai_realtime' ? (
                  <>
                    <SelectField
                      label="OpenAI sideband attached"
                      value={draft.transportHealth.openaiSidebandAttached}
                      onChange={(value) => updateTransportHealth('openaiSidebandAttached', value as TriState)}
                      options={[
                        { value: 'n/a', label: 'n/a' },
                        { value: 'yes', label: 'yes' },
                        { value: 'no', label: 'no' },
                      ]}
                    />
                    <TextField
                      label="OpenAI rtc_* call id"
                      value={draft.transportHealth.openaiCallId}
                      onChange={(value) => updateTransportHealth('openaiCallId', value)}
                      placeholder="rtc_frontend_1"
                    />
                  </>
                ) : (
                  <>
                    <SelectField
                      label="Gemini setupComplete observed"
                      value={draft.transportHealth.geminiSetupCompleteObserved}
                      onChange={(value) => updateTransportHealth('geminiSetupCompleteObserved', value as TriState)}
                      options={[
                        { value: 'n/a', label: 'n/a' },
                        { value: 'yes', label: 'yes' },
                        { value: 'no', label: 'no' },
                      ]}
                    />
                    <SelectField
                      label="Gemini relay receiving"
                      value={draft.transportHealth.geminiRelayReceiving}
                      onChange={(value) => updateTransportHealth('geminiRelayReceiving', value as TriState)}
                      options={[
                        { value: 'n/a', label: 'n/a' },
                        { value: 'yes', label: 'yes' },
                        { value: 'no', label: 'no' },
                      ]}
                    />
                  </>
                )}

                <TextAreaField
                  label="Transport notes"
                  value={draft.transportHealth.notes}
                  onChange={(value) => updateTransportHealth('notes', value)}
                  rows={3}
                  placeholder="Note relay, sideband, setup, or disconnect behavior that matters to the recommendation."
                />
              </div>
            </SectionCard>

            <SectionCard>
              <SectionHeader
                icon={Download}
                title="Recommendation and export"
                description="Export JSON, copy a compact Markdown summary, or reset the local draft."
              />

              <div className="mt-5 grid gap-4">
                <SelectField
                  label="Overall recommendation"
                  value={draft.recommendation}
                  onChange={(value) => updateDraft('recommendation', value as Recommendation)}
                  options={[
                    { value: 'pass', label: 'pass' },
                    { value: 'promising but needs fixes', label: 'promising but needs fixes' },
                    { value: 'block', label: 'block' },
                  ]}
                />

                <div className="grid gap-3 sm:grid-cols-2">
                  <MiniStatus label="Current provider" value={selectedProvider.label} tone="accent" />
                  <MiniStatus label="Overall score" value={`${overallScore.toFixed(1)}/5`} tone={overallScore >= 4 ? 'success' : overallScore >= 3 ? 'accent' : 'warning'} />
                </div>

                <div className="grid gap-3">
                  <button
                    type="button"
                    onClick={handleDownloadJson}
                    className="inline-flex items-center justify-center gap-2 rounded-2xl bg-sophia-purple px-4 py-3 text-sm font-medium text-white transition-all hover:scale-[1.01] hover:shadow-lg"
                  >
                    <Download className="h-4 w-4" />
                    Download JSON
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleCopySummary()}
                    className="inline-flex items-center justify-center gap-2 rounded-2xl border border-sophia-surface-border bg-sophia-button px-4 py-3 text-sm font-medium text-sophia-text transition-colors hover:border-sophia-purple/40 hover:bg-sophia-button-hover"
                  >
                    <Copy className="h-4 w-4" />
                    Copy Markdown summary
                  </button>

                  <button
                    type="button"
                    onClick={handleResetDraft}
                    className="inline-flex items-center justify-center gap-2 rounded-2xl border border-sophia-surface-border bg-sophia-bg/80 px-4 py-3 text-sm font-medium text-sophia-text transition-colors hover:border-amber-500/40 hover:bg-amber-500/8"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Reset draft
                  </button>
                </div>

                {feedback && (
                  <div className="rounded-3xl border border-sophia-surface-border bg-sophia-bg/60 px-4 py-3 text-sm text-sophia-text2">
                    <StatusPill label={feedback.tone === 'success' ? 'Ready' : feedback.tone === 'danger' ? 'Error' : 'Note'} tone={feedback.tone} />
                    <p className="mt-2 leading-6">{feedback.message}</p>
                  </div>
                )}

                <p className="text-xs leading-5 text-sophia-text2">
                  The draft restores from localStorage in this browser only. Export the run record immediately after each manual pass instead of reconstructing it later.
                </p>
              </div>
            </SectionCard>
          </div>
        </div>
      </main>
    </div>
  )
}

function SectionCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('relative rounded-[28px] border border-sophia-surface-border bg-sophia-surface/88 p-6 shadow-soft backdrop-blur', className)}>
      {children}
    </section>
  )
}

function SectionHeader({
  icon: Icon,
  title,
  description,
  accentClassName = 'bg-sophia-purple/12 text-sophia-purple',
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  accentClassName?: string
}) {
  return (
    <div className="flex items-start gap-3">
      <div className={cn('flex h-11 w-11 items-center justify-center rounded-2xl', accentClassName)}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-sophia-text">{title}</h2>
        <p className="text-sm text-sophia-text2">{description}</p>
      </div>
    </div>
  )
}

function AlertCard({ title, message }: { title: string; message: string }) {
  return (
    <SectionCard>
      <div role="alert" className="flex items-start gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-sophia-error/10 text-sophia-error">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-sophia-text">{title}</h2>
          <p className="text-sm leading-6 text-sophia-text2">{message}</p>
        </div>
      </div>
    </SectionCard>
  )
}

function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-3 py-1 text-xs font-medium',
        tone === 'success' && 'bg-emerald-500/12 text-emerald-700',
        tone === 'accent' && 'bg-sophia-purple/12 text-sophia-purple',
        tone === 'warning' && 'bg-amber-500/12 text-amber-700',
        tone === 'danger' && 'bg-rose-500/12 text-rose-700',
        tone === 'neutral' && 'bg-sophia-bg text-sophia-text2',
      )}
    >
      {label}
    </span>
  )
}

function MiniStatus({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="rounded-3xl border border-sophia-surface-border bg-sophia-bg/60 px-4 py-3">
      <div className="text-xs uppercase tracking-[0.18em] text-sophia-text2/75">{label}</div>
      <div className="mt-2 flex items-center gap-2">
        <StatusPill label={value} tone={tone} />
      </div>
    </div>
  )
}

function DetailBlock({ label, value, tone, mono = false }: { label: string; value: string; tone: Tone; mono?: boolean }) {
  return (
    <div className="rounded-3xl border border-sophia-surface-border bg-sophia-bg/60 px-4 py-3">
      <div className="text-xs uppercase tracking-[0.18em] text-sophia-text2/75">{label}</div>
      <div className="mt-2 flex items-center gap-2">
        <StatusPill label={value} tone={tone} />
      </div>
      {mono && <div className="mt-2 break-all font-mono text-[11px] text-sophia-text2">{value}</div>}
    </div>
  )
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  min,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: React.HTMLInputTypeAttribute
  min?: string
}) {
  return (
    <label className="grid gap-2 text-sm text-sophia-text">
      <span className="font-medium">{label}</span>
      <input
        type={type}
        min={min}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="rounded-2xl border border-sophia-surface-border bg-sophia-bg/70 px-3 py-2.5 text-sm text-sophia-text outline-none transition-colors focus:border-sophia-purple/50"
      />
    </label>
  )
}

function TextAreaField({
  label,
  value,
  onChange,
  rows,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  rows: number
  placeholder?: string
}) {
  return (
    <label className="grid gap-2 text-sm text-sophia-text">
      <span className="font-medium">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="rounded-2xl border border-sophia-surface-border bg-sophia-bg/70 px-3 py-2.5 text-sm text-sophia-text outline-none transition-colors focus:border-sophia-purple/50"
      />
    </label>
  )
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="grid gap-2 text-sm text-sophia-text">
      <span className="font-medium">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-2xl border border-sophia-surface-border bg-sophia-bg/70 px-3 py-2.5 text-sm text-sophia-text outline-none transition-colors focus:border-sophia-purple/50"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-start gap-3 rounded-2xl border border-sophia-surface-border bg-sophia-bg/60 px-4 py-3 text-sm text-sophia-text">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4"
      />
      <span>{label}</span>
    </label>
  )
}