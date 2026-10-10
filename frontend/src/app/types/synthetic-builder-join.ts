/**
 * The synthetic Builder join a governed Voice Lab run records for one Builder
 * tool call. A dependency-free type leaf: the Gemini Live dogfood pipeline
 * and the Builder types both import it from here, so neither has to import
 * the other for it.
 */
export interface GeminiSyntheticBuilderJoin {
  schema: 'sophia_synthetic_builder_join_v1';
  test_run_id: string;
  scenario_id: string;
  scenario_version: string;
  operation_id: string;
  utterance_id: string;
  provider_input_sequence: number;
  tool_call_id: string;
  effect_id: string;
  provider_connection_epoch: number;
  relay_correlation_id: string;
  tool_name: string;
  tool_state: string;
  builder_operation_id: string;
  parent_thread_id: string;
  task_id: string;
  thread_id: string;
  run_id: string;
  build_id: string;
  artifact_id: string | null;
  artifact_path_sha256: string | null;
  ui_projection_state: string | null;
  cancel_count: number;
  no_post_cancel_publication: boolean;
  source_tool_received_at: string;
  source_backend_accepted_at: string;
  source_tool_response_sent_at: string | null;
  source_builder_event_id: string | null;
  source_builder_event_at: string | null;
  source_ui_projected_at: string | null;
  scenario_assertions: Record<string, boolean | number | string | null>;
}
