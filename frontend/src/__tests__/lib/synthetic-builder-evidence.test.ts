import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GeminiBrowserLiveToolCallLedgerEntry,
  GeminiSyntheticBuilderJoin,
  GeminiSyntheticInputTurnReceipt,
  GeminiSyntheticTestContext,
} from '../../app/lib/gemini-browser-live-websocket-dogfood';
import type { BuilderCanvasEventV1 } from '../../app/types/builder-canvas';
import type { BuilderCompletionEventV1 } from '../../app/types/builder-completion';
import type { ArtifactRecord } from '../../app/lib/session-artifact-index';

const capture = vi.hoisted(() => ({
  binding: null as GeminiSyntheticTestContext | null,
  events: [] as Array<{ category: string; name: string; payload?: unknown }>,
}));

vi.mock('../../app/lib/session-capture', () => ({
  readSophiaCaptureSyntheticTestContext: () => capture.binding,
  recordSophiaCaptureEvent: (event: { category: string; name: string; payload?: unknown }) => {
    capture.events.push(event);
  },
}));

import {
  exactActiveArtifactMatchesBuilderCompletion,
  recordSyntheticAcceptedBuilderTurn,
  recordSyntheticBuilderCanvasProjection,
  recordSyntheticBuilderToolLedger,
  resetSyntheticBuilderEvidenceForTests,
} from '../../app/lib/synthetic-builder-evidence';

const SOURCE_AT = '2026-08-23T12:00:00.000Z';

function binding(scenarioId: string): GeminiSyntheticTestContext {
  return {
    synthetic: true,
    principal_id: 'voice-lab-user-1',
    test_run_id: 'run-001',
    scenario_id: scenarioId,
    scenario_version: 'vt00.scenarios.v1',
    environment: 'production',
    retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
  };
}

function join({
  scenarioId,
  toolName = 'start_builder_task',
  operationId = 'operation-001',
  effectId = 'effect-001',
  toolCallId = 'tool-call-001',
  taskId = 'builder-task-001',
  runId = 'builder-run-001',
  cancelCount = 0,
}: {
  scenarioId: string;
  toolName?: string;
  operationId?: string;
  effectId?: string;
  toolCallId?: string;
  taskId?: string;
  runId?: string;
  cancelCount?: number;
}): GeminiSyntheticBuilderJoin {
  return {
    schema: 'sophia_synthetic_builder_join_v1',
    test_run_id: 'run-001',
    scenario_id: scenarioId,
    scenario_version: 'vt00.scenarios.v1',
    operation_id: operationId,
    utterance_id: `utterance-${operationId}`,
    provider_input_sequence: 1,
    tool_call_id: toolCallId,
    effect_id: effectId,
    provider_connection_epoch: 7,
    relay_correlation_id: `relay-${toolCallId}`,
    tool_name: toolName,
    tool_state: 'responded',
    builder_operation_id: 'builder-operation-001',
    parent_thread_id: 'parent-thread-001',
    task_id: taskId,
    thread_id: taskId,
    run_id: runId,
    build_id: 'builder-operation-001',
    artifact_id: null,
    artifact_path_sha256: null,
    ui_projection_state: null,
    cancel_count: cancelCount,
    no_post_cancel_publication: true,
    source_tool_received_at: SOURCE_AT,
    source_backend_accepted_at: SOURCE_AT,
    source_tool_response_sent_at: SOURCE_AT,
    source_builder_event_id: null,
    source_builder_event_at: null,
    source_ui_projected_at: null,
    scenario_assertions: {},
  };
}

function ledger(value: GeminiSyntheticBuilderJoin): GeminiBrowserLiveToolCallLedgerEntry {
  return {
    toolCallId: value.tool_call_id,
    effectId: value.effect_id,
    providerConnectionEpoch: value.provider_connection_epoch,
    toolName: value.tool_name,
    receivedAt: value.source_tool_received_at,
    cancelledAt: null,
    relayStartedAt: value.source_tool_received_at,
    relayCompletedAt: value.source_backend_accepted_at,
    backendAcceptedAt: value.source_backend_accepted_at,
    toolResponsePreparedAt: value.source_tool_response_sent_at,
    toolResponseSentAt: value.source_tool_response_sent_at,
    sendSuppressedAt: null,
    suppressionReason: null,
    finalState: 'responded',
    syntheticToolEvidence: null,
    syntheticBuilderJoin: value,
  };
}

function acceptedTurn(operationId: string): GeminiSyntheticInputTurnReceipt {
  return {
    schema: 'sophia_gemini_input_turn_v1',
    synthetic: true,
    test_run_id: 'run-001',
    operation_id: operationId,
    utterance_id: `utterance-${operationId}`,
    frame_window_id: `window-${operationId}`,
    expected_silence: false,
    source: 'public_user_turn',
    outcome: 'public_user_turn_accepted',
    observed_at: SOURCE_AT,
    provider_receive_sequence: 1,
    provider_received_at: SOURCE_AT,
    public_utterance_id: `public-${operationId}`,
    transcript_length: 8,
    settlement_window_ms: 5000,
    raw_audio_excluded: true,
  };
}

function canvasEvent(
  value: GeminiSyntheticBuilderJoin,
  options: { artifact?: boolean; status?: 'completed' | 'cancelled'; eventId?: string } = {},
): BuilderCanvasEventV1 {
  const artifact = options.artifact ?? true;
  const status = options.status ?? 'completed';
  return {
    version: 1,
    event_id: options.eventId ?? `event-${value.effect_id}`,
    sequence: 1,
    parent_thread_id: value.parent_thread_id,
    task_id: value.task_id,
    run_id: value.run_id,
    occurred_at: SOURCE_AT,
    kind: 'terminal',
    status,
    synthetic_builder_join: value,
    completion: {
      thread_id: value.parent_thread_id,
      task_id: value.task_id,
      run_id: value.run_id,
      status: status === 'cancelled' ? 'cancelled' : 'success',
      artifact_id: artifact ? `artifact-${value.task_id}` : null,
      artifact_path: artifact ? 'mnt/user-data/outputs/evidence.md' : null,
      completed_at: SOURCE_AT,
      synthetic_builder_join: value,
    },
  };
}

function capturedJoins(): GeminiSyntheticBuilderJoin[] {
  return capture.events
    .filter((event) => event.name === 'synthetic-builder-join')
    .map((event) => event.payload as GeminiSyntheticBuilderJoin);
}

function artifactRecord(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    artifactId: 'artifact-builder-task-001',
    stableArtifactIdentity: 'stable-artifact-001',
    logicalArtifactId: 'logical-artifact-001',
    versionId: 'artifact-version-001',
    userId: 'voice-lab-user-1',
    threadId: 'parent-thread-001',
    parentThreadId: 'parent-thread-001',
    taskId: 'builder-task-001',
    runId: 'builder-run-001',
    title: 'Evidence',
    artifactType: 'markdown',
    rendererKind: 'markdown',
    localPath: 'mnt/user-data/outputs/evidence.md',
    storageProvider: 'local',
    createdAt: SOURCE_AT,
    updatedAt: SOURCE_AT,
    rawContentExcluded: true,
    ...overrides,
  };
}

function successfulCompletion(
  overrides: Partial<BuilderCompletionEventV1> = {},
): BuilderCompletionEventV1 {
  return {
    thread_id: 'parent-thread-001',
    task_id: 'builder-task-001',
    run_id: 'builder-run-001',
    status: 'success',
    artifact_id: 'artifact-builder-task-001',
    logical_artifact_id: 'logical-artifact-001',
    current_artifact_version_id: 'artifact-version-001',
    artifact_path: 'mnt/user-data/outputs/evidence.md',
    completed_at: SOURCE_AT,
    ...overrides,
  };
}

describe('exact synthetic Builder evidence joins', () => {
  beforeEach(() => {
    capture.events = [];
    capture.binding = null;
    resetSyntheticBuilderEvidenceForTests();
  });

  it('B01 proves one owned artifact is created and projected as current', async () => {
    const value = join({ scenarioId: 'V-B01' });
    capture.binding = binding('V-B01');
    recordSyntheticAcceptedBuilderTurn(acceptedTurn(value.operation_id));
    recordSyntheticBuilderToolLedger(ledger(value));

    const projected = await recordSyntheticBuilderCanvasProjection(
      canvasEvent(value),
      'artifact_visible_current',
    );

    expect(projected?.scenario_assertions).toMatchObject({
      artifact_created: true,
      artifact_visible_current: true,
      owned_task_count: 1,
      stable_task_identity: true,
    });
    expect(projected?.artifact_id).toBe('artifact-builder-task-001');
    expect(projected?.source_builder_event_id).toBe('event-effect-001');
  });

  it('B02 preserves three accepted turns that precede one dispatch on the same task', async () => {
    capture.binding = binding('V-B02');
    for (const operationId of ['operation-001', 'operation-002', 'operation-003']) {
      recordSyntheticAcceptedBuilderTurn(acceptedTurn(operationId));
    }
    const value = join({ scenarioId: 'V-B02', operationId: 'operation-003' });
    recordSyntheticBuilderToolLedger(ledger(value));

    const projected = await recordSyntheticBuilderCanvasProjection(
      canvasEvent(value),
      'artifact_visible_current',
    );

    expect(projected?.scenario_assertions).toMatchObject({
      accepted_turn_count: 3,
      tool_dispatch_count: 1,
      owned_task_count: 1,
      stable_task_identity: true,
    });
  });

  it('B03 proves an update result retains the original task identity', async () => {
    capture.binding = binding('V-B03');
    const started = join({ scenarioId: 'V-B03' });
    const updated = join({
      scenarioId: 'V-B03',
      toolName: 'update_async_task',
      operationId: 'operation-002',
      effectId: 'effect-002',
      toolCallId: 'tool-call-002',
      runId: 'builder-run-002',
    });
    recordSyntheticBuilderToolLedger(ledger(started));
    recordSyntheticBuilderToolLedger(ledger(updated));

    const projected = await recordSyntheticBuilderCanvasProjection(
      canvasEvent(updated),
      'artifact_visible_current',
    );

    expect(projected?.task_id).toBe(started.task_id);
    expect(projected?.scenario_assertions).toMatchObject({
      owned_task_count: 1,
      stable_task_identity: true,
      revision_updated_same_task: true,
      current_behavior_result: true,
    });
  });

  it('B04 proves one terminal cancel and faults any later artifact publication', async () => {
    capture.binding = binding('V-B04');
    const cancelled = join({
      scenarioId: 'V-B04',
      toolName: 'cancel_async_task',
      effectId: 'effect-cancel',
      toolCallId: 'tool-call-cancel',
      cancelCount: 1,
    });
    recordSyntheticBuilderToolLedger(ledger(cancelled));
    const terminal = await recordSyntheticBuilderCanvasProjection(
      canvasEvent(cancelled, { artifact: false, status: 'cancelled' }),
      'canvas_current',
    );
    expect(terminal?.scenario_assertions).toMatchObject({
      cancel_request_count: 1,
      cancel_terminal_settled: true,
      no_post_cancel_publication: true,
    });

    const published = join({
      scenarioId: 'V-B04',
      operationId: 'operation-late',
      effectId: 'effect-late',
      toolCallId: 'tool-call-late',
    });
    recordSyntheticBuilderToolLedger(ledger(published));
    const postCancel = await recordSyntheticBuilderCanvasProjection(
      canvasEvent(published, { eventId: 'event-post-cancel' }),
      'artifact_visible_current',
    );
    expect(postCancel?.no_post_cancel_publication).toBe(false);
    expect(capture.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'synthetic-builder-join-fault' }),
    ]));
  });

  it('B04 never trusts a seeded cancel assertion without an owning cancelled terminal event', async () => {
    capture.binding = binding('V-B04');
    const seeded = join({
      scenarioId: 'V-B04',
      toolName: 'cancel_async_task',
      effectId: 'effect-cancel-seeded',
      toolCallId: 'tool-call-cancel-seeded',
      cancelCount: 1,
    });
    seeded.scenario_assertions = {
      cancel_terminal_settled: true,
      no_post_cancel_publication: true,
    };
    recordSyntheticBuilderToolLedger(ledger(seeded));

    const projected = await recordSyntheticBuilderCanvasProjection(
      canvasEvent(seeded, { artifact: true, status: 'completed' }),
      'canvas_current',
    );

    expect(projected?.scenario_assertions.cancel_terminal_settled).toBe(false);
    expect(projected?.tool_state).toBe('responded');
    expect(capture.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'synthetic-builder-join-fault',
        payload: expect.objectContaining({ code: 'cancel_terminal_event_invalid_or_conflicting' }),
      }),
    ]));
  });

  it('requires the owning tool ledger before projecting a Builder terminal event', async () => {
    capture.binding = binding('V-B01');
    const value = join({ scenarioId: 'V-B01' });

    await expect(recordSyntheticBuilderCanvasProjection(
      canvasEvent(value),
      'artifact_visible_current',
    )).resolves.toBeNull();
    expect(capture.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'synthetic-builder-join-fault',
        payload: expect.objectContaining({ code: 'owning_tool_ledger_join_missing' }),
      }),
    ]));
  });

  it('B01/B03 only certify the exact active artifact owned by the completion', () => {
    const completion = successfulCompletion();
    expect(exactActiveArtifactMatchesBuilderCompletion(
      artifactRecord(),
      completion,
    )).toBe(true);
    expect(exactActiveArtifactMatchesBuilderCompletion(
      artifactRecord({
        artifactId: 'unrelated-artifact',
        localPath: 'mnt/user-data/outputs/unrelated.md',
      }),
      completion,
    )).toBe(false);
    expect(exactActiveArtifactMatchesBuilderCompletion(
      artifactRecord({ runId: 'foreign-run' }),
      completion,
    )).toBe(false);
    expect(exactActiveArtifactMatchesBuilderCompletion(
      artifactRecord({ versionId: 'foreign-version' }),
      completion,
    )).toBe(false);
  });

  it('rejects missing envelope provenance and conflicting immutable duplicates', () => {
    const value = join({ scenarioId: 'V-B01' });
    recordSyntheticBuilderToolLedger(ledger(value));
    capture.binding = binding('V-B01');
    recordSyntheticBuilderToolLedger(ledger(value));
    recordSyntheticBuilderToolLedger(ledger({ ...value, task_id: 'foreign-task', thread_id: 'foreign-task' }));

    expect(capturedJoins()).toHaveLength(0);
    expect(capture.events.filter((event) => event.name === 'synthetic-builder-join-fault')).toHaveLength(2);
  });
});
