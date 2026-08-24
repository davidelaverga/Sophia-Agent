import { SCENARIO_CATALOG_VERSION } from "./domain.js";

export const SCENARIO_IDS = [
  "V-A01", "V-A02", "V-A03", "V-O01", "V-O02", "V-B01", "V-B02", "V-B03", "V-B04",
  "V-I01", "V-I02", "V-N01", "V-N02", "V-F01", "V-F02", "V-S01", "V-S02", "V-D01", "V-D02", "V-L01", "V-P01",
] as const;

export type ScenarioId = typeof SCENARIO_IDS[number];

const DEFINITIONS: Record<ScenarioId, { summary: string; requiredTools: string[]; evaluation: string; support: "supported" | "typed_unsupported"; unavailableReason?: string }> = {
  "V-A01": { summary: "Neutral greeting plus five adaptive utterances", requiredTools: ["start_voice_run", "speak", "wait_for_turn", "inspect_voice_run", "end_voice_run"], evaluation: "six_exact_schedule_to_transcript_to_turn_chains_with_five_adaptive_boundaries", support: "supported" },
  "V-A02": { summary: "Short, long, silence, trailing-pause, and noisy fixture classes", requiredTools: ["start_voice_run", "speak", "wait_for_turn", "inspect_voice_run", "end_voice_run"], evaluation: "fixture_attribution_and_silence_no_fabricated_turn", support: "supported" },
  "V-A03": { summary: "Identical speak retry after MCP timeout", requiredTools: ["start_voice_run", "speak", "inspect_voice_run", "end_voice_run"], evaluation: "single_operation_single_page_receipt_single_turn", support: "supported" },
  "V-O01": { summary: "Normal Sophia output realization", requiredTools: ["start_voice_run", "speak", "wait_for_turn", "inspect_voice_run", "end_voice_run"], evaluation: "unique_output_receive_schedule_start_complete_chain", support: "supported" },
  "V-O02": { summary: "Flush or disconnect during output", requiredTools: ["start_voice_run", "speak", "force_socket_rotation", "inspect_voice_run", "end_voice_run"], evaluation: "last_realization_and_no_stale_playback", support: "supported" },
  "V-B01": { summary: "Explicit HTML Builder request", requiredTools: ["start_voice_run", "speak", "wait_for_turn", "inspect_voice_run", "end_voice_run"], evaluation: "utterance_transcript_tool_task_ui_trace_join", support: "supported" },
  "V-B02": { summary: "Unrelated and status turns during build", requiredTools: ["start_voice_run", "speak", "wait_for_turn", "inspect_voice_run", "end_voice_run"], evaluation: "single_owned_task_continues_without_duplicate_dispatch", support: "supported" },
  "V-B03": { summary: "Builder update or add-topic request", requiredTools: ["start_voice_run", "speak", "inspect_voice_run", "end_voice_run"], evaluation: "capture_current_update_contract_without_steer_inference", support: "supported" },
  "V-B04": { summary: "Cancel active build", requiredTools: ["start_voice_run", "speak", "wait_for_turn", "inspect_voice_run", "end_voice_run"], evaluation: "one_terminal_cancel_no_post_cancel_publication", support: "supported" },
  "V-I01": { summary: "Barge in after playback begins", requiredTools: ["start_voice_run", "speak", "barge_in", "inspect_voice_run", "end_voice_run"], evaluation: "output_started_target_flush_and_new_input_retained", support: "supported" },
  "V-I02": { summary: "Barge in near a tool boundary", requiredTools: ["start_voice_run", "speak", "barge_in", "wait_for_turn", "inspect_voice_run", "end_voice_run"], evaluation: "speech_tool_order_and_at_most_once_settlement", support: "supported" },
  "V-N01": { summary: "Rotate provider socket after setup", requiredTools: ["start_voice_run", "force_socket_rotation", "speak", "wait_for_turn", "inspect_voice_run", "end_voice_run"], evaluation: "requested_epoch_to_restored_new_epoch_plus_post_restore_continuity_turn", support: "supported" },
  "V-N02": { summary: "Rotate during output or tool work", requiredTools: ["start_voice_run", "speak", "force_socket_rotation", "inspect_voice_run", "end_voice_run"], evaluation: "committed_event_and_exactly_once_recovery", support: "supported" },
  "V-F01": { summary: "Explicit end after one completed synthetic turn and durable finalization", requiredTools: ["start_voice_run", "speak", "wait_for_turn", "inspect_voice_run", "end_voice_run", "export_voice_evidence"], evaluation: "one_exact_input_and_assistant_turn_then_strict_nonempty_canonical_finalization_and_zero_orphan_cleanup", support: "supported" },
  "V-F02": { summary: "Accelerated idle expiry and resume", requiredTools: ["start_voice_run", "inspect_voice_run", "end_voice_run"], evaluation: "governed_clock_expiry_and_same_logical_resume", support: "typed_unsupported", unavailableReason: "governed_product_clock_not_available" },
  "V-S01": { summary: "Invalid capability and OAuth grants", requiredTools: ["start_voice_run", "inspect_voice_run", "export_voice_evidence"], evaluation: "server_owned_frontend_capability_oauth_resource_scope_replay_and_fault_scope_rejections_before_resource_allocation", support: "supported" },
  "V-S02": { summary: "Malformed schema, media, fixture, capture, and target inputs", requiredTools: ["start_voice_run", "inspect_voice_run", "export_voice_evidence"], evaluation: "exact_production_shared_validator_matrix_and_authoritative_zero_allocation_recovery", support: "supported" },
  "V-D01": { summary: "Capture exceeds 500 browser events", requiredTools: ["start_voice_run", "inspect_voice_run", "end_voice_run", "export_voice_evidence"], evaluation: "gap_free_monotonic_paged_capture", support: "supported" },
  "V-D02": { summary: "API reattach and browser-worker loss distinction", requiredTools: ["start_voice_run", "inspect_voice_run", "export_voice_evidence"], evaluation: "fresh_durable_api_reader_reattach_then_truthful_abort_recovery_no_duplicate_injection", support: "supported" },
  "V-L01": { summary: "Supplemental LangSmith evidence adapter unavailable", requiredTools: ["start_voice_run", "speak", "end_voice_run", "export_voice_evidence"], evaluation: "governed_trace_adapter_outage_typed_unavailable_while_local_evidence_remains_durable", support: "supported" },
  "V-P01": { summary: "Fresh-agent private plugin flow", requiredTools: ["get_capabilities", "start_voice_run", "speak", "wait_for_turn", "inspect_voice_run", "end_voice_run", "export_voice_evidence"], evaluation: "tool_only_flow_without_credentials_or_manual_takeover", support: "supported" },
};

export const SCENARIO_CATALOG = SCENARIO_IDS.map((id) => ({ id, version: SCENARIO_CATALOG_VERSION, ...DEFINITIONS[id] }));
export const ScenarioIdSet: ReadonlySet<string> = new Set(SCENARIO_IDS);
