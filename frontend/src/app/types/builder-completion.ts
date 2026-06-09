/**
 * Wire shape of the builder-completion event the gateway streams over SSE.
 *
 * Mirrors ``BuilderCompletionEvent`` in
 * ``backend/app/gateway/routers/builder_events.py``. Fired exactly once per
 * terminal task transition (success | error | timeout | cancelled).
 */

export type BuilderCompletionStatus = 'success' | 'error' | 'timeout' | 'cancelled';

export type BuilderCompletionEventV1 = {
  thread_id: string;
  task_id: string;
  run_id?: string | null;
  trace_id?: string | null;
  agent_name?: string | null;
  status: BuilderCompletionStatus;
  task_type?: string | null;
  task_brief?: string | null;
  artifact_path?: string | null;
  artifact_url?: string | null;
  artifact_title?: string | null;
  artifact_type?: string | null;
  artifact_filename?: string | null;
  requested_artifact_ext?: string | null;
  artifact_ext?: string | null;
  artifact_is_fallback?: boolean | null;
  fallback_reason?: string | null;
  image_generation_status?: string | null;
  image_generation_reason?: string | null;
  source_artifact_path?: string | null;
  revision_of_artifact_path?: string | null;
  summary?: string | null;
  user_next_action?: string | null;
  error_message?: string | null;
  completed_at?: string | null;
  source?: string | null;
};
