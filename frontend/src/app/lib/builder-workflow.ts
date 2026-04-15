import type { BuilderArtifactV1 } from '../types/builder-artifact';
import type {
  BuilderActivityEntryV1,
  BuilderShellCommandDebugV1,
  BuilderTaskDebugV1,
  BuilderTaskV1,
} from '../types/builder-task';

import { normalizeBuilderArtifactPayload } from './builder-artifacts';

export const BUILDER_DISCOVERY_PROMPT =
  'I want to use Builder for this. Help me clarify the deliverable, gather the right specs, and switch to Builder when you have enough detail.';

type CancelBuilderTaskResponse = {
  task_id?: string;
  status?: string;
  detail?: string | null;
};

type BuilderTaskStatusShellCommandPayload = {
  tool?: string;
  description?: string;
  status?: string;
  command?: string;
  requested_command?: string;
  resolved_command?: string;
  shell_executable?: string | null;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  timeout_seconds?: number;
  exit_code?: number;
  error?: string;
  stdout_preview?: string;
  stderr_preview?: string;
  output_preview?: string;
};

export type BuilderTaskStatusResponse = {
  task_id?: string;
  status?: string;
  trace_id?: string | null;
  description?: string | null;
  detail?: string | null;
  result?: string | null;
  error?: string | null;
  builder_result?: unknown;
  progress_percent?: number | null;
  progress_source?: BuilderTaskV1['progressSource'] | null;
  total_steps?: number | null;
  completed_steps?: number | null;
  in_progress_steps?: number | null;
  pending_steps?: number | null;
  active_step_title?: string | null;
  todos?: BuilderTaskV1['todos'];
  started_at?: string | null;
  completed_at?: string | null;
  last_update_at?: string | null;
  last_progress_at?: string | null;
  heartbeat_ms?: number | null;
  idle_ms?: number | null;
  is_stuck?: boolean | null;
  stuck_reason?: string | null;
  debug?: {
    last_tool_names?: string[];
    last_has_emit_builder_artifact?: boolean | null;
    late_tool_names?: string[];
    late_has_emit_builder_artifact?: boolean | null;
    timeout_observed_during_stream?: boolean;
    timed_out_at?: string | null;
    final_state_present?: boolean;
    builder_result_present?: boolean;
    suspected_blocker?: string | null;
    suspected_blocker_detail?: string | null;
    last_shell_command?: BuilderTaskStatusShellCommandPayload | null;
    recent_shell_commands?: BuilderTaskStatusShellCommandPayload[];
  };
  activity_log?: Array<{
    type?: string;
    title?: string;
    tool?: string;
    detail?: string;
    status?: string;
  }>;
};

const TERMINAL_TASK_PHASES = new Set<BuilderTaskV1['phase']>(['completed', 'failed', 'timed_out', 'cancelled']);

const ACTIVITY_ENTRY_TYPES = new Set(['tool_call', 'thinking']);
const ACTIVITY_STATUS_VALUES = new Set(['running', 'done', 'error']);

function normalizeActivityLog(
  raw: BuilderTaskStatusResponse['activity_log'],
): BuilderActivityEntryV1[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }

  const entries: BuilderActivityEntryV1[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;

    const type = ACTIVITY_ENTRY_TYPES.has(entry.type ?? '') ? entry.type as BuilderActivityEntryV1['type'] : 'tool_call';
    const title = typeof entry.title === 'string' && entry.title ? entry.title : undefined;
    if (!title) continue;

    const normalized: BuilderActivityEntryV1 = { type, title };
    if (typeof entry.tool === 'string' && entry.tool) normalized.tool = entry.tool;
    if (typeof entry.detail === 'string' && entry.detail) normalized.detail = entry.detail;
    if (ACTIVITY_STATUS_VALUES.has(entry.status ?? '')) {
      normalized.status = entry.status as BuilderActivityEntryV1['status'];
    }

    entries.push(normalized);
  }

  return entries.length > 0 ? entries : undefined;
}

function normalizeShellCommandDebug(
  payload: BuilderTaskStatusShellCommandPayload | null | undefined,
): BuilderShellCommandDebugV1 | null {
  if (!payload) {
    return null;
  }

  return {
    ...(payload.tool ? { tool: payload.tool } : {}),
    ...(payload.description ? { description: payload.description } : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.command ? { command: payload.command } : {}),
    ...(payload.requested_command ? { requestedCommand: payload.requested_command } : {}),
    ...(payload.resolved_command ? { resolvedCommand: payload.resolved_command } : {}),
    ...(payload.shell_executable !== undefined ? { shellExecutable: payload.shell_executable } : {}),
    ...(payload.started_at ? { startedAt: payload.started_at } : {}),
    ...(payload.completed_at ? { completedAt: payload.completed_at } : {}),
    ...(typeof payload.duration_ms === 'number' ? { durationMs: payload.duration_ms } : {}),
    ...(typeof payload.timeout_seconds === 'number' ? { timeoutSeconds: payload.timeout_seconds } : {}),
    ...(typeof payload.exit_code === 'number' ? { exitCode: payload.exit_code } : {}),
    ...(payload.error ? { error: payload.error } : {}),
    ...(payload.stdout_preview ? { stdoutPreview: payload.stdout_preview } : {}),
    ...(payload.stderr_preview ? { stderrPreview: payload.stderr_preview } : {}),
    ...(payload.output_preview ? { outputPreview: payload.output_preview } : {}),
  };
}

function normalizeBuilderTaskDebug(
  payload: BuilderTaskStatusResponse['debug'] | null | undefined,
): BuilderTaskDebugV1 | undefined {
  if (!payload) {
    return undefined;
  }

  const lastShellCommand = normalizeShellCommandDebug(payload.last_shell_command ?? null);
  const recentShellCommands = Array.isArray(payload.recent_shell_commands)
    ? payload.recent_shell_commands
      .map((entry) => normalizeShellCommandDebug(entry))
      .filter((entry): entry is BuilderShellCommandDebugV1 => Boolean(entry))
    : undefined;

  return {
    ...(Array.isArray(payload.last_tool_names) ? { lastToolNames: payload.last_tool_names } : {}),
    ...(payload.last_has_emit_builder_artifact !== undefined
      ? { lastHasEmitBuilderArtifact: payload.last_has_emit_builder_artifact }
      : {}),
    ...(Array.isArray(payload.late_tool_names) ? { lateToolNames: payload.late_tool_names } : {}),
    ...(payload.late_has_emit_builder_artifact !== undefined
      ? { lateHasEmitBuilderArtifact: payload.late_has_emit_builder_artifact }
      : {}),
    ...(typeof payload.timeout_observed_during_stream === 'boolean'
      ? { timeoutObservedDuringStream: payload.timeout_observed_during_stream }
      : {}),
    ...(payload.timed_out_at !== undefined ? { timedOutAt: payload.timed_out_at } : {}),
    ...(typeof payload.final_state_present === 'boolean' ? { finalStatePresent: payload.final_state_present } : {}),
    ...(typeof payload.builder_result_present === 'boolean'
      ? { builderResultPresent: payload.builder_result_present }
      : {}),
    ...(payload.suspected_blocker !== undefined ? { suspectedBlocker: payload.suspected_blocker } : {}),
    ...(payload.suspected_blocker_detail !== undefined
      ? { suspectedBlockerDetail: payload.suspected_blocker_detail }
      : {}),
    ...(lastShellCommand ? { lastShellCommand } : {}),
    ...(recentShellCommands?.length ? { recentShellCommands } : {}),
  };
}

function getBuilderDebugDetail(debug: BuilderTaskDebugV1 | undefined): string | undefined {
  if (!debug) {
    return undefined;
  }

  if (debug.suspectedBlockerDetail) {
    return debug.suspectedBlockerDetail;
  }

  if (debug.lastShellCommand?.error) {
    return debug.lastShellCommand.error;
  }

  const lastShellStatus = debug.lastShellCommand?.status;
  if (!lastShellStatus || lastShellStatus === 'ok' || lastShellStatus === 'nonzero_exit') {
    return undefined;
  }

  const command = debug.lastShellCommand.requestedCommand
    ?? debug.lastShellCommand.command
    ?? debug.lastShellCommand.resolvedCommand;

  return command ? `Last bash command ${lastShellStatus}: ${command}` : `Last bash command ${lastShellStatus}.`;
}

export function getBuilderTaskPhaseFromStatus(status: string | null | undefined): BuilderTaskV1['phase'] | null {
  switch (status) {
    case 'pending':
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'timed_out':
      return 'timed_out';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

export async function cancelBuilderTask(taskId: string): Promise<CancelBuilderTaskResponse> {
  const response = await fetch(`/api/sophia/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: 'POST',
  });

  const payload = await response.json().catch(() => ({})) as CancelBuilderTaskResponse & {
    error?: string;
    details?: { detail?: string };
  };

  if (!response.ok) {
    throw new Error(
      payload.error || payload.details?.detail || payload.detail || 'Failed to cancel builder task.',
    );
  }

  return payload;
}

export async function getActiveBuilderTask(
  threadId: string,
): Promise<BuilderTaskStatusResponse | null> {
  const params = new URLSearchParams({ thread_id: threadId });
  const response = await fetch(
    `/api/sophia/tasks/active?${params.toString()}`,
    { method: 'GET', cache: 'no-store' },
  );

  if (!response.ok) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  if (!payload?.task_id) {
    return null;
  }

  return payload as BuilderTaskStatusResponse;
}

export async function getBuilderTaskStatus(taskId: string): Promise<BuilderTaskStatusResponse> {
  const response = await fetch(`/api/sophia/tasks/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    cache: 'no-store',
  });

  const payload = await response.json().catch(() => ({})) as BuilderTaskStatusResponse & {
    error?: string;
    details?: { detail?: string };
  };

  if (!response.ok) {
    throw new Error(
      payload.error || payload.details?.detail || payload.detail || 'Failed to fetch builder task status.',
    );
  }

  return payload;
}

export function mergeBuilderTaskStatus(
  currentTask: BuilderTaskV1 | null,
  statusPayload: BuilderTaskStatusResponse,
): BuilderTaskV1 | null {
  const nextPhase = getBuilderTaskPhaseFromStatus(statusPayload.status);

  if (!currentTask && !nextPhase) {
    return null;
  }

  if (currentTask && TERMINAL_TASK_PHASES.has(currentTask.phase) && nextPhase === 'running') {
    // Allow a genuinely new task to replace a completed one. Without this
    // check, the second builder request's polling updates are silently
    // discarded because the first task's completed state blocks them.
    if (!statusPayload.task_id || statusPayload.task_id === currentTask.taskId) {
      return currentTask;
    }
  }

  const debug = normalizeBuilderTaskDebug(statusPayload.debug);
  const activityLog = normalizeActivityLog(statusPayload.activity_log);
  const detail = statusPayload.detail
    || statusPayload.error
    || statusPayload.result
    || getBuilderDebugDetail(debug)
    || currentTask?.detail;

  return {
    ...(currentTask ?? { phase: nextPhase ?? 'running' }),
    ...(nextPhase ? { phase: nextPhase } : {}),
    ...(statusPayload.task_id ? { taskId: statusPayload.task_id } : {}),
    ...(statusPayload.description ? { label: statusPayload.description } : {}),
    ...(detail ? { detail } : {}),
    ...(typeof statusPayload.progress_percent === 'number'
      ? { progressPercent: statusPayload.progress_percent }
      : {}),
    ...(statusPayload.progress_source ? { progressSource: statusPayload.progress_source } : {}),
    ...(typeof statusPayload.total_steps === 'number' ? { totalSteps: statusPayload.total_steps } : {}),
    ...(typeof statusPayload.completed_steps === 'number'
      ? { completedSteps: statusPayload.completed_steps }
      : {}),
    ...(typeof statusPayload.in_progress_steps === 'number'
      ? { inProgressSteps: statusPayload.in_progress_steps }
      : {}),
    ...(typeof statusPayload.pending_steps === 'number' ? { pendingSteps: statusPayload.pending_steps } : {}),
    ...(statusPayload.active_step_title ? { activeStepTitle: statusPayload.active_step_title } : {}),
    ...(Array.isArray(statusPayload.todos) ? { todos: statusPayload.todos } : {}),
    ...(statusPayload.started_at ? { startedAt: statusPayload.started_at } : {}),
    ...(statusPayload.completed_at ? { completedAt: statusPayload.completed_at } : {}),
    ...(statusPayload.last_update_at ? { lastUpdateAt: statusPayload.last_update_at } : {}),
    ...(statusPayload.last_progress_at ? { lastProgressAt: statusPayload.last_progress_at } : {}),
    ...(typeof statusPayload.heartbeat_ms === 'number' ? { heartbeatMs: statusPayload.heartbeat_ms } : {}),
    ...(typeof statusPayload.idle_ms === 'number' ? { idleMs: statusPayload.idle_ms } : {}),
    ...(typeof statusPayload.is_stuck === 'boolean' ? { stuck: statusPayload.is_stuck } : {}),
    ...(statusPayload.stuck_reason ? { stuckReason: statusPayload.stuck_reason } : {}),
    ...(debug ? { debug } : currentTask?.debug ? { debug: currentTask.debug } : {}),
    ...(activityLog ? { activityLog } : currentTask?.activityLog ? { activityLog: currentTask.activityLog } : {}),
  };
}

export function getBuilderArtifactFromStatus(
  statusPayload: BuilderTaskStatusResponse,
): BuilderArtifactV1 | null {
  return normalizeBuilderArtifactPayload(statusPayload.builder_result);
}