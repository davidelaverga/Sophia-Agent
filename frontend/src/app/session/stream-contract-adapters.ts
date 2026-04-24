import { normalizeBuilderArtifactPayload } from '../lib/builder-artifacts';
import { asRecord, readNumber, readString } from '../lib/record-parsers';
import { InterruptPayloadSchema } from '../lib/schemas/session-schemas';
import type { BuilderArtifactV1 } from '../types/builder-artifact';
import type {
  BuilderActivityEntryV1,
  BuilderShellCommandDebugV1,
  BuilderTaskDebugV1,
  BuilderTaskPhaseV1,
  BuilderTaskV1,
  BuilderTodoV1,
} from '../types/builder-task';
import type { InterruptPayload } from '../types/session';
import type { SophiaMessageMetadata } from '../types/sophia-ui-message';

export type StreamArtifactsPayload = {
  takeaway?: string;
  reflection_candidate?: string | { prompt?: string; why?: string };
  reflection?: string | { prompt?: string; why?: string };
  memory_candidates?: unknown[];
  [key: string]: unknown;
};

export type StreamContractPart = {
  type: string;
  data: unknown;
};

const BUILDER_TASK_PHASE_MAP = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  timed_out: 'timed_out',
  cancelled: 'cancelled',
  task_started: 'running',
  task_running: 'running',
  task_completed: 'completed',
  task_failed: 'failed',
  task_timed_out: 'timed_out',
  task_cancelled: 'cancelled',
} as const satisfies Record<string, BuilderTaskPhaseV1>;

function parseBuilderTodos(data: unknown): BuilderTodoV1[] | undefined {
  if (!Array.isArray(data)) {
    return undefined;
  }

  const todos = data
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) return null;

      const title = readString(record, 'title');
      if (!title) return null;

      const status = readString(record, 'status');
      if (status !== 'not-started' && status !== 'in-progress' && status !== 'completed') {
        return null;
      }

      const id = readNumber(record, 'id');
      return {
        ...(typeof id === 'number' ? { id } : {}),
        title,
        status,
      } satisfies BuilderTodoV1;
    })
    .filter((todo): todo is BuilderTodoV1 => Boolean(todo));

  return todos.length > 0 ? todos : undefined;
}

const ACTIVITY_ENTRY_TYPES = new Set(['tool_call', 'thinking']);
const ACTIVITY_STATUS_VALUES = new Set(['running', 'done', 'error']);

function parseBuilderActivityLog(data: unknown): BuilderActivityEntryV1[] | undefined {
  if (!Array.isArray(data) || data.length === 0) {
    return undefined;
  }

  const entries: BuilderActivityEntryV1[] = [];
  for (const raw of data) {
    const entry = asRecord(raw);
    if (!entry) continue;

    const title = readString(entry, 'title');
    if (!title) continue;

    const rawType = readString(entry, 'type');
    const type = ACTIVITY_ENTRY_TYPES.has(rawType ?? '')
      ? (rawType as BuilderActivityEntryV1['type'])
      : 'tool_call';

    const normalized: BuilderActivityEntryV1 = { type, title };
    const tool = readString(entry, 'tool');
    if (tool) normalized.tool = tool;
    const detail = readString(entry, 'detail');
    if (detail) normalized.detail = detail;
    const status = readString(entry, 'status');
    if (ACTIVITY_STATUS_VALUES.has(status ?? '')) {
      normalized.status = status as BuilderActivityEntryV1['status'];
    }

    entries.push(normalized);
  }

  return entries.length > 0 ? entries : undefined;
}

function parseBuilderShellCommandDebug(data: unknown): BuilderShellCommandDebugV1 | undefined {
  const record = asRecord(data);
  if (!record) {
    return undefined;
  }

  const durationMs = readNumber(record, 'duration_ms');
  const timeoutSeconds = readNumber(record, 'timeout_seconds');
  const exitCode = readNumber(record, 'exit_code');

  return {
    ...(readString(record, 'tool') ? { tool: readString(record, 'tool') } : {}),
    ...(readString(record, 'description') ? { description: readString(record, 'description') } : {}),
    ...(readString(record, 'status') ? { status: readString(record, 'status') } : {}),
    ...(readString(record, 'command') ? { command: readString(record, 'command') } : {}),
    ...(readString(record, 'requested_command') ? { requestedCommand: readString(record, 'requested_command') } : {}),
    ...(readString(record, 'resolved_command') ? { resolvedCommand: readString(record, 'resolved_command') } : {}),
    ...(record.shell_executable !== undefined ? { shellExecutable: readString(record, 'shell_executable') ?? null } : {}),
    ...(readString(record, 'started_at') ? { startedAt: readString(record, 'started_at') } : {}),
    ...(readString(record, 'completed_at') ? { completedAt: readString(record, 'completed_at') } : {}),
    ...(typeof durationMs === 'number' ? { durationMs } : {}),
    ...(typeof timeoutSeconds === 'number' ? { timeoutSeconds } : {}),
    ...(typeof exitCode === 'number' ? { exitCode } : {}),
    ...(readString(record, 'error') ? { error: readString(record, 'error') } : {}),
    ...(readString(record, 'stdout_preview') ? { stdoutPreview: readString(record, 'stdout_preview') } : {}),
    ...(readString(record, 'stderr_preview') ? { stderrPreview: readString(record, 'stderr_preview') } : {}),
    ...(readString(record, 'output_preview') ? { outputPreview: readString(record, 'output_preview') } : {}),
  };
}

function parseBuilderTaskDebug(data: unknown): BuilderTaskDebugV1 | undefined {
  const record = asRecord(data);
  if (!record) {
    return undefined;
  }

  const lastShellCommand = parseBuilderShellCommandDebug(record.last_shell_command);
  const recentShellCommands = Array.isArray(record.recent_shell_commands)
    ? record.recent_shell_commands
      .map((entry) => parseBuilderShellCommandDebug(entry))
      .filter((entry): entry is BuilderShellCommandDebugV1 => Boolean(entry))
    : undefined;

  return {
    ...(Array.isArray(record.last_tool_names) ? { lastToolNames: record.last_tool_names.filter((name): name is string => typeof name === 'string') } : {}),
    ...(typeof record.last_has_emit_builder_artifact === 'boolean'
      ? { lastHasEmitBuilderArtifact: record.last_has_emit_builder_artifact }
      : {}),
    ...(Array.isArray(record.late_tool_names) ? { lateToolNames: record.late_tool_names.filter((name): name is string => typeof name === 'string') } : {}),
    ...(typeof record.late_has_emit_builder_artifact === 'boolean'
      ? { lateHasEmitBuilderArtifact: record.late_has_emit_builder_artifact }
      : {}),
    ...(typeof record.timeout_observed_during_stream === 'boolean'
      ? { timeoutObservedDuringStream: record.timeout_observed_during_stream }
      : {}),
    ...(readString(record, 'timed_out_at') !== undefined ? { timedOutAt: readString(record, 'timed_out_at') ?? null } : {}),
    ...(typeof record.final_state_present === 'boolean' ? { finalStatePresent: record.final_state_present } : {}),
    ...(typeof record.builder_result_present === 'boolean' ? { builderResultPresent: record.builder_result_present } : {}),
    ...(readString(record, 'suspected_blocker') !== undefined ? { suspectedBlocker: readString(record, 'suspected_blocker') ?? null } : {}),
    ...(readString(record, 'suspected_blocker_detail') !== undefined
      ? { suspectedBlockerDetail: readString(record, 'suspected_blocker_detail') ?? null }
      : {}),
    ...(lastShellCommand ? { lastShellCommand } : {}),
    ...(recentShellCommands?.length ? { recentShellCommands } : {}),
  };
}

function getBuilderDebugDetail(debug: BuilderTaskDebugV1 | undefined): string | undefined {
  if (!debug) {
    return undefined;
  }

  return debug.suspectedBlockerDetail
    ?? debug.lastShellCommand?.error
    ?? undefined;
}

export function normalizeStreamDataPart(dataPart: unknown): StreamContractPart | null {
  const part = asRecord(dataPart);
  if (!part) return null;

  const rawType = typeof part.type === 'string' ? part.type : '';
  const normalizedType = rawType.startsWith('data-') ? rawType.slice(5) : rawType;

  return {
    type: normalizedType,
    data: part.data,
  };
}

export function parseArtifactsPayload(data: unknown): StreamArtifactsPayload | null {
  const record = asRecord(data);
  if (!record) return null;

  const payload: StreamArtifactsPayload = { ...record };

  if (payload.takeaway !== undefined && typeof payload.takeaway !== 'string') {
    delete payload.takeaway;
  }

  if (
    payload.reflection_candidate !== undefined &&
    typeof payload.reflection_candidate !== 'string' &&
    (typeof payload.reflection_candidate !== 'object' || payload.reflection_candidate === null)
  ) {
    delete payload.reflection_candidate;
  }

  if (
    payload.reflection !== undefined &&
    typeof payload.reflection !== 'string' &&
    (typeof payload.reflection !== 'object' || payload.reflection === null)
  ) {
    delete payload.reflection;
  }

  if (payload.memory_candidates !== undefined && !Array.isArray(payload.memory_candidates)) {
    delete payload.memory_candidates;
  }

  return payload;
}

export function parseBuilderArtifactPayload(data: unknown): BuilderArtifactV1 | null {
  return normalizeBuilderArtifactPayload(data);
}

export function parseBuilderTaskPayload(data: unknown): BuilderTaskV1 | null {
  const record = asRecord(data);
  if (!record) return null;

  const debug = parseBuilderTaskDebug(record.debug);
  const rawPhase = readString(record, 'phase') ?? readString(record, 'type');
  const phase = rawPhase ? BUILDER_TASK_PHASE_MAP[rawPhase] : undefined;
  if (!phase) {
    return null;
  }

  const taskId = readString(record, 'taskId') ?? readString(record, 'task_id');
  const label = readString(record, 'label') ?? readString(record, 'description');
  const detail = readString(record, 'detail')
    ?? readString(record, 'error')
    ?? readString(record, 'result')
    ?? getBuilderDebugDetail(debug)
    ?? (rawPhase === 'task_started' && !label ? 'Builder is working on the deliverable.' : undefined);
  const messageIndex = readNumber(record, 'messageIndex') ?? readNumber(record, 'message_index');
  const totalMessages = readNumber(record, 'totalMessages') ?? readNumber(record, 'total_messages');
  const progressPercent = readNumber(record, 'progressPercent') ?? readNumber(record, 'progress_percent');
  const totalSteps = readNumber(record, 'totalSteps') ?? readNumber(record, 'total_steps');
  const completedSteps = readNumber(record, 'completedSteps') ?? readNumber(record, 'completed_steps');
  const inProgressSteps = readNumber(record, 'inProgressSteps') ?? readNumber(record, 'in_progress_steps');
  const pendingSteps = readNumber(record, 'pendingSteps') ?? readNumber(record, 'pending_steps');
  const heartbeatMs = readNumber(record, 'heartbeatMs') ?? readNumber(record, 'heartbeat_ms');
  const idleMs = readNumber(record, 'idleMs') ?? readNumber(record, 'idle_ms');
  const pollCount = readNumber(record, 'pollCount') ?? readNumber(record, 'poll_count');
  const progressSource = readString(record, 'progressSource') ?? readString(record, 'progress_source');
  const activeStepTitle = readString(record, 'activeStepTitle') ?? readString(record, 'active_step_title');
  const startedAt = readString(record, 'startedAt') ?? readString(record, 'started_at');
  const completedAt = readString(record, 'completedAt') ?? readString(record, 'completed_at');
  const lastUpdateAt = readString(record, 'lastUpdateAt') ?? readString(record, 'last_update_at');
  const lastProgressAt = readString(record, 'lastProgressAt') ?? readString(record, 'last_progress_at');
  const stuckReason = readString(record, 'stuckReason') ?? readString(record, 'stuck_reason');
  const todos = parseBuilderTodos(record.todos);
  const activityLog = parseBuilderActivityLog(record.activity_log ?? record.activityLog);
  const stuckValue = record.stuck ?? record.is_stuck;
  const heartbeatValue = record.heartbeat;
  const stuck = typeof stuckValue === 'boolean' ? stuckValue : undefined;
  const heartbeat = typeof heartbeatValue === 'boolean' ? heartbeatValue : undefined;

  return {
    phase,
    ...(taskId ? { taskId } : {}),
    ...(label ? { label } : {}),
    ...(detail ? { detail } : {}),
    ...(typeof messageIndex === 'number' ? { messageIndex } : {}),
    ...(typeof totalMessages === 'number' ? { totalMessages } : {}),
    ...(typeof progressPercent === 'number' ? { progressPercent } : {}),
    ...(progressSource === 'todos' || progressSource === 'messages' || progressSource === 'iterations' || progressSource === 'none'
      ? { progressSource }
      : {}),
    ...(typeof totalSteps === 'number' ? { totalSteps } : {}),
    ...(typeof completedSteps === 'number' ? { completedSteps } : {}),
    ...(typeof inProgressSteps === 'number' ? { inProgressSteps } : {}),
    ...(typeof pendingSteps === 'number' ? { pendingSteps } : {}),
    ...(activeStepTitle ? { activeStepTitle } : {}),
    ...(todos ? { todos } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(lastUpdateAt ? { lastUpdateAt } : {}),
    ...(lastProgressAt ? { lastProgressAt } : {}),
    ...(typeof heartbeatMs === 'number' ? { heartbeatMs } : {}),
    ...(typeof idleMs === 'number' ? { idleMs } : {}),
    ...(typeof stuck === 'boolean' ? { stuck } : {}),
    ...(stuckReason ? { stuckReason } : {}),
    ...(debug ? { debug } : {}),
    ...(typeof heartbeat === 'boolean' ? { heartbeat } : {}),
    ...(typeof pollCount === 'number' ? { pollCount } : {}),
    ...(activityLog ? { activityLog } : {}),
  };
}

function normalizeInterruptAliases(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...raw };

  if (normalized.snooze === undefined && normalized.snooze_enabled !== undefined) {
    normalized.snooze = normalized.snooze_enabled;
  }

  if (normalized.expiresAt === undefined && normalized.expires_at !== undefined) {
    normalized.expiresAt = normalized.expires_at;
  }

  if (normalized.dialogKind === undefined && normalized.dialog_kind !== undefined) {
    normalized.dialogKind = normalized.dialog_kind;
  }

  return normalized;
}

export function parseInterruptPayload(data: unknown): InterruptPayload | null {
  const record = asRecord(data);
  if (!record) return null;

  const normalized = normalizeInterruptAliases(record);
  const parsed = InterruptPayloadSchema.safeParse(normalized);
  if (!parsed.success) return null;

  return parsed.data as InterruptPayload;
}

export function extractStreamMetadata(
  data: unknown,
  previous: Partial<SophiaMessageMetadata>
): Partial<SophiaMessageMetadata> {
  const meta = asRecord(data);
  if (!meta) return previous;

  return {
    thread_id: readString(meta, 'thread_id') ?? previous.thread_id,
    run_id: readString(meta, 'run_id') ?? previous.run_id,
    session_id: readString(meta, 'session_id') ?? previous.session_id,
    skill_used: readString(meta, 'skill_used') ?? previous.skill_used,
    emotion_detected: readString(meta, 'emotion_detected') ?? previous.emotion_detected,
    session_title: readString(meta, 'session_title') ?? previous.session_title,
  };
}