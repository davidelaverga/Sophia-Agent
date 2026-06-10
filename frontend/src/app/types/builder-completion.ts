/**
 * Wire shape of the builder-completion event the gateway streams over SSE.
 *
 * Mirrors ``BuilderCompletionEvent`` in
 * ``backend/app/gateway/routers/builder_events.py``. Fired exactly once per
 * terminal task transition (success | error | timeout | cancelled).
 */

export type BuilderCompletionStatus = 'success' | 'error' | 'timeout' | 'cancelled';

export type BuilderFailureDiagnosticsV1 = {
  schema: 'builder_failure_diagnostics_v1';
  task_id?: string | null;
  run_id?: string | null;
  thread_id?: string | null;
  parent_thread_id?: string | null;
  user_id?: string | null;
  trace_id?: string | null;
  task_type?: string | null;
  target_path?: string | null;
  target_extension?: string | null;
  failure_stage?: string | null;
  failure_reason?: string | null;
  failure_code?: string | null;
  emit_attempted?: boolean | null;
  emit_tool_call_seen?: boolean | null;
  sanitized_emit_args?: {
    artifact_path?: string | null;
    artifact_type?: string | null;
    artifact_title?: string | null;
    supporting_files?: {
      count?: number | null;
      paths?: string[];
    } | null;
    source_artifact_path?: string | null;
    revision_of_artifact_path?: string | null;
    confidence?: number | null;
  } | null;
  outputs_summary?: Array<{
    relative_path?: string | null;
    extension?: string | null;
    size_bytes?: number | null;
    mtime?: string | null;
    exists?: boolean | null;
    integrity_status?: string | null;
  }>;
  artifact_target_path?: string | null;
  artifact_target_exists?: boolean | null;
  artifact_target_integrity_status?: string | null;
  supabase_mirror_attempted?: boolean | null;
  supabase_mirror_result?: string | null;
  signed_url_created?: boolean | null;
  completion_webhook_attempted?: boolean | null;
  completion_webhook_result?: string | null;
  canvas_reconciliation_action?: string | null;
  raw_content_excluded?: boolean;
  raw_artifact_text_excluded?: boolean;
  raw_frame_excluded?: boolean;
  secrets_excluded?: boolean;
  // Builder provider-fallback snapshot (sanitized — booleans + fixed
  // template strings only, never keys or raw provider payloads).
  primary_provider?: string | null;
  fallback_provider?: string | null;
  fallback_enabled?: boolean | null;
  fallback_attempted?: boolean | null;
  fallback_result?: string | null;
  fallback_model_configured?: boolean | null;
  provider_error_class?: string | null;
  provider_error_safe_message?: string | null;
  raw_provider_payload_excluded?: boolean;
  provider_secrets_excluded?: boolean;
};

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
  builder_failure_diagnostics?: BuilderFailureDiagnosticsV1 | null;
  completed_at?: string | null;
  source?: string | null;
};
