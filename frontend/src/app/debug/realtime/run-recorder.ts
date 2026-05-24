export type ProviderId = 'openai_realtime' | 'gemini_live'
export type Recommendation = 'pass' | 'promising but needs fixes' | 'block'
export type TriState = 'yes' | 'no' | 'n/a'

export const DOGFOOD_RUN_RECORDER_STORAGE_KEY = 'sophia-realtime-dogfood-run-recorder'

export const PROVIDERS = [
  {
    id: 'openai_realtime',
    label: 'OpenAI Realtime',
    shortTransport: 'WebRTC + backend sideband',
    runtimeMode: 'openai_realtime',
    transportType: 'openai_browser_webrtc_with_server_sideband',
    route: '/debug/realtime/openai',
    accentClassName: 'bg-sophia-purple/12 text-sophia-purple',
    description:
      'Browser microphone and speaker stay on OpenAI WebRTC while the trusted backend attaches a sideband and emits normalized sophia.* SSE.',
  },
  {
    id: 'gemini_live',
    label: 'Gemini Live',
    shortTransport: 'Browser WSS + backend relay',
    runtimeMode: 'gemini_live',
    transportType: 'gemini_browser_websocket_ephemeral_token_with_backend_relay',
    route: '/debug/realtime/gemini',
    accentClassName: 'bg-[#2f7e91]/12 text-[#245e6c]',
    description:
      'The browser owns the Gemini Live WebSocket while the backend relay observes documented server messages and keeps the public SSE boundary normalized.',
  },
] as const

export const SCENARIOS = [
  { id: 'S01', title: 'Standard Greeting' },
  { id: 'S02', title: 'Short Direct Answer' },
  { id: 'S03', title: 'Long Reflective Answer' },
  { id: 'S04', title: 'User Interruption Mid-response' },
  { id: 'S05', title: 'Silence / Pause Handling' },
  { id: 'S06', title: 'Quick Back-and-forth Turn-taking' },
  { id: 'S07', title: 'Emotionally Delicate User Statement' },
  { id: 'S08', title: 'Low-energy / Withdrawn User Tone' },
  { id: 'S09', title: 'Slight Frustration / Mild Anger' },
  { id: 'S10', title: 'Masked Discomfort With Humor' },
  { id: 'S11', title: 'Natural Language Switch' },
  { id: 'S12', title: 'Tool-call-shaped Event Observation' },
  { id: 'S13', title: 'Artifact-related Event Observation' },
  { id: 'S14', title: 'Provider Error / Disconnect Simulation' },
  { id: 'S15', title: 'Session Close and Recovery' },
] as const

export const SCORE_FIELDS = [
  { key: 'perceived_ttfa_response_speed', label: 'Perceived TTFA' },
  { key: 'interruption_handling', label: 'Interruption handling' },
  { key: 'transcript_quality', label: 'Transcript quality' },
  { key: 'assistant_audio_naturalness', label: 'Audio naturalness' },
  { key: 'fidelity_to_sophia_voice_register', label: 'Sophia register fidelity' },
  { key: 'emotional_attunement', label: 'Emotional attunement' },
  { key: 'event_stream_correctness', label: 'Event correctness' },
  { key: 'session_stability', label: 'Session stability' },
  { key: 'operational_ease', label: 'Operational ease' },
  { key: 'future_tool_integration_friendliness', label: 'Future tool integration friendliness' },
] as const

export type ScenarioId = (typeof SCENARIOS)[number]['id']
export type ScoreKey = (typeof SCORE_FIELDS)[number]['key']

export type ScenarioDraft = {
  executed: boolean
  notes: string
}

export type RunRecorderDraft = {
  provider: ProviderId
  recordedAtLocal: string
  tester: string
  branch: string
  model: string
  sessionId: string
  userId: string
  device: string
  network: string
  notes: string
  eventHealth: {
    sophiaEventCount: string
    agentStartedObserved: boolean
    agentEndedObserved: boolean
    finalTranscriptObserved: boolean
    artifactObserved: boolean
    builderTaskObserved: TriState
    interruptionMarkers: string
    providerErrorMarkers: string
    providerEventLeaks: string
    missingRequiredEvents: string
  }
  transportHealth: {
    openaiSidebandAttached: TriState
    openaiCallId: string
    geminiSetupCompleteObserved: TriState
    geminiRelayReceiving: TriState
    notes: string
  }
  scenarios: Record<ScenarioId, ScenarioDraft>
  scores: Record<ScoreKey, number>
  recommendation: Recommendation
}

export type RealtimeDogfoodRunRecord = {
  recorded_at: string
  provider: ProviderId
  runtime_mode: string
  transport_type: string
  model: string
  branch: string
  tester: string
  session_id?: string
  user_id?: string
  device?: string
  network?: string
  notes?: string
  scenario_ids_executed: ScenarioId[]
  scenario_results: Array<{
    scenario_id: ScenarioId
    executed: boolean
    notes?: string
  }>
  event_health: {
    sophia_event_count: number
    agent_started_observed: boolean
    agent_ended_observed: boolean
    final_transcript_observed: boolean
    artifact_observed: boolean
    builder_task_observed: boolean | null
    interruption_markers: number
    provider_error_markers: number
    provider_event_leaks: string[]
    missing_required_events: string[]
  }
  sideband_or_relay_health: {
    openai_sideband_attached: boolean | null
    openai_call_id: string | null
    gemini_setup_complete_observed: boolean | null
    gemini_relay_receiving: boolean | null
    notes?: string
  }
  scorecard: Record<ScoreKey, number>
  overall_score: number
  recommendation: Recommendation
  next_actions: string[]
}

const DEFAULT_SCORE = 3

function createDefaultScenarioDrafts(): Record<ScenarioId, ScenarioDraft> {
  return Object.fromEntries(
    SCENARIOS.map(({ id }) => [id, { executed: false, notes: '' }]),
  ) as Record<ScenarioId, ScenarioDraft>
}

function createDefaultScores(): Record<ScoreKey, number> {
  return Object.fromEntries(
    SCORE_FIELDS.map(({ key }) => [key, DEFAULT_SCORE]),
  ) as Record<ScoreKey, number>
}

export function getLocalDateTimeInputValue(date = new Date()): string {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return localDate.toISOString().slice(0, 16)
}

export function createDefaultRunRecorderDraft(): RunRecorderDraft {
  return {
    provider: 'openai_realtime',
    recordedAtLocal: getLocalDateTimeInputValue(),
    tester: '',
    branch: '',
    model: '',
    sessionId: '',
    userId: '',
    device: '',
    network: '',
    notes: '',
    eventHealth: {
      sophiaEventCount: '0',
      agentStartedObserved: false,
      agentEndedObserved: false,
      finalTranscriptObserved: false,
      artifactObserved: false,
      builderTaskObserved: 'n/a',
      interruptionMarkers: '0',
      providerErrorMarkers: '0',
      providerEventLeaks: '',
      missingRequiredEvents: '',
    },
    transportHealth: {
      openaiSidebandAttached: 'n/a',
      openaiCallId: '',
      geminiSetupCompleteObserved: 'n/a',
      geminiRelayReceiving: 'n/a',
      notes: '',
    },
    scenarios: createDefaultScenarioDrafts(),
    scores: createDefaultScores(),
    recommendation: 'promising but needs fixes',
  }
}

export function getProviderConfig(providerId: ProviderId) {
  return PROVIDERS.find((provider) => provider.id === providerId) ?? PROVIDERS[0]
}

export function mergeStoredRunRecorderDraft(value: unknown): RunRecorderDraft {
  const draft = createDefaultRunRecorderDraft()
  if (!isRecord(value)) {
    return draft
  }

  if (isProviderId(value.provider)) draft.provider = value.provider
  if (typeof value.recordedAtLocal === 'string' && value.recordedAtLocal) draft.recordedAtLocal = value.recordedAtLocal
  if (typeof value.tester === 'string') draft.tester = value.tester
  if (typeof value.branch === 'string') draft.branch = value.branch
  if (typeof value.model === 'string') draft.model = value.model
  if (typeof value.sessionId === 'string') draft.sessionId = value.sessionId
  if (typeof value.userId === 'string') draft.userId = value.userId
  if (typeof value.device === 'string') draft.device = value.device
  if (typeof value.network === 'string') draft.network = value.network
  if (typeof value.notes === 'string') draft.notes = value.notes
  if (isRecommendation(value.recommendation)) draft.recommendation = value.recommendation

  if (isRecord(value.eventHealth)) {
    if (typeof value.eventHealth.sophiaEventCount === 'string') draft.eventHealth.sophiaEventCount = value.eventHealth.sophiaEventCount
    if (typeof value.eventHealth.agentStartedObserved === 'boolean') draft.eventHealth.agentStartedObserved = value.eventHealth.agentStartedObserved
    if (typeof value.eventHealth.agentEndedObserved === 'boolean') draft.eventHealth.agentEndedObserved = value.eventHealth.agentEndedObserved
    if (typeof value.eventHealth.finalTranscriptObserved === 'boolean') draft.eventHealth.finalTranscriptObserved = value.eventHealth.finalTranscriptObserved
    if (typeof value.eventHealth.artifactObserved === 'boolean') draft.eventHealth.artifactObserved = value.eventHealth.artifactObserved
    if (isTriState(value.eventHealth.builderTaskObserved)) draft.eventHealth.builderTaskObserved = value.eventHealth.builderTaskObserved
    if (typeof value.eventHealth.interruptionMarkers === 'string') draft.eventHealth.interruptionMarkers = value.eventHealth.interruptionMarkers
    if (typeof value.eventHealth.providerErrorMarkers === 'string') draft.eventHealth.providerErrorMarkers = value.eventHealth.providerErrorMarkers
    if (typeof value.eventHealth.providerEventLeaks === 'string') draft.eventHealth.providerEventLeaks = value.eventHealth.providerEventLeaks
    if (typeof value.eventHealth.missingRequiredEvents === 'string') draft.eventHealth.missingRequiredEvents = value.eventHealth.missingRequiredEvents
  }

  if (isRecord(value.transportHealth)) {
    if (isTriState(value.transportHealth.openaiSidebandAttached)) draft.transportHealth.openaiSidebandAttached = value.transportHealth.openaiSidebandAttached
    if (typeof value.transportHealth.openaiCallId === 'string') draft.transportHealth.openaiCallId = value.transportHealth.openaiCallId
    if (isTriState(value.transportHealth.geminiSetupCompleteObserved)) draft.transportHealth.geminiSetupCompleteObserved = value.transportHealth.geminiSetupCompleteObserved
    if (isTriState(value.transportHealth.geminiRelayReceiving)) draft.transportHealth.geminiRelayReceiving = value.transportHealth.geminiRelayReceiving
    if (typeof value.transportHealth.notes === 'string') draft.transportHealth.notes = value.transportHealth.notes
  }

  if (isRecord(value.scenarios)) {
    for (const scenario of SCENARIOS) {
      const storedScenario = value.scenarios[scenario.id]
      if (!isRecord(storedScenario)) {
        continue
      }

      if (typeof storedScenario.executed === 'boolean') {
        draft.scenarios[scenario.id].executed = storedScenario.executed
      }

      if (typeof storedScenario.notes === 'string') {
        draft.scenarios[scenario.id].notes = storedScenario.notes
      }
    }
  }

  if (isRecord(value.scores)) {
    for (const { key } of SCORE_FIELDS) {
      const storedScore = value.scores[key]
      if (typeof storedScore === 'number' && Number.isInteger(storedScore) && storedScore >= 1 && storedScore <= 5) {
        draft.scores[key] = storedScore
      }
    }
  }

  return draft
}

export function computeOverallScore(scores: Record<ScoreKey, number>): number {
  const values = SCORE_FIELDS.map(({ key }) => scores[key])
  const average = values.reduce((sum, value) => sum + value, 0) / values.length
  return Math.round(average * 10) / 10
}

export function buildRunRecordPayload(draft: RunRecorderDraft): RealtimeDogfoodRunRecord {
  const provider = getProviderConfig(draft.provider)
  const scenarioResults = SCENARIOS.map(({ id }) => {
    const scenario = draft.scenarios[id]
    const notes = scenario.notes.trim()

    return {
      scenario_id: id,
      executed: scenario.executed,
      ...(notes ? { notes } : {}),
    }
  })
  const executedScenarioIds = scenarioResults.filter((scenario) => scenario.executed).map((scenario) => scenario.scenario_id)

  return {
    recorded_at: toRecordedAtIsoString(draft.recordedAtLocal),
    provider: provider.id,
    runtime_mode: provider.runtimeMode,
    transport_type: provider.transportType,
    model: draft.model.trim(),
    branch: draft.branch.trim(),
    tester: draft.tester.trim(),
    ...(draft.sessionId.trim() ? { session_id: draft.sessionId.trim() } : {}),
    ...(draft.userId.trim() ? { user_id: draft.userId.trim() } : {}),
    ...(draft.device.trim() ? { device: draft.device.trim() } : {}),
    ...(draft.network.trim() ? { network: draft.network.trim() } : {}),
    ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
    scenario_ids_executed: executedScenarioIds,
    scenario_results: scenarioResults,
    event_health: {
      sophia_event_count: toNonNegativeInteger(draft.eventHealth.sophiaEventCount),
      agent_started_observed: draft.eventHealth.agentStartedObserved,
      agent_ended_observed: draft.eventHealth.agentEndedObserved,
      final_transcript_observed: draft.eventHealth.finalTranscriptObserved,
      artifact_observed: draft.eventHealth.artifactObserved,
      builder_task_observed: triStateToNullableBoolean(draft.eventHealth.builderTaskObserved),
      interruption_markers: toNonNegativeInteger(draft.eventHealth.interruptionMarkers),
      provider_error_markers: toNonNegativeInteger(draft.eventHealth.providerErrorMarkers),
      provider_event_leaks: parseDelimitedList(draft.eventHealth.providerEventLeaks),
      missing_required_events: parseDelimitedList(draft.eventHealth.missingRequiredEvents),
    },
    sideband_or_relay_health: {
      openai_sideband_attached: triStateToNullableBoolean(draft.transportHealth.openaiSidebandAttached),
      openai_call_id: draft.transportHealth.openaiCallId.trim() || null,
      gemini_setup_complete_observed: triStateToNullableBoolean(draft.transportHealth.geminiSetupCompleteObserved),
      gemini_relay_receiving: triStateToNullableBoolean(draft.transportHealth.geminiRelayReceiving),
      ...(draft.transportHealth.notes.trim() ? { notes: draft.transportHealth.notes.trim() } : {}),
    },
    scorecard: { ...draft.scores },
    overall_score: computeOverallScore(draft.scores),
    recommendation: draft.recommendation,
    next_actions: [],
  }
}

export function buildRunRecordMarkdownSummary(draft: RunRecorderDraft): string {
  const payload = buildRunRecordPayload(draft)
  const provider = getProviderConfig(payload.provider)
  const strongest = getScoreHighlights(payload.scorecard, 'desc')
  const weakest = getScoreHighlights(payload.scorecard, 'asc')
  const executedScenarioLabel = payload.scenario_ids_executed.length > 0
    ? payload.scenario_ids_executed.join(', ')
    : 'None yet'

  const lines = [
    '## Realtime Provider Dogfood Run',
    `- Provider: ${provider.label}`,
    `- Transport: ${provider.shortTransport}`,
    `- Recommendation: ${payload.recommendation}`,
    `- Overall score: ${payload.overall_score.toFixed(1)}/5`,
    `- Recorded at: ${payload.recorded_at}`,
    `- Tester: ${payload.tester || 'Unspecified'}`,
    `- Branch: ${payload.branch || 'Unspecified'}`,
    `- Model: ${payload.model || 'Unspecified'}`,
    `- Scenarios executed: ${payload.scenario_ids_executed.length}/${SCENARIOS.length} (${executedScenarioLabel})`,
    `- Strongest rubric: ${strongest.join('; ')}`,
    `- Weakest rubric: ${weakest.join('; ')}`,
    `- Event evidence: ${payload.event_health.sophia_event_count} sophia.* events; agent_started=${formatBoolean(payload.event_health.agent_started_observed)}; agent_ended=${formatBoolean(payload.event_health.agent_ended_observed)}; final_transcript=${formatBoolean(payload.event_health.final_transcript_observed)}; artifact=${formatBoolean(payload.event_health.artifact_observed)}`,
  ]

  if (payload.notes) {
    lines.push(`- Notes: ${payload.notes}`)
  }

  if (payload.sideband_or_relay_health.notes) {
    lines.push(`- Transport notes: ${payload.sideband_or_relay_health.notes}`)
  }

  return lines.join('\n')
}

export function createRunRecordDownloadFilename(draft: RunRecorderDraft): string {
  const payload = buildRunRecordPayload(draft)
  const stamp = payload.recorded_at.replace(/[:.]/g, '-').replace(/Z$/, 'Z')
  return `sophia-realtime-dogfood-run-${payload.provider}-${stamp}.json`
}

function getScoreHighlights(scorecard: Record<ScoreKey, number>, direction: 'asc' | 'desc'): string[] {
  const ranked = SCORE_FIELDS.map(({ key, label }) => ({
    label,
    score: scorecard[key],
  })).sort((left, right) => {
    if (left.score === right.score) {
      return left.label.localeCompare(right.label)
    }
    return direction === 'desc' ? right.score - left.score : left.score - right.score
  })

  return ranked.slice(0, 2).map((item) => `${item.label} ${item.score}/5`)
}

function toRecordedAtIsoString(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString()
  }
  return parsed.toISOString()
}

function toNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < 0) {
    return 0
  }
  return parsed
}

function triStateToNullableBoolean(value: TriState): boolean | null {
  if (value === 'yes') return true
  if (value === 'no') return false
  return null
}

function parseDelimitedList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatBoolean(value: boolean): string {
  return value ? 'yes' : 'no'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function isProviderId(value: unknown): value is ProviderId {
  return value === 'openai_realtime' || value === 'gemini_live'
}

function isRecommendation(value: unknown): value is Recommendation {
  return value === 'pass' || value === 'promising but needs fixes' || value === 'block'
}

function isTriState(value: unknown): value is TriState {
  return value === 'yes' || value === 'no' || value === 'n/a'
}