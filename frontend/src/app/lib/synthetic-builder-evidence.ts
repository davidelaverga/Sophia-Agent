'use client';

import type {
  GeminiBrowserLiveToolCallLedgerEntry,
  GeminiSyntheticBuilderJoin,
  GeminiSyntheticInputTurnReceipt,
} from './gemini-browser-live-websocket-dogfood';
import {
  readSophiaCaptureSyntheticTestContext,
  recordSophiaCaptureEvent,
} from './session-capture';
import type { BuilderCanvasEventV1 } from '../types/builder-canvas';
import type { BuilderCompletionEventV1 } from '../types/builder-completion';
import { normalizeBuilderArtifactPath } from './builder-artifacts';
import type { ArtifactRecord } from './session-artifact-index';

const MAX_RUNS = 25;
const IMMUTABLE_FIELDS = [
  'test_run_id',
  'scenario_id',
  'scenario_version',
  'operation_id',
  'utterance_id',
  'provider_input_sequence',
  'tool_call_id',
  'effect_id',
  'provider_connection_epoch',
  'relay_correlation_id',
  'tool_name',
  'builder_operation_id',
  'parent_thread_id',
  'task_id',
  'thread_id',
  'run_id',
  'build_id',
  'source_tool_received_at',
  'source_backend_accepted_at',
] as const;

type ScenarioState = {
  acceptedOperations: Set<string>;
  toolCalls: Set<string>;
  taskIds: Set<string>;
  updateTaskIds: Set<string>;
  cancelToolCalls: Set<string>;
  cancelRequestedTaskIds: Set<string>;
  cancelledTaskIds: Set<string>;
  cancelTerminalEventIds: Map<string, string>;
  artifactCreated: boolean;
  artifactVisibleCurrent: boolean;
  publicationAfterCancel: boolean;
};

const joinsByEffect = new Map<string, GeminiSyntheticBuilderJoin>();
const scenarios = new Map<string, ScenarioState>();
const acceptedOperationsByRun = new Map<string, Set<string>>();
const emittedSignatures = new Set<string>();

function scenarioKey(testRunId: string, scenarioId: string): string {
  return `${testRunId}\0${scenarioId}`;
}

function stateFor(join: GeminiSyntheticBuilderJoin): ScenarioState {
  const key = scenarioKey(join.test_run_id, join.scenario_id);
  const existing = scenarios.get(key);
  if (existing) return existing;
  const created: ScenarioState = {
    acceptedOperations: new Set(acceptedOperationsByRun.get(join.test_run_id) ?? []),
    toolCalls: new Set(),
    taskIds: new Set(),
    updateTaskIds: new Set(),
    cancelToolCalls: new Set(),
    cancelRequestedTaskIds: new Set(),
    cancelledTaskIds: new Set(),
    cancelTerminalEventIds: new Map(),
    artifactCreated: false,
    artifactVisibleCurrent: false,
    publicationAfterCancel: false,
  };
  scenarios.set(key, created);
  while (scenarios.size > MAX_RUNS) {
    const oldest = scenarios.keys().next().value as string | undefined;
    if (!oldest) break;
    scenarios.delete(oldest);
  }
  return created;
}

function captureFault(
  code: string,
  join: Partial<GeminiSyntheticBuilderJoin> | null,
): void {
  recordSophiaCaptureEvent({
    category: 'builder-ui',
    name: 'synthetic-builder-join-fault',
    payload: {
      schema: 'sophia_synthetic_builder_join_fault_v1',
      code,
      test_run_id: join?.test_run_id ?? null,
      scenario_id: join?.scenario_id ?? null,
      effect_id: join?.effect_id ?? null,
      task_id: join?.task_id ?? null,
      run_id: join?.run_id ?? null,
      observed_at: new Date().toISOString(),
      raw_transcript_excluded: true,
      raw_artifact_content_excluded: true,
      secrets_excluded: true,
    },
  });
}

function sameImmutableJoin(
  left: GeminiSyntheticBuilderJoin,
  right: GeminiSyntheticBuilderJoin,
): boolean {
  return IMMUTABLE_FIELDS.every((field) => left[field] === right[field]);
}

function hasExactCaptureEnvelope(join: GeminiSyntheticBuilderJoin): boolean {
  const binding = readSophiaCaptureSyntheticTestContext();
  return binding?.synthetic === true
    && binding.test_run_id === join.test_run_id
    && binding.scenario_id === join.scenario_id
    && binding.scenario_version === join.scenario_version;
}

function assertionsFor(
  join: GeminiSyntheticBuilderJoin,
  state: ScenarioState,
): GeminiSyntheticBuilderJoin['scenario_assertions'] {
  const stableTaskIdentity = state.taskIds.size === 1;
  return {
    artifact_created: state.artifactCreated,
    artifact_visible_current: state.artifactVisibleCurrent,
    accepted_turn_count: state.acceptedOperations.size,
    tool_dispatch_count: state.toolCalls.size,
    owned_task_count: state.taskIds.size,
    stable_task_identity: stableTaskIdentity,
    revision_updated_same_task: state.updateTaskIds.size > 0 && stableTaskIdentity,
    current_behavior_result: (
      state.artifactVisibleCurrent
      && state.updateTaskIds.size > 0
      && stableTaskIdentity
    ),
    cancel_request_count: state.cancelToolCalls.size,
    cancel_terminal_settled: state.cancelledTaskIds.has(join.task_id),
    no_post_cancel_publication: !state.publicationAfterCancel,
  };
}

function observeJoin(join: GeminiSyntheticBuilderJoin): ScenarioState {
  const state = stateFor(join);
  state.acceptedOperations.add(join.operation_id);
  state.toolCalls.add(join.tool_call_id);
  state.taskIds.add(join.task_id);
  if (join.tool_name === 'update_async_task' || join.tool_name === 'edit_builder_artifact' || join.tool_name === 'coreview_request_artifact_update') {
    state.updateTaskIds.add(join.task_id);
  }
  if (join.tool_name === 'cancel_async_task') {
    state.cancelToolCalls.add(join.tool_call_id);
    if (join.cancel_count > 0) state.cancelRequestedTaskIds.add(join.task_id);
  }
  return state;
}

export function recordSyntheticAcceptedBuilderTurn(
  receipt: GeminiSyntheticInputTurnReceipt,
): void {
  if (
    receipt.source !== 'public_user_turn'
    || receipt.outcome !== 'public_user_turn_accepted'
  ) return;
  const runOperations = acceptedOperationsByRun.get(receipt.test_run_id) ?? new Set<string>();
  runOperations.add(receipt.operation_id);
  acceptedOperationsByRun.set(receipt.test_run_id, runOperations);
  while (acceptedOperationsByRun.size > MAX_RUNS) {
    const oldest = acceptedOperationsByRun.keys().next().value as string | undefined;
    if (!oldest) break;
    acceptedOperationsByRun.delete(oldest);
  }
  for (const [key, state] of scenarios) {
    if (key.startsWith(`${receipt.test_run_id}\0`)) {
      state.acceptedOperations.add(receipt.operation_id);
    }
  }
}

export function recordSyntheticBuilderToolLedger(
  entry: GeminiBrowserLiveToolCallLedgerEntry,
): void {
  const join = entry.syntheticBuilderJoin;
  if (!join) return;
  if (!hasExactCaptureEnvelope(join)) {
    captureFault('capture_envelope_binding_missing_or_conflicting', join);
    return;
  }
  if (join.tool_call_id !== entry.toolCallId || join.effect_id !== entry.effectId || join.provider_connection_epoch !== entry.providerConnectionEpoch) {
    captureFault('tool_ledger_binding_conflict', join);
    return;
  }
  const existing = joinsByEffect.get(join.effect_id);
  if (existing && !sameImmutableJoin(existing, join)) {
    captureFault('immutable_tool_join_conflict', join);
    return;
  }
  joinsByEffect.set(join.effect_id, join);
  observeJoin(join);
}

function completionFor(event: BuilderCanvasEventV1): BuilderCompletionEventV1 | null {
  return event.completion ?? null;
}

function timestampAtOrAfter(value: string, lowerBound: string): boolean {
  const observed = Date.parse(value);
  const lower = Date.parse(lowerBound);
  return Number.isFinite(observed) && Number.isFinite(lower) && observed >= lower;
}

export function exactActiveArtifactMatchesBuilderCompletion(
  activeArtifact: ArtifactRecord | null | undefined,
  completion: BuilderCompletionEventV1 | null | undefined,
): boolean {
  if (!activeArtifact || completion?.status !== 'success') return false;
  const completionPath = normalizeBuilderArtifactPath(completion.artifact_path);
  const activePath = normalizeBuilderArtifactPath(activeArtifact.localPath);
  if (
    !completionPath
    || completionPath !== activePath
    || activeArtifact.taskId !== completion.task_id
    || !completion.run_id
    || activeArtifact.runId !== completion.run_id
    || (
      typeof completion.artifact_id === 'string'
      && completion.artifact_id.length > 0
      && activeArtifact.artifactId !== completion.artifact_id
    )
    || (
      typeof completion.logical_artifact_id === 'string'
      && completion.logical_artifact_id.length > 0
      && activeArtifact.logicalArtifactId !== completion.logical_artifact_id
    )
    || (
      typeof completion.current_artifact_version_id === 'string'
      && completion.current_artifact_version_id.length > 0
      && activeArtifact.versionId !== completion.current_artifact_version_id
    )
  ) return false;
  return Boolean(completion.artifact_id || completion.artifact_path);
}

async function sha256(value: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle || !value) return null;
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function recordSyntheticBuilderCanvasProjection(
  event: BuilderCanvasEventV1,
  uiProjectionState: 'canvas_current' | 'artifact_visible_current',
): Promise<GeminiSyntheticBuilderJoin | null> {
  const seed = event.synthetic_builder_join ?? event.completion?.synthetic_builder_join ?? null;
  if (!seed || seed.schema !== 'sophia_synthetic_builder_join_v1') return null;
  if (!hasExactCaptureEnvelope(seed)) {
    captureFault('capture_envelope_binding_missing_or_conflicting', seed);
    return null;
  }
  const ledgerJoin = joinsByEffect.get(seed.effect_id) ?? null;
  if (ledgerJoin === null) {
    captureFault('owning_tool_ledger_join_missing', seed);
    return null;
  }
  const fullRunId = event.run_id;
  const completion = completionFor(event);
  const candidate = {
    ...ledgerJoin,
    run_id: fullRunId,
    artifact_id: completion?.artifact_id ?? ledgerJoin.artifact_id ?? seed.artifact_id,
    artifact_path_sha256: await sha256(completion?.artifact_path ?? ''),
    ui_projection_state: uiProjectionState,
    source_builder_event_id: event.event_id,
    source_builder_event_at: event.occurred_at,
    source_ui_projected_at: new Date().toISOString(),
  } as GeminiSyntheticBuilderJoin;
  if (
    candidate.task_id !== event.task_id
    || candidate.thread_id !== event.task_id
    || candidate.parent_thread_id !== event.parent_thread_id
    || !Number.isInteger(event.sequence)
    || event.sequence < 1
    || (completion !== null && (
      completion.thread_id !== event.parent_thread_id
      || completion.task_id !== event.task_id
      || completion.run_id !== event.run_id
    ))
    || !sameImmutableJoin(ledgerJoin, candidate)
  ) {
    captureFault('builder_event_binding_conflict', candidate);
    return null;
  }
  const state = observeJoin(candidate);
  const exactCancelledTerminal = (
    candidate.tool_name === 'cancel_async_task'
    && candidate.cancel_count === 1
    && state.cancelToolCalls.size === 1
    && state.cancelRequestedTaskIds.has(candidate.task_id)
    && event.kind === 'terminal'
    && event.status === 'cancelled'
    && completion?.status === 'cancelled'
    && typeof candidate.source_tool_response_sent_at === 'string'
    && timestampAtOrAfter(event.occurred_at, candidate.source_tool_response_sent_at)
  );
  if (candidate.tool_name === 'cancel_async_task' && event.kind === 'terminal') {
    const priorTerminalEventId = state.cancelTerminalEventIds.get(candidate.task_id);
    if (!exactCancelledTerminal || (
      priorTerminalEventId !== undefined
      && priorTerminalEventId !== event.event_id
    )) {
      captureFault('cancel_terminal_event_invalid_or_conflicting', candidate);
    } else {
      state.cancelTerminalEventIds.set(candidate.task_id, event.event_id);
      state.cancelledTaskIds.add(candidate.task_id);
      candidate.tool_state = 'terminal_settled';
    }
  }
  const hasArtifact = Boolean(
    event.kind === 'terminal'
    && event.status === 'completed'
    && completion?.status === 'success'
    && (candidate.artifact_id || candidate.artifact_path_sha256)
  );
  if (hasArtifact && state.cancelRequestedTaskIds.has(candidate.task_id)) {
    state.publicationAfterCancel = true;
    captureFault('post_cancel_artifact_publication', candidate);
  }
  state.artifactCreated ||= hasArtifact;
  state.artifactVisibleCurrent ||= hasArtifact && uiProjectionState === 'artifact_visible_current';
  const projected: GeminiSyntheticBuilderJoin = {
    ...candidate,
    no_post_cancel_publication: !state.publicationAfterCancel,
    scenario_assertions: assertionsFor(candidate, state),
  };
  const signature = JSON.stringify([
    projected.effect_id,
    projected.source_builder_event_id,
    projected.ui_projection_state,
    projected.tool_state,
    projected.artifact_id,
    projected.artifact_path_sha256,
    projected.cancel_count,
    projected.scenario_assertions,
  ]);
  if (!emittedSignatures.has(signature)) {
    emittedSignatures.add(signature);
    recordSophiaCaptureEvent({
      category: 'builder-ui',
      name: 'synthetic-builder-join',
      payload: {
        ...projected,
        raw_transcript_excluded: true,
        raw_artifact_content_excluded: true,
        secrets_excluded: true,
      },
    });
  }
  joinsByEffect.set(projected.effect_id, projected);
  return projected;
}

export function resetSyntheticBuilderEvidenceForTests(): void {
  joinsByEffect.clear();
  scenarios.clear();
  acceptedOperationsByRun.clear();
  emittedSignatures.clear();
}
