import { createHmac, createPublicKey, randomUUID, timingSafeEqual, verify as verifySignature } from "node:crypto";

import { z } from "zod";

import { FINAL_CODEX_PLUGIN_VERSION_PATTERN, type VoiceLabConfig } from "./config.js";
import { D02GatewayClient, D02GatewayContinuityObservationReceiptSchema } from "./d02-gateway.js";
import type { TtsEngineInfo } from "./audio.js";
import {
  CONTRACT_VERSION,
  SCENARIO_CATALOG_VERSION,
  CapturePolicySchema,
  IdempotencyKeySchema,
  RunIdSchema,
  SuiteIdSchema,
  TargetSchema,
  TERMINAL_RUN_STATES,
  VoiceLabError,
  initialVerdicts,
  labError,
  type LabEnvelope,
  type LabError,
  type OperationRecord,
  type RunRecord,
  type SuiteRecord,
  type TargetSpec,
} from "./domain.js";
import type { EventClaimSnapshot, RollingAdmissionFence, RollingAdmissionLimits, VoiceLabLedger } from "./ledger.js";
import { canonicalRequestHash, projectPublicData, requireScope, sha256, validateAllowedOrigin, type AuthenticatedCaller } from "./security.js";
import { assertRunAcceptsOperation } from "./state-machine.js";
import { SCENARIO_CATALOG, SCENARIO_IDS } from "./scenarios.js";

const StartSchema = z.object({
  environment: z.enum(["production", "staging"]),
  target: TargetSchema,
  scenario_id: z.enum(SCENARIO_IDS).optional(),
  scenario_version: z.literal(SCENARIO_CATALOG_VERSION).optional(),
  capture_policy: CapturePolicySchema.optional(),
  idempotency_key: IdempotencyKeySchema,
}).strict();

const AudioInputSchema = z.object({
  text: z.string().min(1).optional(),
  fixture_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
}).refine((value) => Number(value.text !== undefined) + Number(value.fixture_id !== undefined) === 1, "Exactly one of text or fixture_id is required.");

const FollowupIntentSchema = z.enum(["clarify", "deepen", "verify", "redirect", "summarize"]);
const ObservationClassSchema = z.enum(["assistant_turn_complete", "assistant_question", "assistant_result", "assistant_uncertainty", "assistant_commitment"]);

const LegacyAdaptiveObservationSchema = z.object({
  event_seq: z.number().int().positive(),
  turn_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  observation_class: ObservationClassSchema,
  followup_intent: FollowupIntentSchema,
}).strict();

const ObservationReceiptSchema = z.object({
  schema: z.literal("sophia_voice_lab_observation_receipt_v1"),
  run_id: RunIdSchema,
  test_run_id: RunIdSchema,
  scenario_id: z.literal("V-P01"),
  scenario_version: z.literal(SCENARIO_CATALOG_VERSION),
  deployment_identity_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  event_seq: z.number().int().positive(),
  turn_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  observation_class: ObservationClassSchema,
  issued_at: z.string().datetime({ offset: true }),
  receipt_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const P01AdaptiveObservationSchema = z.object({
  receipt: ObservationReceiptSchema,
  followup_intent: FollowupIntentSchema,
}).strict();

const AdaptiveObservationSchema = z.union([LegacyAdaptiveObservationSchema, P01AdaptiveObservationSchema]);

const SpeakSchema = z.object({
  run_id: RunIdSchema,
  text: z.string().min(1).optional(),
  fixture_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  idempotency_key: IdempotencyKeySchema,
  expected_cursor: z.number().int().nonnegative().optional(),
  expected_provider_epoch: z.number().int().nonnegative().optional(),
  expected_turn_id: z.string().min(1).max(128).optional(),
  adaptive_observation: AdaptiveObservationSchema.optional(),
  timing_policy: z.object({
    delay_ms: z.number().int().min(0).max(10_000).default(0),
    schedule_timeout_ms: z.number().int().min(100).max(30_000).default(10_000),
  }).strict().optional(),
}).strict().refine((value) => Number(value.text !== undefined) + Number(value.fixture_id !== undefined) === 1, "Exactly one of text or fixture_id is required.");

const AudioAdmissionReceiptSchema = z.object({
  duration_ms: z.number().int().positive(),
  bytes: z.number().int().positive(),
}).strict();

const ActiveToolBoundarySchema = z.object({
  event_seq: z.number().int().positive(),
  tool_call_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  effect_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();
const BargeSchema = SpeakSchema.safeExtend({
  after_output_event_seq: z.number().int().positive(),
  delay_ms: z.number().int().min(0).max(10_000).default(0),
  max_lateness_ms: z.number().int().min(0).max(2_000).default(200),
  tool_boundary: ActiveToolBoundarySchema.optional(),
});

const WaitSchema = z.object({
  run_id: RunIdSchema,
  after_cursor: z.number().int().nonnegative(),
  condition: z.enum(["any_event", "input_transcription", "assistant_first_audio", "assistant_turn_complete", "tool_call", "tool_settlement", "task_state", "ui_projection", "session_lifecycle_state", "operation_terminal"]),
  operation_id: z.string().uuid().optional(),
  timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
}).strict().superRefine((value, context) => {
  if (value.condition === "operation_terminal" && !value.operation_id) context.addIssue({ code: "custom", path: ["operation_id"], message: "operation_id is required for operation_terminal." });
  if (value.condition !== "operation_terminal" && value.operation_id) context.addIssue({ code: "custom", path: ["operation_id"], message: "operation_id is only valid for operation_terminal." });
});

const InspectSchema = z.object({ run_id: RunIdSchema, after_cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(100) }).strict();
const CommitTargetSchema = z.discriminatedUnion("kind", [
  z.object({ event_seq: z.number().int().positive(), kind: z.literal("output_realization"), stable_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/) }).strict(),
  z.object({ event_seq: z.number().int().positive(), kind: z.literal("tool_settlement"), stable_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/), effect_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/) }).strict(),
]);
const RotateSchema = z.object({
  run_id: RunIdSchema,
  expected_socket_epoch: z.number().int().nonnegative(),
  commit_target: CommitTargetSchema.optional(),
  idempotency_key: IdempotencyKeySchema,
}).strict();
const EndSchema = z.object({ run_id: RunIdSchema, idempotency_key: IdempotencyKeySchema, wait_timeout_ms: z.number().int().min(100).max(180_000).optional() }).strict();
const ExportSchema = z.object({ run_id: RunIdSchema }).strict();
const SuiteSchema = z.object({
  environment: z.enum(["production", "staging"]),
  target: TargetSchema,
  scenarios: z.array(z.object({ id: z.enum(SCENARIO_IDS), version: z.literal(SCENARIO_CATALOG_VERSION).optional() }).strict()).min(1).max(21),
  idempotency_key: IdempotencyKeySchema,
  capture_policy: CapturePolicySchema.optional(),
  max_concurrency: z.literal(1).default(1),
}).strict().superRefine((value, context) => {
  const keys = value.scenarios.map((scenario) => `${scenario.id}\u0000${scenario.version ?? SCENARIO_CATALOG_VERSION}`);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["scenarios"], message: "Duplicate scenario ID/version pairs are not permitted." });
});
const GetSuiteSchema = z.object({ suite_run_id: SuiteIdSchema }).strict();
const ExternalShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ExternalTimestampSchema = z.string().datetime({ offset: true });
const ExternalDeploymentSchema = z.object({ frontend: z.string().regex(/^[a-f0-9]{40}$/), backend: z.string().regex(/^[a-f0-9]{40}$/), voice: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
export const D02BrowserContinuityQuerySchema = z.object({
  run_id: RunIdSchema,
  restart_request_id_sha256: ExternalShaSchema,
  operation_id: z.string().uuid(),
  after_boot_id_sha256: ExternalShaSchema,
}).strict();
const D02BrowserContinuityProofCoreSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_browser_continuity_v1"),
  run_id_sha256: ExternalShaSchema,
  restart_request_id_sha256: ExternalShaSchema,
  operation_id_sha256: ExternalShaSchema,
  after_boot_id_sha256: ExternalShaSchema,
  browser_worker_id_sha256: ExternalShaSchema,
  browser_lease_epoch: z.number().int().positive(),
  browser_lease_updated_at: ExternalTimestampSchema,
  browser_lease_expires_at: ExternalTimestampSchema,
  replay_event_seq: z.number().int().positive(),
  replay_observed_at: ExternalTimestampSchema,
  observed_at: ExternalTimestampSchema,
  runtime_acquisition_count: z.literal(1),
  loss_or_replacement_count: z.literal(0),
  continuity_proven: z.literal(true),
}).strict();
export const D02BrowserContinuityProofSchema = D02BrowserContinuityProofCoreSchema.extend({ proof_sha256: ExternalShaSchema }).strict().superRefine((value, context) => {
  const { proof_sha256, ...core } = value;
  if (proof_sha256 !== canonicalRequestHash(core)) context.addIssue({ code: "custom", path: ["proof_sha256"], message: "D02 browser continuity proof hash is invalid." });
  if (!orderedTimestamps(value.replay_observed_at, value.browser_lease_updated_at, value.observed_at, value.browser_lease_expires_at)
    || new Date(value.replay_observed_at).getTime() === new Date(value.browser_lease_updated_at).getTime()) {
    context.addIssue({ code: "custom", path: ["browser_lease_updated_at"], message: "D02 browser lease heartbeat must be strictly after replay and live at observation." });
  }
});
export type D02BrowserContinuityProof = z.infer<typeof D02BrowserContinuityProofSchema>;
export const D02BrowserWorkerLossQuerySchema = z.object({
  run_id: RunIdSchema,
  termination_request_id_sha256: ExternalShaSchema,
}).strict();
const CanonicalUuidV4Schema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const D02RenderWorkerDispatchClaimRequestSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_render_worker_dispatch_claim_request_v1"),
  run_id: RunIdSchema,
  termination_request_id: CanonicalUuidV4Schema,
  command_attestation_id: CanonicalUuidV4Schema,
  command_content_sha256: ExternalShaSchema,
  command_event_seq: z.number().int().positive(),
  worker_service_id_sha256: ExternalShaSchema,
  action_request_sha256: ExternalShaSchema,
  dispatch_attempt_id: CanonicalUuidV4Schema,
  requested_at: ExternalTimestampSchema,
}).strict();
export const D02RenderWorkerDispatchClaimResponseSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_render_worker_dispatch_claim_v1"),
  claimed: z.literal(true),
  idempotent_replay: z.boolean(),
  termination_request_id_sha256: ExternalShaSchema,
  dispatch_attempt_id_sha256: ExternalShaSchema,
  action_request_sha256: ExternalShaSchema,
  dispatch_claim_sha256: ExternalShaSchema,
  event_seq: z.number().int().positive(),
  claimed_at: ExternalTimestampSchema,
}).strict();
export type D02RenderWorkerDispatchClaimRequest = z.infer<typeof D02RenderWorkerDispatchClaimRequestSchema>;
export type D02RenderWorkerDispatchClaimResponse = z.infer<typeof D02RenderWorkerDispatchClaimResponseSchema>;
const D02GatewayFreezeEventSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_gateway_freeze_event_v1"),
  termination_request_id_sha256: ExternalShaSchema,
  freeze_request_sha256: ExternalShaSchema,
  voice_lab_run_id_sha256: ExternalShaSchema,
  cleanup_obligation_id_sha256: ExternalShaSchema,
  provider_session_id_sha256: ExternalShaSchema,
  provider_admission_id_sha256: ExternalShaSchema,
  provider_connection_epoch: z.number().int().positive(),
  frozen_provider_connection_epochs: z.array(z.number().int().positive()).min(1).max(64),
  browser_worker_id_sha256: ExternalShaSchema,
  browser_lease_epoch: z.number().int().positive(),
  browser_context_id_sha256: ExternalShaSchema,
  render_action_request_sha256: ExternalShaSchema,
  gateway_frozen: z.literal(true),
  raw_product_identifiers_excluded: z.literal(true),
}).strict();
const D02LocalFreezeIntentEventSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_local_browser_worker_freeze_intent_v1"),
  termination_request_id_sha256: ExternalShaSchema,
  command_evidence_sha256: ExternalShaSchema,
  voice_lab_run_id_sha256: ExternalShaSchema,
  cleanup_obligation_id_sha256: ExternalShaSchema,
  provider_session_id_sha256: ExternalShaSchema,
  provider_admission_id_sha256: ExternalShaSchema,
  provider_connection_epoch: z.number().int().positive(),
  frozen_provider_connection_epochs: z.array(z.number().int().positive()).min(1).max(64),
  browser_worker_id_sha256: ExternalShaSchema,
  browser_lease_epoch: z.number().int().positive(),
  browser_context_id_sha256: ExternalShaSchema,
  render_action_request_sha256: ExternalShaSchema,
  requested_at: ExternalTimestampSchema,
  raw_run_operation_provider_and_browser_identifiers_excluded: z.literal(true),
}).strict();
const D02RenderWorkerDispatchEventSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_render_worker_dispatch_claim_v1"),
  termination_request_id_sha256: ExternalShaSchema,
  command_attestation_id_sha256: ExternalShaSchema,
  command_content_sha256: ExternalShaSchema,
  command_event_seq: z.number().int().positive(),
  worker_service_id_sha256: ExternalShaSchema,
  action_request_sha256: ExternalShaSchema,
  dispatch_attempt_id_sha256: ExternalShaSchema,
  requested_at: ExternalTimestampSchema,
  raw_action_and_attempt_identifiers_excluded: z.literal(true),
  dispatch_claim_sha256: ExternalShaSchema,
}).strict();
const D02WorkerShutdownEventSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_browser_worker_shutdown_observation_v1"),
  termination_request_id_sha256: ExternalShaSchema,
  voice_lab_run_id_sha256: ExternalShaSchema,
  cleanup_obligation_id_sha256: ExternalShaSchema,
  lost_browser_worker_id_sha256: ExternalShaSchema,
  lost_browser_lease_epoch: z.number().int().positive(),
  browser_context_id_sha256: ExternalShaSchema,
  provider_session_id_sha256: ExternalShaSchema,
  provider_admission_id_sha256: ExternalShaSchema,
  provider_connection_epoch: z.number().int().positive(),
  frozen_provider_connection_epochs: z.array(z.number().int().positive()).min(1).max(64),
  render_action_request_sha256: ExternalShaSchema,
  gateway_freeze_request_sha256: ExternalShaSchema,
  gateway_freeze_event_seq: z.number().int().positive(),
  command_event_seq: z.number().int().positive(),
  render_dispatch_claim_sha256: ExternalShaSchema,
  render_dispatch_claim_event_seq: z.number().int().positive(),
  product_provider_cleanup_acknowledged: z.literal(true),
  product_provider_cleanup_settlement_sha256: ExternalShaSchema,
  product_provider_close_receipt_count: z.number().int().nonnegative(),
  product_provider_activation_abort_receipt_count: z.number().int().nonnegative(),
  product_provider_cleanup_epoch_union_matches_freeze: z.literal(true),
  browser_context_closed: z.literal(true),
  source: z.literal("worker_graceful_d02_restart"),
  raw_run_worker_lease_context_and_product_identifiers_excluded: z.literal(true),
  observed_at: ExternalTimestampSchema,
}).strict();
const D02WorkerLossCrossJoinEventSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_browser_worker_loss_cross_join_v1"),
  termination_request_id_sha256: ExternalShaSchema,
  lost_worker_id_sha256: ExternalShaSchema,
  replacement_worker_id_sha256: ExternalShaSchema,
  lost_browser_lease_epoch: z.number().int().positive(),
  browser_context_id_sha256: ExternalShaSchema,
  old_worker_shutdown_event_seq: z.number().int().positive(),
  render_dispatch_claim_sha256: ExternalShaSchema,
  render_dispatch_claim_event_seq: z.number().int().positive(),
  lease_expired_at: z.null(),
  loss_observed_at: ExternalTimestampSchema,
  loss_source: z.literal("worker_graceful_d02_restart_cross_join"),
  raw_worker_identifiers_excluded: z.literal(true),
}).strict();
const D02WorkerReplacementEventSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_browser_worker_replacement_observation_v1"),
  termination_request_id_sha256: ExternalShaSchema,
  lost_browser_worker_id_sha256: ExternalShaSchema,
  replacement_browser_worker_id_sha256: ExternalShaSchema,
  lost_browser_lease_epoch: z.number().int().positive(),
  browser_context_id_sha256: ExternalShaSchema,
  old_worker_shutdown_event_seq: z.number().int().positive(),
  loss_event_seq: z.number().int().positive(),
  render_dispatch_claim_sha256: ExternalShaSchema,
  source: z.literal("replacement_worker_startup_after_graceful_d02_restart"),
  raw_worker_identifiers_excluded: z.literal(true),
}).strict();
const D02BrowserWorkerLossObservationCoreSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_browser_worker_loss_observation_v1"),
  run_id_sha256: ExternalShaSchema,
  test_run_id_sha256: ExternalShaSchema,
  cleanup_obligation_id_sha256: ExternalShaSchema,
  termination_request_id_sha256: ExternalShaSchema,
  provider_session_id_sha256: ExternalShaSchema,
  provider_admission_id_sha256: ExternalShaSchema,
  provider_connection_epoch: z.number().int().positive(),
  frozen_provider_connection_epochs: z.array(z.number().int().positive()).min(1).max(64),
  product_provider_cleanup_settlement_sha256: ExternalShaSchema,
  browser_context_id_sha256: ExternalShaSchema,
  lost_browser_worker_id_sha256: ExternalShaSchema,
  replacement_browser_worker_id_sha256: ExternalShaSchema,
  lost_browser_lease_epoch: z.number().int().positive(),
  loss_event_seq: z.number().int().positive(),
  loss_observed_at: ExternalTimestampSchema,
  observed_at: ExternalTimestampSchema,
  terminal_state: z.literal("aborted_driver_restart"),
  terminal_error_code: z.literal("BROWSER_SESSION_LOST"),
  browser_lease_absent: z.literal(true),
  owning_gateway_settlement_included: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.lost_browser_worker_id_sha256 === value.replacement_browser_worker_id_sha256) context.addIssue({ code: "custom", path: ["replacement_browser_worker_id_sha256"], message: "Replacement worker identity must differ from the lost worker." });
  if (new Set(value.frozen_provider_connection_epochs).size !== value.frozen_provider_connection_epochs.length
    || value.frozen_provider_connection_epochs.some((epoch, index) => index > 0 && epoch <= value.frozen_provider_connection_epochs[index - 1]!)) {
    context.addIssue({ code: "custom", path: ["frozen_provider_connection_epochs"], message: "Frozen provider epochs must be unique and strictly ascending." });
  }
  if (!value.frozen_provider_connection_epochs.includes(value.provider_connection_epoch)) context.addIssue({ code: "custom", path: ["provider_connection_epoch"], message: "Current provider epoch must be present in the frozen epoch set." });
  if (!orderedTimestamps(value.loss_observed_at, value.observed_at)) context.addIssue({ code: "custom", path: ["observed_at"], message: "Worker-loss observation predates the durable loss event." });
});
export const D02BrowserWorkerLossObservationSchema = D02BrowserWorkerLossObservationCoreSchema.extend({ proof_sha256: ExternalShaSchema }).strict().superRefine((value, context) => {
  const { proof_sha256, ...core } = value;
  if (proof_sha256 !== canonicalRequestHash(core)) context.addIssue({ code: "custom", path: ["proof_sha256"], message: "D02 browser-worker loss observation hash is invalid." });
});
export type D02BrowserWorkerLossObservation = z.infer<typeof D02BrowserWorkerLossObservationSchema>;
const PlatformToolNameSchema = z.enum(["get_capabilities", "start_voice_run", "wait_for_turn", "speak", "inspect_voice_run", "end_voice_run", "export_voice_evidence"]);
const PlatformCallFields = {
  tool_name: PlatformToolNameSchema,
  argument_sha256: ExternalShaSchema,
  response_sha256: ExternalShaSchema,
  result_request_id_sha256: ExternalShaSchema,
  run_id_sha256: ExternalShaSchema.nullable(),
  operation_id_sha256: ExternalShaSchema.nullable(),
  polled_operation_id_sha256: ExternalShaSchema.nullable(),
} as const;
const PlatformCallSchema = z.object({
  ...PlatformCallFields,
  spine_ordinal: z.number().int().min(1).max(10),
  chronological_ordinal: z.number().int().min(1).max(30),
}).strict();
const PlatformPollingCallSchema = z.object({
  ...PlatformCallFields,
  tool_name: z.literal("wait_for_turn"),
  operation_id_sha256: z.null(),
  poll_ordinal: z.number().int().min(1).max(20),
  chronological_ordinal: z.number().int().min(1).max(30),
  polled_operation_id_sha256: ExternalShaSchema,
}).strict();
export const ExternalAttestationEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("a03_http_response_loss"), authority: z.literal("external_mcp_client"), operation_id: z.string().uuid(), replayed_operation_id: z.string().uuid(),
    request_sha256: ExternalShaSchema, idempotency_key_sha256: ExternalShaSchema, initial_client_request_id_sha256: ExternalShaSchema, retry_client_request_id_sha256: ExternalShaSchema,
    retry_response_sha256: ExternalShaSchema,
    accepted_at: ExternalTimestampSchema, response_lost_at: ExternalTimestampSchema, retry_at: ExternalTimestampSchema,
    transport_outcome: z.literal("connection_closed_after_durable_acceptance"), initial_response_observed: z.literal(false),
  }).strict(),
  z.object({
    kind: z.literal("d02_restart_command"), authority: z.literal("deployment_control"), restart_request_id: z.string().uuid(), operation_id: z.string().uuid(),
    request_sha256: ExternalShaSchema, idempotency_key_sha256: ExternalShaSchema, before_boot_id_sha256: ExternalShaSchema, before_instance_id_sha256: ExternalShaSchema,
    before_version_response_sha256: ExternalShaSchema, browser_worker_id_sha256: ExternalShaSchema, browser_lease_epoch: z.number().int().positive(),
    provider_restart_request_sha256: ExternalShaSchema,
    requested_at: ExternalTimestampSchema, target_service: z.literal("sophia-voice-lab-mcp"), restart_mode: z.literal("one_shot_after_durable_acceptance"),
    response_loss_expected: z.literal(true), provider_mutation_authorized: z.literal(false), one_shot: z.literal(true),
  }).strict(),
  z.object({
    kind: z.literal("d02_browser_worker_termination_command"), authority: z.literal("deployment_control"), termination_request_id: z.string().uuid(),
    run_id_sha256: ExternalShaSchema, cleanup_obligation_id_sha256: ExternalShaSchema, worker_service_id_sha256: ExternalShaSchema,
    provider_session_id_sha256: ExternalShaSchema, provider_admission_id_sha256: ExternalShaSchema, provider_connection_epoch: z.number().int().positive(),
    frozen_provider_connection_epochs: z.array(z.number().int().positive()).min(1).max(64), browser_worker_id_sha256: ExternalShaSchema,
    browser_lease_epoch: z.number().int().positive(), browser_context_id_sha256: ExternalShaSchema, before_worker_deploy_id_sha256: ExternalShaSchema,
    before_worker_instance_set_sha256: ExternalShaSchema, before_worker_owner_instance_id_sha256: ExternalShaSchema, before_worker_owner_membership_count: z.literal(1),
    render_action_request_sha256: ExternalShaSchema, requested_at: ExternalTimestampSchema,
    target_service: z.literal("sophia-voice-lab-worker"), termination_mode: z.literal("render_service_restart_one_shot"), worker_mutation_authorized: z.literal(true),
    product_mutation_authorized: z.literal(false), one_shot: z.literal(true),
  }).strict(),
  z.object({
    kind: z.literal("d02_api_process_restart"), authority: z.literal("deployment_control"), operation_id: z.string().uuid(), request_sha256: ExternalShaSchema, idempotency_key_sha256: ExternalShaSchema,
    before_boot_id_sha256: ExternalShaSchema, after_boot_id_sha256: ExternalShaSchema, restart_request_id_sha256: ExternalShaSchema,
    before_instance_id_sha256: ExternalShaSchema, after_instance_id_sha256: ExternalShaSchema, before_version_response_sha256: ExternalShaSchema, after_version_response_sha256: ExternalShaSchema,
    original_receipt_sha256: ExternalShaSchema, replay_receipt_sha256: ExternalShaSchema, browser_worker_id_sha256: ExternalShaSchema, browser_lease_epoch: z.number().int().positive(),
    canonical_session_id_sha256: ExternalShaSchema, thread_id_sha256: ExternalShaSchema, provider_session_id_sha256: ExternalShaSchema, provider_connection_epoch: z.number().int().positive(),
    restart_requested_at: ExternalTimestampSchema, new_process_started_at: ExternalTimestampSchema, replay_observed_at: ExternalTimestampSchema,
    provider_restart_request_sha256: ExternalShaSchema, provider_restart_accepted_response_sha256: ExternalShaSchema, local_controller_receipt_sha256: ExternalShaSchema,
    browser_continuity_proof: D02BrowserContinuityProofSchema,
    old_process_exited: z.literal(true), new_process_started: z.literal(true), browser_worker_continuity: z.literal(true), duplicate_injection_count: z.literal(0),
  }).strict(),
  z.object({
    kind: z.literal("d02_browser_worker_loss"), authority: z.literal("deployment_control"), termination_request_id_sha256: ExternalShaSchema,
    local_controller_receipt_sha256: ExternalShaSchema, run_id_sha256: ExternalShaSchema, cleanup_obligation_id_sha256: ExternalShaSchema,
    worker_service_id_sha256: ExternalShaSchema, provider_session_id_sha256: ExternalShaSchema, provider_admission_id_sha256: ExternalShaSchema,
    provider_connection_epoch: z.number().int().positive(), frozen_provider_connection_epochs: z.array(z.number().int().positive()).min(1).max(64),
    product_provider_cleanup_settlement_sha256: ExternalShaSchema,
    browser_context_id_sha256: ExternalShaSchema, lost_worker_id_sha256: ExternalShaSchema, replacement_worker_id_sha256: ExternalShaSchema,
    lost_browser_lease_epoch: z.number().int().positive(), loss_event_seq: z.number().int().positive(), loss_observed_at: ExternalTimestampSchema,
    render_action_request_sha256: ExternalShaSchema, render_action_accepted_response_sha256: ExternalShaSchema, render_action_settled_snapshot_sha256: ExternalShaSchema,
    before_service_response_sha256: ExternalShaSchema, after_service_response_sha256: ExternalShaSchema, before_deploy_id_sha256: ExternalShaSchema,
    after_deploy_id_sha256: ExternalShaSchema, before_instance_set_sha256: ExternalShaSchema, after_instance_set_sha256: ExternalShaSchema,
    lost_worker_owner_instance_id_sha256: ExternalShaSchema, lost_worker_present_before_restart: z.literal(true), lost_worker_absent_after_restart: z.literal(true),
    replacement_worker_owner_instance_id_sha256: ExternalShaSchema, replacement_worker_owner_membership_count: z.literal(1),
    render_dispatch_claim_sha256: ExternalShaSchema,
    command_requested_at: ExternalTimestampSchema, action_requested_at: ExternalTimestampSchema, action_accepted_at: ExternalTimestampSchema, action_settled_at: ExternalTimestampSchema,
    action_kind: z.literal("render_worker_service_restart"), restart_http_status: z.literal(200), old_worker_instances_absent: z.literal(true),
    replacement_worker_instances_observed: z.literal(true), gateway_settlement_receipt_included: z.literal(false),
  }).strict(),
  z.object({
    kind: z.literal("p01_platform_plugin_task"), authority: z.literal("platform_plugin"), registered_app_id: z.string().regex(/^plugin_asdk_app[0-9A-Za-z_-]{4,112}$/), plugin_version: z.string().regex(FINAL_CODEX_PLUGIN_VERSION_PATTERN),
    platform_task_id_sha256: ExternalShaSchema, platform_thread_id_sha256: ExternalShaSchema, install_receipt_sha256: ExternalShaSchema,
    plugin_package_sha256: ExternalShaSchema, installed_at: ExternalTimestampSchema, fresh_task_started_at: ExternalTimestampSchema, fresh_task_completed_at: ExternalTimestampSchema, high_level_call_count: z.number().int().min(1).max(10),
    calls: z.array(PlatformCallSchema).length(10), polling_call_count: z.number().int().min(0).max(20), polling_calls: z.array(PlatformPollingCallSchema).max(20), operation_ids: z.array(z.string().uuid()).min(4).max(10),
    adaptive_observation_call_ordinal: z.literal(5), adaptive_followup_call_ordinal: z.literal(6),
    prohibited_tool_audit_passed: z.literal(true), raw_javascript_used: z.literal(false), local_runner_used: z.literal(false), manual_takeover_used: z.literal(false), exact_deployment_discovered: z.literal(true), adaptive_followup_completed: z.literal(true),
  }).strict(),
]);
export const ExternalAttestationSchema = z.object({
  schema: z.literal("sophia_voice_lab_external_attestation_v1"), attestation_id: z.string().uuid(), run_id: RunIdSchema, test_run_id_sha256: ExternalShaSchema,
  cleanup_obligation_id_sha256: ExternalShaSchema,
  scenario_id: z.enum(SCENARIO_IDS), scenario_version: z.literal(SCENARIO_CATALOG_VERSION), environment: z.enum(["production", "staging"]), expected_deployment: ExternalDeploymentSchema,
  issuer: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/), audience: z.literal("sophia-voice-lab-attestation"), authority_key_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/), jti: z.string().uuid(), nonce: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
  issued_at: ExternalTimestampSchema, expires_at: ExternalTimestampSchema, signature_algorithm: z.literal("ed25519-sha256-canonical-request-v1"), signature: z.string().min(80).max(96).regex(/^[A-Za-z0-9_-]+$/), evidence: ExternalAttestationEvidenceSchema,
}).strict();

export const toolInputSchemas = {
  get_capabilities: z.object({}).strict(),
  start_voice_run: StartSchema,
  speak: SpeakSchema,
  wait_for_turn: WaitSchema,
  inspect_voice_run: InspectSchema,
  barge_in: BargeSchema,
  force_socket_rotation: RotateSchema,
  end_voice_run: EndSchema,
  export_voice_evidence: ExportSchema,
  run_regression_suite: SuiteSchema,
  get_suite_run: GetSuiteSchema,
} as const;

export interface FixtureSummary {
  id: string;
  fixtureVersion: string;
  family: string;
  fixtureClass: "short_command" | "long_brief" | "silence" | "trailing_pause" | "noisy_command";
  sha256: string;
  sampleRate: number;
  channels: number;
  durationMs: number;
  sourceText: { status: "unavailable"; reason: string } | { status: "available"; sha256: string; governed_source_id: string; expected_tokens: string[]; expected_slots: Record<string, unknown> };
  synthesis: { engine: string; engine_version: string; voice: string; rate: string };
  provenance: { kind: string; suite: string; manifestVersion: number };
  assertionPolicy: { expect_transcript: boolean; semantic_threshold: string; trailing_silence_ms?: number; noise_seed?: string };
}

/** Shared admission validators used by both the MCP boundary and the governed
 * pre-resource security recipe. Keeping the recipe on the exact production
 * functions prevents a test-only approximation from certifying V-S02. */
export function validateAudioInputLimit(input: { text?: string | undefined }, maxTextCharacters: number): void {
  if (input.text !== undefined && [...input.text].length > maxTextCharacters) {
    throw new VoiceLabError(labError("TEXT_TOO_LARGE", "Text exceeds the configured TTS character limit.", "validation"));
  }
}

export async function reserveAudioInput(
  input: { text?: string | undefined; fixture_id?: string | undefined },
  fixtures: readonly FixtureSummary[],
  config: Pick<VoiceLabConfig, "maxAudioDurationMs" | "maxAudioBytes">,
): Promise<{ duration_ms: number; bytes: number }> {
  if (input.fixture_id) {
    const fixture = fixtures.find((candidate) => candidate.id === input.fixture_id);
    if (!fixture) throw new VoiceLabError(labError("FIXTURE_NOT_FOUND", `Fixture ${input.fixture_id} is not allowlisted.`, "validation"));
    if (fixture.durationMs > config.maxAudioDurationMs) throw new VoiceLabError(labError("AUDIO_DURATION_LIMIT", "Fixture exceeds the per-utterance duration limit.", "validation"));
    const bytes = Math.ceil(fixture.durationMs * fixture.sampleRate * fixture.channels * 2 / 1_000) + 44;
    if (bytes > config.maxAudioBytes) throw new VoiceLabError(labError("AUDIO_TOO_LARGE", "Fixture reservation exceeds the per-utterance audio byte limit.", "validation"));
    return { duration_ms: fixture.durationMs, bytes };
  }
  const words = input.text?.trim().split(/\s+/u).filter(Boolean).length ?? 0;
  const durationMs = Math.min(config.maxAudioDurationMs, Math.max(500, Math.ceil(words / 155 * 60_000) + 1_000));
  const bytes = Math.ceil(durationMs * 22_050 * 2 / 1_000) + 44;
  if (bytes > config.maxAudioBytes) throw new VoiceLabError(labError("AUDIO_TOO_LARGE", "TTS reservation exceeds the per-utterance audio byte limit.", "validation"));
  return { duration_ms: durationMs, bytes };
}

function publicSpeakArgumentHash(operation: OperationRecord | undefined): string | null {
  if (!operation || operation.type !== "speak" || canonicalRequestHash(operation.input) !== operation.requestHash) return null;
  const internalKeys = Object.keys(operation.input).filter((key) => key.startsWith("_"));
  if (internalKeys.length !== 1 || internalKeys[0] !== "_admission" || !AudioAdmissionReceiptSchema.safeParse(operation.input._admission).success) return null;
  const publicInput = Object.fromEntries(Object.entries(operation.input).filter(([key]) => key !== "_admission"));
  const parsed = SpeakSchema.safeParse(publicInput);
  if (!parsed.success || parsed.data.run_id !== operation.runId || parsed.data.idempotency_key !== operation.idempotencyKey
    || canonicalRequestHash(parsed.data) !== canonicalRequestHash(publicInput)) return null;
  return canonicalRequestHash(publicInput);
}

function p01ObservationReceiptMac(secret: string, receipt: Omit<z.infer<typeof ObservationReceiptSchema>, "receipt_sha256">): string {
  return createHmac("sha256", secret)
    .update("sophia-voice-lab-observation-receipt-v1\n", "utf8")
    .update(canonicalRequestHash(receipt), "ascii")
    .digest("hex");
}

function p01ObservationReceiptMacMatches(secret: string, receipt: z.infer<typeof ObservationReceiptSchema>): boolean {
  const { receipt_sha256: actual, ...core } = receipt;
  const expected = p01ObservationReceiptMac(secret, core);
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function publicP01OperationArgumentHash(operation: OperationRecord): string | null {
  if (operation.type === "speak") return publicSpeakArgumentHash(operation);
  if (operation.type !== "start" && operation.type !== "end") return null;
  if (Object.keys(operation.input).some((key) => key.startsWith("_")) || canonicalRequestHash(operation.input) !== operation.requestHash) return null;
  if (operation.type === "start") {
    const parsed = StartSchema.safeParse(operation.input);
    if (!parsed.success || canonicalRequestHash(parsed.data) !== operation.requestHash || parsed.data.idempotency_key !== operation.idempotencyKey) return null;
    return operation.requestHash;
  }
  const parsed = EndSchema.safeParse(operation.input);
  if (!parsed.success || canonicalRequestHash(parsed.data) !== operation.requestHash
    || parsed.data.run_id !== operation.runId || parsed.data.idempotency_key !== operation.idempotencyKey) return null;
  return operation.requestHash;
}

export class VoiceLabService {
  constructor(
    readonly ledger: VoiceLabLedger,
    readonly config: VoiceLabConfig,
    readonly fixtures: () => Promise<FixtureSummary[]>,
    readonly ttsEngine: () => Promise<TtsEngineInfo> = async () => ({ engine: "espeak-ng", expectedVersion: config.ttsExpectedVersion, observedVersion: null, voice: "en-us", rate: "155-wpm", available: false, status: "unavailable" }),
    readonly targetIdentity: () => Promise<Record<string, unknown> & { ok: boolean }> = async () => ({ ok: false, status: "not_probed", builds: null, reason: config.readinessTarget ? "target_probe_not_injected" : "target_configuration_missing" }),
    readonly d02Gateway: D02GatewayClient = new D02GatewayClient(config),
  ) {}

  async getCapabilities(caller: AuthenticatedCaller, raw: unknown): Promise<LabEnvelope> {
    toolInputSchemas.get_capabilities.parse(raw);
    requireScope(caller, "voice_lab:read");
    const [fixtures, ttsEngine, targetIdentity] = await Promise.all([this.fixtures(), this.ttsEngine(), this.targetIdentity()]);
    const configuredTarget = this.config.readinessTarget;
    return envelope({ status: "ok", data: {
      tools: Object.keys(toolInputSchemas),
      server_version: this.config.serviceVersion,
      versions: { harness: this.config.harnessVersion, mcp: this.config.mcpVersion, plugin: this.config.pluginVersion, evidence_schema: "sophia.voice-lab.evidence.v1", scenario_catalog: SCENARIO_CATALOG_VERSION },
      repository_commits: { base: this.config.repositoryBaseSha, candidate: this.config.repositoryCandidateSha, rollback: this.config.repositoryRollbackSha },
      registered_app: { technical_id: this.config.registeredAppId ?? { status: "pending_registration" }, plugin_package_sha256: this.config.pluginPackageSha256, platform_install_attestation: "required_for_v_p01_and_not_self_asserted" },
      plugin_contract_version: CONTRACT_VERSION,
      environments: [this.config.environment],
      target_environment: configuredTarget ? {
        environment: this.config.environment,
        frontend_url: configuredTarget.frontendUrl,
        gateway_url: configuredTarget.gatewayUrl,
        voice_url: configuredTarget.voiceUrl,
        langgraph_url: configuredTarget.langgraphUrl,
        expected_deployment: configuredTarget.expectedDeployment,
        expected_dependencies: configuredTarget.expectedDependencies,
        current_identity: targetIdentity,
      } : { environment: this.config.environment, status: "unconfigured", current_identity: targetIdentity },
      scenario_versions: [SCENARIO_CATALOG_VERSION],
      scenarios: SCENARIO_CATALOG,
      transport: "streamable-http",
      authentication: { primary_registered_app: "oauth-2.1-authorization-code-pkce-s256-cimd", protected_resource_metadata: this.config.oauth?.metadataUrl ?? "unavailable_in_test", direct_preflight_lane: "separately_scoped_static_bearer" },
      capability_contract: "hmac-sha256-compact-v1",
      persistence: "postgres-required",
      browser: "chromium-web-audio-dynamic-injection",
      tts: { adaptive: { engine: ttsEngine.engine, status: ttsEngine.status, expected_version: ttsEngine.expectedVersion, observed_version: ttsEngine.observedVersion, voice: ttsEngine.voice, rate: ttsEngine.rate }, deterministic_fixture_count: fixtures.length },
      fixtures,
      fixture_families: [...new Set(fixtures.map((fixture) => fixture.family))],
      restricted_fault_capabilities: caller.scopes.has("voice_lab:fault") ? ["force_socket_rotation"] : [],
      evidence_schema_version: "sophia.voice-lab.evidence.v1",
      caller_authorization_scopes: [...caller.scopes].sort(),
      limits: this.publicLimits(),
      raw_audio: "unavailable_until_isolated_storage",
      video: "unavailable_until_isolated_storage",
      kill_switch: this.config.killSwitch ? "engaged" : "open",
    } });
  }

  /** Read-only owning proof used by the independent D02 controller after the
   * web restart and idempotent replay. The caller supplies only immutable
   * identifiers; browser continuity is derived from the current durable lease. */
  async getD02BrowserContinuity(caller: AuthenticatedCaller, raw: unknown): Promise<D02BrowserContinuityProof> {
    requireScope(caller, "voice_lab:attest");
    requireScope(caller, "voice_lab:attest:deployment_control");
    const authority = this.config.attestationAuthorities.deployment_control;
    if (caller.subject !== authority.subject) throw new VoiceLabError(labError("ATTESTATION_AUTHORITY_MISMATCH", "D02 continuity proof requires the deployment-control transport authority.", "authorization"));
    const query = D02BrowserContinuityQuerySchema.parse(raw);
    const run = await this.ledger.getRun(query.run_id);
    if (!run || run.evidencePurgedAt !== null) throw new VoiceLabError(labError("RUN_NOT_FOUND", "Run was not found.", "validation"));
    return this.deriveD02BrowserContinuity(run, query, new Date());
  }

  /** Voice-Lab-authored worker-loss fact for the external Render controller.
   * It intentionally proves only the durable lease loss and abort. Provider,
   * admission, browser-context, and epoch-set settlement remain owned by the
   * Gateway and are never inferred by this endpoint. */
  async getD02BrowserWorkerLossObservation(caller: AuthenticatedCaller, raw: unknown): Promise<D02BrowserWorkerLossObservation> {
    requireScope(caller, "voice_lab:attest");
    requireScope(caller, "voice_lab:attest:deployment_control");
    const authority = this.config.attestationAuthorities.deployment_control;
    if (caller.subject !== authority.subject) throw new VoiceLabError(labError("ATTESTATION_AUTHORITY_MISMATCH", "D02 worker-loss observation requires the deployment-control transport authority.", "authorization"));
    const query = D02BrowserWorkerLossQuerySchema.parse(raw);
    const run = await this.ledger.getRun(query.run_id);
    if (!run || run.evidencePurgedAt !== null) throw new VoiceLabError(labError("RUN_NOT_FOUND", "Run was not found.", "validation"));
    return this.deriveD02BrowserWorkerLossObservation(run, query, new Date());
  }

  async claimD02RenderWorkerDispatch(caller: AuthenticatedCaller, raw: unknown): Promise<D02RenderWorkerDispatchClaimResponse> {
    requireScope(caller, "voice_lab:attest");
    requireScope(caller, "voice_lab:attest:deployment_control");
    const authority = this.config.attestationAuthorities.deployment_control;
    if (caller.subject !== authority.subject) throw new VoiceLabError(labError("ATTESTATION_AUTHORITY_MISMATCH", "D02 Render dispatch requires the deployment-control transport authority.", "authorization"));
    const input = D02RenderWorkerDispatchClaimRequestSchema.parse(raw);
    const requestedAt = new Date(input.requested_at);
    const terminationRequestIdSha256 = sha256(input.termination_request_id);
    const core = {
      schema: "sophia_voice_lab_d02_render_worker_dispatch_claim_v1" as const,
      termination_request_id_sha256: terminationRequestIdSha256,
      command_attestation_id_sha256: sha256(input.command_attestation_id),
      command_content_sha256: input.command_content_sha256,
      command_event_seq: input.command_event_seq,
      worker_service_id_sha256: input.worker_service_id_sha256,
      action_request_sha256: input.action_request_sha256,
      dispatch_attempt_id_sha256: sha256(input.dispatch_attempt_id),
      requested_at: input.requested_at,
      raw_action_and_attempt_identifiers_excluded: true as const,
    };
    const payload = { ...core, dispatch_claim_sha256: canonicalRequestHash(core) };
    // The guard is evaluated only after the ledger has locked the run, current
    // browser lease, and complete event stream. It therefore closes the gap
    // between a detached product read and the globally consumed dispatch CAS.
    const claimed = await this.ledger.claimEvent(input.run_id, "product.d02_render_worker_dispatch_claimed", "canonical", payload, `d02-render-dispatch:${terminationRequestIdSha256}`, requestedAt,
      (snapshot) => assertD02RenderWorkerDispatchSnapshot(snapshot, input));
    return D02RenderWorkerDispatchClaimResponseSchema.parse({
      schema: "sophia_voice_lab_d02_render_worker_dispatch_claim_v1",
      claimed: true,
      idempotent_replay: claimed.replay,
      termination_request_id_sha256: terminationRequestIdSha256,
      dispatch_attempt_id_sha256: payload.dispatch_attempt_id_sha256,
      action_request_sha256: input.action_request_sha256,
      dispatch_claim_sha256: payload.dispatch_claim_sha256,
      event_seq: claimed.event.seq,
      claimed_at: claimed.event.at.toISOString(),
    });
  }

  /** Internal evidence-plane boundary. It is intentionally not an MCP tool:
   * the registered app, ordinary test caller, and fault credential cannot
   * discover or invoke it. Facts are immutable but become scenario proof only
   * after the evaluator joins them back to durable run/operation/audit rows. */
  async attachExternalAttestation(caller: AuthenticatedCaller, raw: unknown, requestContext?: { argumentHash: string; requestIdHash: string }): Promise<LabEnvelope> {
    requireScope(caller, "voice_lab:attest");
    const input = ExternalAttestationSchema.parse(raw);
    if (!requestContext || requestContext.argumentHash !== canonicalRequestHash(input) || !/^[a-f0-9]{64}$/.test(requestContext.requestIdHash)) throw new VoiceLabError(labError("ATTESTATION_AUDIT_CONTEXT_MISSING", "External attestation requires an exact authenticated HTTP audit context.", "authorization"));
    const run = await this.ledger.getRun(input.run_id);
    if (!run || run.evidencePurgedAt !== null) throw new VoiceLabError(labError("RUN_NOT_FOUND", "Run was not found.", "validation"));
    if (input.test_run_id_sha256 !== sha256(run.testRunId) || input.cleanup_obligation_id_sha256 !== sha256(run.cleanupObligationId) || input.scenario_id !== run.scenarioId || input.scenario_version !== run.scenarioVersion || input.environment !== run.environment
      || canonicalRequestHash(input.expected_deployment) !== canonicalRequestHash(run.target.expectedDeployment)) {
      throw new VoiceLabError(labError("ATTESTATION_BINDING_MISMATCH", "External attestation did not exactly bind the governed run and deployment.", "evidence"));
    }
    const issuedAt = new Date(input.issued_at);
    const expiresAt = new Date(input.expires_at);
    const now = new Date();
    const retentionDeadline = run.retentionPurgeDueAt ?? new Date(run.createdAt.getTime() + run.capturePolicy.retentionHours * 3_600_000);
    const authority = input.evidence.authority;
    const authorityConfig = this.config.attestationAuthorities[authority];
    requireScope(caller, `voice_lab:attest:${authority}`);
    if (caller.subject !== authorityConfig.subject || input.issuer !== authorityConfig.issuer) throw new VoiceLabError(labError("ATTESTATION_AUTHORITY_MISMATCH", "External attestation issuer or transport authority is invalid.", "authorization"));
    if (input.jti !== input.attestation_id || input.authority_key_id !== authorityConfig.keyId) throw new VoiceLabError(labError("ATTESTATION_KEY_MISMATCH", "External attestation key or JTI did not match its source authority.", "authorization"));
    const signed = { ...input } as Record<string, unknown>;
    delete signed.signature;
    const digest = Buffer.from(canonicalRequestHash(signed), "hex");
    let signatureValid = false;
    try {
      const publicKey = createPublicKey({ key: Buffer.from(authorityConfig.publicKeySpkiBase64, "base64"), format: "der", type: "spki" });
      signatureValid = verifySignature(null, digest, publicKey, Buffer.from(input.signature, "base64url"));
    } catch { signatureValid = false; }
    if (!signatureValid) throw new VoiceLabError(labError("ATTESTATION_SIGNATURE_INVALID", "External attestation signature was invalid.", "authorization"));
    const existing = (await readCompleteEventLedger(this.ledger, run.id)).filter((event) => event.kind === `external.attestation.${input.evidence.kind}`);
    const signedContentHash = canonicalRequestHash(signed);
    const replay = existing.find((event) => event.payload.attestation_id === input.attestation_id && event.payload.signature_material_sha256 === signedContentHash);
    if (replay) return envelope({ run, status: "completed", data: { attestation_id: input.attestation_id, attestation_kind: input.evidence.kind, content_sha256: replay.payload.content_sha256, event_seq: replay.seq, immutable: true, replay: true, proof_status: "pending_evaluator_cross_join" } });
    if (existing.length > 0) throw new VoiceLabError(labError("ATTESTATION_CONFLICT", "A different canonical attestation already exists for this run and evidence kind.", "evidence"));
    // Freshness gates first insertion. A signed byte-identical claim that was
    // already committed remains readable after its short transport TTL, which
    // is required to recover an ambiguous response without minting a new claim.
    const structurallyInvalidTime = issuedAt.getTime() < run.createdAt.getTime() - 300_000 || issuedAt.getTime() > now.getTime() + 30_000
      || expiresAt <= issuedAt || expiresAt.getTime() - issuedAt.getTime() > 900_000 || expiresAt > retentionDeadline;
    // A D02 final claim can be durably journaled before the product-owned
    // Gateway settlement commits. If the controller is restarted after that
    // commit, the exact signed loss claim must still be able to read and
    // persist the independently signed settlement receipt. All other first
    // insertions retain the short transport-expiry requirement.
    const delayedD02GatewayReadback = input.evidence.kind === "d02_browser_worker_termination_command" || input.evidence.kind === "d02_browser_worker_loss"
      || input.evidence.kind === "d02_restart_command" || input.evidence.kind === "d02_api_process_restart";
    if (structurallyInvalidTime || (expiresAt <= now && !delayedD02GatewayReadback)) throw new VoiceLabError(labError("ATTESTATION_TIME_INVALID", "External attestation time or expiry was outside the governed run/retention boundary.", "evidence"));
    // Perform mutable owning-state joins only after checking immutable replay.
    // A D02 proof cites the prior failure-manifest revision; publishing the
    // next revision must not make an exact signed retry cease to be idempotent.
    const validationResult = await this.validateExternalAttestationEvidence(run, input.evidence, {
      requireD02FreezeReplay: expiresAt <= now && input.evidence.kind === "d02_browser_worker_termination_command",
      ...(expiresAt <= now && (input.evidence.kind === "d02_restart_command" || input.evidence.kind === "d02_api_process_restart")
        ? { requireD02ContinuityReceiptIssuedBy: expiresAt }
        : {}),
    });
    const recoveredGatewayFreeze = expiresAt <= now && validationResult?.gatewayFreezeIdempotentReplay === true;
    const recoveredGatewayContinuity = validationResult?.gatewayContinuityIdempotentReplay === true;
    const persistedInput = { ...input } as Record<string, unknown>;
    delete persistedInput.nonce;
    const core = {
      ...persistedInput,
      nonce_sha256: sha256(input.nonce),
      signature_material_sha256: canonicalRequestHash(signed),
      authority_subject_sha256: sha256(caller.subject),
      request_argument_sha256: requestContext.argumentHash,
      request_id_sha256: requestContext.requestIdHash,
      binding_validated: true,
      raw_identifiers_excluded: true,
    };
    const payload = { ...core, content_sha256: canonicalRequestHash(core) };
    await this.ledger.recordAuthAudit({ runId: run.id, callerId: caller.subject, action: "external_attestation.authenticate", argumentHash: requestContext.argumentHash, outcome: "allowed", detail: { request_id_hash: requestContext.requestIdHash, attestation_id_hash: sha256(input.attestation_id), authority, authority_key_id: input.authority_key_id }, observedAt: now });
    await this.ledger.appendEvent(run.id, "external.attestation_nonce_claimed", "canonical", { authority, authority_key_id: input.authority_key_id, nonce_sha256: sha256(input.nonce), attestation_id_sha256: sha256(input.attestation_id), raw_nonce_excluded: true }, `external-attestation-nonce:${authority}:${sha256(input.nonce)}`, issuedAt);
    let event: import("./domain.js").LabEvent;
    try {
      // The stable per-kind dedupe key is the atomic claim. Postgres enforces
      // `(run_id,dedupe_key)` uniquely and both ledgers exact-compare the
      // canonical payload on conflict, so two source authorities cannot race
      // distinct signed envelopes into the same proof slot.
      event = await this.ledger.appendEvent(run.id, `external.attestation.${input.evidence.kind}`, "canonical", payload, `external-attestation-kind:${input.evidence.kind}`, issuedAt);
    } catch (error) {
      const winner = (await readCompleteEventLedger(this.ledger, run.id)).find((candidate) => candidate.kind === `external.attestation.${input.evidence.kind}`);
      if (winner?.payload.attestation_id === input.attestation_id && winner.payload.signature_material_sha256 === signedContentHash) {
        return envelope({ run: await this.ledger.getRun(run.id) ?? run, status: "completed", data: { attestation_id: input.attestation_id, attestation_kind: input.evidence.kind, content_sha256: winner.payload.content_sha256, event_seq: winner.seq, immutable: true, replay: true, ...(recoveredGatewayFreeze ? { gateway_freeze_idempotent_replay: true } : {}), ...(recoveredGatewayContinuity ? { gateway_continuity_idempotent_replay: true } : {}), proof_status: "pending_evaluator_cross_join" } });
      }
      if (winner) throw new VoiceLabError(labError("ATTESTATION_CONFLICT", "A different canonical attestation won the atomic run/kind evidence claim.", "evidence"));
      throw error;
    }
    const fresh = await this.ledger.getRun(run.id) ?? run;
    return envelope({ run: fresh, status: "completed", data: { attestation_id: input.attestation_id, attestation_kind: input.evidence.kind, content_sha256: payload.content_sha256, event_seq: event.seq, immutable: true, ...(recoveredGatewayFreeze ? { gateway_freeze_idempotent_replay: true } : {}), ...(recoveredGatewayContinuity ? { gateway_continuity_idempotent_replay: true } : {}), proof_status: "pending_evaluator_cross_join" } });
  }

  private async deriveD02BrowserContinuity(run: RunRecord, rawQuery: z.infer<typeof D02BrowserContinuityQuerySchema>, observedAt: Date): Promise<D02BrowserContinuityProof> {
    const query = D02BrowserContinuityQuerySchema.parse(rawQuery);
    if (run.scenarioId !== "V-D02" || run.id !== query.run_id || !Number.isFinite(observedAt.getTime())) throw attestationMismatch("D02 browser continuity query did not bind one live governed run.");
    const [events, operations, currentLease] = await Promise.all([
      readCompleteEventLedger(this.ledger, run.id),
      this.ledger.listOperations(run.id),
      this.ledger.getBrowserLease(run.id),
    ]);
    const command = events.find((event) => {
      if (event.kind !== "external.attestation.d02_restart_command" || event.source !== "canonical" || event.payload.binding_validated !== true) return false;
      const proof = event.payload.evidence as Record<string, unknown> | undefined;
      return proof?.operation_id === query.operation_id && typeof proof.restart_request_id === "string" && sha256(proof.restart_request_id) === query.restart_request_id_sha256;
    });
    const commandProof = command?.payload.evidence as Record<string, unknown> | undefined;
    const operation = operations.find((candidate) => candidate.id === query.operation_id);
    const replay = events.find((event) => event.kind === `operation.${operation?.type}.idempotent_replay` && event.payload.operation_id === query.operation_id && event.payload.exact_request_hash_replay === true && event.payload.no_new_operation === true);
    const afterBoots = await this.ledger.listAuthAuditByArgumentHashes("system.web", [query.after_boot_id_sha256], new Date(run.createdAt.getTime() - 300_000));
    const afterBootMatches = afterBoots.filter((record) => record.action === "service:web_boot" && record.outcome === "allowed" && record.argumentHash === query.after_boot_id_sha256 && record.detail.service_version === this.config.serviceVersion);
    const afterBoot = afterBootMatches[0];
    const runtimes = events.filter((event) => event.kind === "harness.browser_runtime_acquired");
    const losses = events.filter((event) => event.kind === "durability.browser_worker_loss_observed");
    const replacementRuntimes = runtimes.filter((event) => event.payload.worker_id_sha256 !== commandProof?.browser_worker_id_sha256 || event.payload.browser_lease_epoch !== commandProof?.browser_lease_epoch);
    const lossOrReplacementCount = losses.length + replacementRuntimes.length;
    const runtime = runtimes[0];
    const updatedAt = currentLease?.updatedAt;
    const expiresAt = currentLease?.expiresAt;
    if (!command || !commandProof || !operation || !["speak", "barge_in"].includes(operation.type) || !replay || !afterBoot || afterBootMatches.length !== 1
      || command.seq >= replay.seq || afterBoot.observedAt >= replay.at || commandProof.before_boot_id_sha256 === query.after_boot_id_sha256
      || runtimes.length !== 1 || lossOrReplacementCount !== 0 || !runtime || !currentLease || !updatedAt || !expiresAt
      || !Number.isFinite(updatedAt.getTime()) || !Number.isFinite(expiresAt.getTime())
      || runtime.payload.worker_id_sha256 !== commandProof.browser_worker_id_sha256 || runtime.payload.browser_lease_epoch !== commandProof.browser_lease_epoch
      || sha256(currentLease.workerId) !== commandProof.browser_worker_id_sha256 || currentLease.leaseEpoch !== commandProof.browser_lease_epoch
      || updatedAt <= afterBoot.observedAt || updatedAt <= replay.at || updatedAt > new Date(observedAt.getTime() + 30_000) || expiresAt <= observedAt) {
      throw attestationMismatch("D02 browser continuity is not yet proven by one current unexpired post-boot/post-replay durable lease heartbeat.");
    }
    const core = D02BrowserContinuityProofCoreSchema.parse({
      schema: "sophia_voice_lab_d02_browser_continuity_v1",
      run_id_sha256: sha256(run.id),
      restart_request_id_sha256: query.restart_request_id_sha256,
      operation_id_sha256: sha256(operation.id),
      after_boot_id_sha256: query.after_boot_id_sha256,
      browser_worker_id_sha256: sha256(currentLease.workerId),
      browser_lease_epoch: currentLease.leaseEpoch,
      browser_lease_updated_at: updatedAt.toISOString(),
      browser_lease_expires_at: expiresAt.toISOString(),
      replay_event_seq: replay.seq,
      replay_observed_at: replay.at.toISOString(),
      observed_at: observedAt.toISOString(),
      runtime_acquisition_count: 1,
      loss_or_replacement_count: 0,
      continuity_proven: true,
    });
    return D02BrowserContinuityProofSchema.parse({ ...core, proof_sha256: canonicalRequestHash(core) });
  }

  private async deriveD02BrowserWorkerLossObservation(run: RunRecord, rawQuery: z.infer<typeof D02BrowserWorkerLossQuerySchema>, observedAt: Date): Promise<D02BrowserWorkerLossObservation> {
    const query = D02BrowserWorkerLossQuerySchema.parse(rawQuery);
    if (run.scenarioId !== "V-D02" || run.id !== query.run_id || !Number.isFinite(observedAt.getTime())) throw attestationMismatch("D02 browser-worker loss query did not bind one governed run.");
    const [events, currentLease] = await Promise.all([readCompleteEventLedger(this.ledger, run.id), this.ledger.getBrowserLease(run.id)]);
    const commandEvents = events.filter((event) => event.kind === "external.attestation.d02_browser_worker_termination_command");
    const freezeEvents = events.filter((event) => event.kind === "product.d02_gateway_browser_worker_termination_frozen");
    const dispatchEvents = events.filter((event) => event.kind === "product.d02_render_worker_dispatch_claimed");
    const shutdownEvents = events.filter((event) => event.kind === "durability.browser_worker_shutdown_observed");
    const lossEvents = events.filter((event) => event.kind === "durability.browser_worker_loss_observed");
    const replacementEvents = events.filter((event) => event.kind === "durability.browser_worker_replacement_observed");
    const commandEvent = commandEvents[0];
    const freezeEvent = freezeEvents[0];
    const dispatchEvent = dispatchEvents[0];
    const shutdownEvent = shutdownEvents[0];
    const lossEvent = lossEvents[0];
    const replacementEvent = replacementEvents[0];
    const parsedCommand = ExternalAttestationEvidenceSchema.safeParse(commandEvent?.payload.evidence);
    const parsedFreeze = D02GatewayFreezeEventSchema.safeParse(freezeEvent?.payload);
    const parsedDispatch = D02RenderWorkerDispatchEventSchema.safeParse(dispatchEvent?.payload);
    const parsedShutdown = D02WorkerShutdownEventSchema.safeParse(shutdownEvent?.payload);
    const parsedLoss = D02WorkerLossCrossJoinEventSchema.safeParse(lossEvent?.payload);
    const parsedReplacement = D02WorkerReplacementEventSchema.safeParse(replacementEvent?.payload);
    if (commandEvents.length !== 1 || freezeEvents.length !== 1 || dispatchEvents.length !== 1 || shutdownEvents.length !== 1
      || lossEvents.length !== 1 || replacementEvents.length !== 1 || !commandEvent || commandEvent.source !== "canonical"
      || !freezeEvent || freezeEvent.source !== "canonical" || !dispatchEvent || dispatchEvent.source !== "canonical"
      || !shutdownEvent || shutdownEvent.source !== "worker" || !lossEvent || lossEvent.source !== "worker"
      || !replacementEvent || replacementEvent.source !== "worker" || !parsedCommand.success
      || parsedCommand.data.kind !== "d02_browser_worker_termination_command" || !parsedFreeze.success || !parsedDispatch.success
      || !parsedShutdown.success || !parsedLoss.success || !parsedReplacement.success || currentLease !== null
      || run.state !== "aborted_driver_restart" || run.terminalError?.code !== "BROWSER_SESSION_LOST") {
      throw attestationMismatch("D02 browser-worker loss is not yet proven by one exact graceful shutdown, replacement cross-join, and absent current lease.");
    }
    const proof = parsedCommand.data;
    const freeze = parsedFreeze.data;
    const dispatch = parsedDispatch.data;
    const shutdown = parsedShutdown.data;
    const loss = parsedLoss.data;
    const replacement = parsedReplacement.data;
    const commandCore = { ...commandEvent.payload };
    delete commandCore.content_sha256;
    const dispatchCore = { ...dispatchEvent.payload };
    delete dispatchCore.dispatch_claim_sha256;
    const expectedFreezeRequest = {
      schema: "sophia_voice_lab_gateway_browser_worker_termination_freeze_request_v1" as const,
      termination_request_id: proof.termination_request_id,
      voice_lab_run_id_sha256: proof.run_id_sha256,
      test_run_id: run.testRunId,
      cleanup_obligation_id: run.cleanupObligationId,
      provider_session_id: run.providerSessionId,
      provider_admission_id_sha256: proof.provider_admission_id_sha256,
      provider_connection_epoch: proof.provider_connection_epoch,
      frozen_provider_connection_epochs: proof.frozen_provider_connection_epochs,
      browser_worker_id_sha256: proof.browser_worker_id_sha256,
      browser_lease_epoch: proof.browser_lease_epoch,
      browser_context_id_sha256: proof.browser_context_id_sha256,
      render_action_request_sha256: proof.render_action_request_sha256,
      requested_at: proof.requested_at,
    };
    const exactCommand = commandEvent.payload.binding_validated === true && commandEvent.payload.raw_identifiers_excluded === true
      && commandEvent.payload.content_sha256 === canonicalRequestHash(commandCore)
      && commandEvent.payload.scenario_id === "V-D02" && commandEvent.payload.test_run_id_sha256 === sha256(run.testRunId)
      && commandEvent.payload.cleanup_obligation_id_sha256 === sha256(run.cleanupObligationId)
      && proof.run_id_sha256 === sha256(run.id) && proof.cleanup_obligation_id_sha256 === sha256(run.cleanupObligationId)
      && run.providerSessionId !== null && proof.provider_session_id_sha256 === sha256(run.providerSessionId)
      && proof.provider_connection_epoch === run.providerEpoch && sha256(proof.termination_request_id) === query.termination_request_id_sha256;
    const exactFreeze = freeze.termination_request_id_sha256 === query.termination_request_id_sha256
      && freeze.freeze_request_sha256 === canonicalRequestHash(expectedFreezeRequest)
      && freeze.voice_lab_run_id_sha256 === proof.run_id_sha256 && freeze.cleanup_obligation_id_sha256 === proof.cleanup_obligation_id_sha256
      && freeze.provider_session_id_sha256 === proof.provider_session_id_sha256 && freeze.provider_admission_id_sha256 === proof.provider_admission_id_sha256
      && freeze.provider_connection_epoch === proof.provider_connection_epoch
      && canonicalRequestHash(freeze.frozen_provider_connection_epochs) === canonicalRequestHash(proof.frozen_provider_connection_epochs)
      && freeze.browser_worker_id_sha256 === proof.browser_worker_id_sha256 && freeze.browser_lease_epoch === proof.browser_lease_epoch
      && freeze.browser_context_id_sha256 === proof.browser_context_id_sha256 && freeze.render_action_request_sha256 === proof.render_action_request_sha256;
    const exactDispatch = dispatch.termination_request_id_sha256 === query.termination_request_id_sha256
      && dispatch.command_attestation_id_sha256 === sha256(String(commandEvent.payload.attestation_id))
      && dispatch.command_content_sha256 === commandEvent.payload.content_sha256 && dispatch.command_event_seq === commandEvent.seq
      && dispatch.worker_service_id_sha256 === proof.worker_service_id_sha256 && dispatch.action_request_sha256 === proof.render_action_request_sha256
      && dispatch.dispatch_claim_sha256 === canonicalRequestHash(dispatchCore) && dispatchEvent.at.toISOString() === dispatch.requested_at;
    const exactShutdown = shutdown.termination_request_id_sha256 === query.termination_request_id_sha256
      && shutdown.voice_lab_run_id_sha256 === sha256(run.id) && shutdown.cleanup_obligation_id_sha256 === sha256(run.cleanupObligationId)
      && shutdown.lost_browser_worker_id_sha256 === proof.browser_worker_id_sha256 && shutdown.lost_browser_lease_epoch === proof.browser_lease_epoch
      && shutdown.browser_context_id_sha256 === proof.browser_context_id_sha256 && shutdown.provider_session_id_sha256 === proof.provider_session_id_sha256
      && shutdown.provider_admission_id_sha256 === proof.provider_admission_id_sha256 && shutdown.provider_connection_epoch === proof.provider_connection_epoch
      && canonicalRequestHash(shutdown.frozen_provider_connection_epochs) === canonicalRequestHash(proof.frozen_provider_connection_epochs)
      && shutdown.render_action_request_sha256 === proof.render_action_request_sha256 && shutdown.gateway_freeze_request_sha256 === freeze.freeze_request_sha256
      && shutdown.gateway_freeze_event_seq === freezeEvent.seq && shutdown.command_event_seq === commandEvent.seq
      && shutdown.render_dispatch_claim_sha256 === dispatch.dispatch_claim_sha256 && shutdown.render_dispatch_claim_event_seq === dispatchEvent.seq
      && shutdown.product_provider_cleanup_acknowledged === true
      && shutdown.product_provider_close_receipt_count + shutdown.product_provider_activation_abort_receipt_count === proof.frozen_provider_connection_epochs.length
      && shutdown.product_provider_cleanup_epoch_union_matches_freeze === true
      && shutdown.observed_at === shutdownEvent.at.toISOString();
    const exactLoss = loss.termination_request_id_sha256 === query.termination_request_id_sha256
      && loss.lost_worker_id_sha256 === proof.browser_worker_id_sha256 && loss.replacement_worker_id_sha256 !== proof.browser_worker_id_sha256
      && loss.lost_browser_lease_epoch === proof.browser_lease_epoch && loss.browser_context_id_sha256 === proof.browser_context_id_sha256
      && loss.old_worker_shutdown_event_seq === shutdownEvent.seq && loss.render_dispatch_claim_sha256 === dispatch.dispatch_claim_sha256
      && loss.render_dispatch_claim_event_seq === dispatchEvent.seq && loss.loss_observed_at === lossEvent.at.toISOString();
    const exactReplacement = replacement.termination_request_id_sha256 === query.termination_request_id_sha256
      && replacement.lost_browser_worker_id_sha256 === proof.browser_worker_id_sha256
      && replacement.replacement_browser_worker_id_sha256 === loss.replacement_worker_id_sha256
      && replacement.lost_browser_lease_epoch === proof.browser_lease_epoch && replacement.browser_context_id_sha256 === proof.browser_context_id_sha256
      && replacement.old_worker_shutdown_event_seq === shutdownEvent.seq && replacement.loss_event_seq === lossEvent.seq
      && replacement.render_dispatch_claim_sha256 === dispatch.dispatch_claim_sha256 && replacementEvent.at.getTime() === lossEvent.at.getTime();
    const exactOrder = freezeEvent.seq < commandEvent.seq && commandEvent.seq < dispatchEvent.seq && dispatchEvent.seq < shutdownEvent.seq
      && shutdownEvent.seq < lossEvent.seq && lossEvent.seq < replacementEvent.seq
      && orderedTimestamps(proof.requested_at, dispatch.requested_at, shutdown.observed_at, loss.loss_observed_at, observedAt.toISOString());
    if (!exactCommand || !exactFreeze || !exactDispatch || !exactShutdown || !exactLoss || !exactReplacement || !exactOrder) {
      throw attestationMismatch("D02 browser-worker loss did not cross-join the exact freeze, command, dispatch, graceful old-worker shutdown, and distinct replacement source.");
    }
    const core = D02BrowserWorkerLossObservationCoreSchema.parse({
      schema: "sophia_voice_lab_d02_browser_worker_loss_observation_v1",
      run_id_sha256: sha256(run.id),
      test_run_id_sha256: sha256(run.testRunId),
      cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
      termination_request_id_sha256: query.termination_request_id_sha256,
      provider_session_id_sha256: proof.provider_session_id_sha256,
      provider_admission_id_sha256: proof.provider_admission_id_sha256,
      provider_connection_epoch: proof.provider_connection_epoch,
      frozen_provider_connection_epochs: proof.frozen_provider_connection_epochs,
      product_provider_cleanup_settlement_sha256: shutdown.product_provider_cleanup_settlement_sha256,
      browser_context_id_sha256: proof.browser_context_id_sha256,
      lost_browser_worker_id_sha256: proof.browser_worker_id_sha256,
      replacement_browser_worker_id_sha256: loss.replacement_worker_id_sha256,
      lost_browser_lease_epoch: proof.browser_lease_epoch,
      loss_event_seq: lossEvent.seq,
      loss_observed_at: loss.loss_observed_at,
      observed_at: observedAt.toISOString(),
      terminal_state: "aborted_driver_restart",
      terminal_error_code: "BROWSER_SESSION_LOST",
      browser_lease_absent: true,
      owning_gateway_settlement_included: false,
    });
    return D02BrowserWorkerLossObservationSchema.parse({ ...core, proof_sha256: canonicalRequestHash(core) });
  }

  private async validateExternalAttestationEvidence(
    run: RunRecord,
    evidence: z.infer<typeof ExternalAttestationEvidenceSchema>,
    options: { requireD02FreezeReplay?: boolean; requireD02ContinuityReceiptIssuedBy?: Date } = {},
  ): Promise<{ gatewayFreezeIdempotentReplay?: true; gatewayContinuityIdempotentReplay?: true } | undefined> {
    const operations = await this.ledger.listOperations(run.id);
    const events = await readCompleteEventLedger(this.ledger, run.id);
    if (evidence.kind === "a03_http_response_loss") {
      if (run.scenarioId !== "V-A03") throw attestationMismatch("A03 response-loss proof was attached to a different scenario.");
      const operation = operations.find((candidate) => candidate.id === evidence.operation_id);
      const replay = events.find((event) => event.kind === "operation.speak.idempotent_replay" && event.payload.operation_id === evidence.operation_id && event.payload.exact_request_hash_replay === true && event.payload.no_new_operation === true);
      const publicRequestHash = publicSpeakArgumentHash(operation);
      // `mcp.tool_response` is committed after the tool result is constructed
      // but before the Streamable HTTP transport can write response bytes. It
      // is therefore the owning server receipt for a client-observed response
      // loss. The later `tool:speak` audit is intentionally not used here: a
      // process/connection loss between those writes must not erase proof.
      const requestAudits = publicRequestHash ? (await this.ledger.listAuthAudit(run.id)).filter((record) => record.action === "mcp.tool_response" && record.outcome === "allowed"
        && record.callerId === run.callerId && record.argumentHash === publicRequestHash && record.detail.tool === "speak") : [];
      const firstAudit = requestAudits.find((record) => record.detail.client_request_id_hash === evidence.initial_client_request_id_sha256);
      const retryAudit = requestAudits.find((record) => record.detail.client_request_id_hash === evidence.retry_client_request_id_sha256);
      if (!operation || operation.type !== "speak" || publicRequestHash === null || evidence.replayed_operation_id !== operation.id || evidence.request_sha256 !== operation.requestHash || evidence.idempotency_key_sha256 !== sha256(operation.idempotencyKey) || !replay
        || evidence.initial_client_request_id_sha256 === evidence.retry_client_request_id_sha256 || requestAudits.length !== 2 || !firstAudit || !retryAudit || firstAudit === retryAudit
        || firstAudit.detail.operation_id_sha256 !== sha256(operation.id) || retryAudit.detail.operation_id_sha256 !== sha256(operation.id)
        || firstAudit.detail.run_id_sha256 !== sha256(run.id) || retryAudit.detail.run_id_sha256 !== sha256(run.id)
        || firstAudit.detail.replay !== false || retryAudit.detail.replay !== true
        || typeof firstAudit.detail.response_sha256 !== "string" || retryAudit.detail.response_sha256 !== evidence.retry_response_sha256
        || !orderedTimestamps(operation.createdAt.toISOString(), evidence.accepted_at, firstAudit.observedAt.toISOString(), evidence.response_lost_at, evidence.retry_at, replay.at.toISOString(), retryAudit.observedAt.toISOString())) throw attestationMismatch("A03 response-loss proof did not join the exact independently identified HTTP requests, durable replay audit, returned envelope, and operation.");
      return;
    }
    if (evidence.kind === "d02_restart_command") {
      if (run.scenarioId !== "V-D02" || TERMINAL_RUN_STATES.has(run.state)) throw attestationMismatch("D02 restart command must target one still-live V-D02 execution.");
      const operation = operations.find((candidate) => candidate.id === evidence.operation_id);
      const boot = (await this.ledger.listAuthAuditByArgumentHashes("system.web", [evidence.before_boot_id_sha256], new Date(run.createdAt.getTime() - 300_000)))
        .find((record) => record.action === "service:web_boot" && record.outcome === "allowed" && record.argumentHash === evidence.before_boot_id_sha256
          && record.detail.instance_id_sha256 === evidence.before_instance_id_sha256 && record.detail.version_response_sha256 === evidence.before_version_response_sha256 && record.detail.service_version === this.config.serviceVersion);
      const browserRuntimes = events.filter((event) => event.kind === "harness.browser_runtime_acquired");
      const browserRuntime = browserRuntimes.find((event) => event.payload.worker_id_sha256 === evidence.browser_worker_id_sha256 && event.payload.browser_lease_epoch === evidence.browser_lease_epoch);
      const currentLease = await this.ledger.getBrowserLease(run.id);
      const now = new Date();
      const browserLoss = events.some((event) => event.kind === "durability.browser_worker_loss_observed");
      if (!operation || !["speak", "barge_in"].includes(operation.type) || operation.state !== "succeeded" || operation.requestHash !== evidence.request_sha256 || sha256(operation.idempotencyKey) !== evidence.idempotency_key_sha256
        || run.canonicalSessionId === null || run.threadId === null || run.providerSessionId === null || run.providerEpoch === null || run.providerEpoch < 1
        || !boot || !browserRuntime || browserRuntimes.length !== 1 || browserLoss || !currentLease || sha256(currentLease.workerId) !== evidence.browser_worker_id_sha256
        || currentLease.leaseEpoch !== evidence.browser_lease_epoch || !Number.isFinite(currentLease.expiresAt.getTime()) || !Number.isFinite(currentLease.updatedAt.getTime())
        || currentLease.expiresAt <= now || currentLease.updatedAt > new Date(now.getTime() + 30_000)
        || !orderedTimestamps(boot.observedAt.toISOString(), evidence.requested_at) || new Date(evidence.requested_at).getTime() > now.getTime() + 30_000) {
        throw attestationMismatch("D02 restart command did not join one live exact input operation, current web boot, and browser lease before the governed one-shot restart.");
      }
      const observationRequest = {
        schema: "sophia_voice_lab_d02_product_continuity_observation_request_v1" as const,
        restart_request_id: evidence.restart_request_id,
        cleanup_obligation_id: run.cleanupObligationId,
        phase: "before_api_restart" as const,
        product_service_boot_id_sha256: evidence.before_boot_id_sha256,
        render_action_request_sha256: evidence.provider_restart_request_sha256,
        prior_observation_receipt_sha256: null,
        observed_at: evidence.requested_at,
      };
      const observation = await this.d02Gateway.observeContinuity(run.target.gatewayUrl, observationRequest);
      const projection = observation.continuity_projection;
      if (projection.voice_lab_run_id_sha256 !== sha256(run.id) || projection.test_run_id_sha256 !== sha256(run.testRunId)
        || projection.cleanup_obligation_id_sha256 !== sha256(run.cleanupObligationId) || projection.session_id_sha256 !== sha256(run.canonicalSessionId)
        || projection.thread_id_sha256 !== sha256(run.threadId) || projection.provider_session_id_sha256 !== sha256(run.providerSessionId)
        || projection.provider_connection_epoch !== run.providerEpoch || projection.browser_worker_id_sha256 !== evidence.browser_worker_id_sha256
        || projection.browser_lease_epoch !== evidence.browser_lease_epoch || canonicalRequestHash(projection.expected_deployment) !== canonicalRequestHash(run.target.expectedDeployment)
        || !orderedTimestamps(evidence.requested_at, observation.database_observed_at)) {
        throw attestationMismatch("D02 API restart precondition did not join the locked product session, thread, provider, deployment, and browser lease projection.");
      }
      if (options.requireD02ContinuityReceiptIssuedBy && new Date(observation.issued_at) > options.requireD02ContinuityReceiptIssuedBy) {
        throw new VoiceLabError(labError("ATTESTATION_TIME_INVALID", "An expired D02 API restart command can only recover a Gateway continuity receipt issued before the signed command expired.", "evidence"));
      }
      await this.ledger.appendEvent(run.id, "product.d02_api_process_restart_precondition", "canonical", {
        schema: "sophia_voice_lab_d02_product_continuity_event_v1",
        phase: "before_api_restart",
        restart_request_id_sha256: sha256(evidence.restart_request_id),
        observation_request_sha256: canonicalRequestHash(observationRequest),
        observation_receipt_sha256: observation.receipt_sha256,
        gateway_receipt: observation,
        source: "gateway_ed25519_locked_product_continuity",
        raw_product_identifiers_excluded: true,
      }, `d02-api-product-precondition:${sha256(evidence.restart_request_id)}`);
      return options.requireD02ContinuityReceiptIssuedBy ? { gatewayContinuityIdempotentReplay: true } : undefined;
    }
    if (evidence.kind === "d02_browser_worker_termination_command") {
      const currentLease = await this.ledger.getBrowserLease(run.id);
      const browserRuntimes = events.filter((event) => event.kind === "harness.browser_runtime_acquired");
      const browserRuntime = browserRuntimes.find((event) => event.payload.worker_id_sha256 === evidence.browser_worker_id_sha256 && event.payload.browser_lease_epoch === evidence.browser_lease_epoch);
      const browserContextBindings = events.filter((event) => event.kind === "harness.browser_context_bound" && event.source === "canonical");
      const browserContextBinding = browserContextBindings.find((event) => event.payload.schema === "sophia_voice_lab_browser_context_binding_v1"
        && event.payload.voice_lab_run_id_sha256 === evidence.run_id_sha256
        && event.payload.test_run_id_sha256 === sha256(run.testRunId)
        && event.payload.cleanup_obligation_id_sha256 === evidence.cleanup_obligation_id_sha256
        && event.payload.browser_worker_id_sha256 === evidence.browser_worker_id_sha256
        && event.payload.browser_lease_epoch === evidence.browser_lease_epoch
        && event.payload.browser_context_id_sha256 === evidence.browser_context_id_sha256
        && event.payload.driver_attested === true);
      const sortedEpochs = evidence.frozen_provider_connection_epochs.every((epoch, index) => index === 0 || evidence.frozen_provider_connection_epochs[index - 1]! < epoch);
      const now = new Date();
      if (run.scenarioId !== "V-D02" || TERMINAL_RUN_STATES.has(run.state) || run.providerSessionId === null || run.providerEpoch === null
        || evidence.run_id_sha256 !== sha256(run.id) || evidence.cleanup_obligation_id_sha256 !== sha256(run.cleanupObligationId)
        || evidence.provider_session_id_sha256 !== sha256(run.providerSessionId) || evidence.provider_connection_epoch !== run.providerEpoch
        || !sortedEpochs || new Set(evidence.frozen_provider_connection_epochs).size !== evidence.frozen_provider_connection_epochs.length || !evidence.frozen_provider_connection_epochs.includes(run.providerEpoch)
        || evidence.before_worker_owner_instance_id_sha256 !== evidence.browser_worker_id_sha256 || evidence.before_worker_owner_membership_count !== 1
        || !browserRuntime || browserRuntimes.length !== 1 || !browserContextBinding || browserContextBindings.length !== 1
        || !currentLease || sha256(currentLease.workerId) !== evidence.browser_worker_id_sha256
        || currentLease.leaseEpoch !== evidence.browser_lease_epoch || currentLease.expiresAt <= now
        || events.some((event) => event.kind === "durability.browser_worker_loss_observed")
        || !orderedTimestamps(browserRuntime.at.toISOString(), evidence.requested_at) || new Date(evidence.requested_at).getTime() > now.getTime() + 30_000) {
        throw attestationMismatch("D02 browser-worker termination command did not join the exact live run, cleanup obligation, provider epoch, and current browser lease before the one-shot Render mutation.");
      }
      const freezeIntent = D02LocalFreezeIntentEventSchema.parse({
        schema: "sophia_voice_lab_d02_local_browser_worker_freeze_intent_v1",
        termination_request_id_sha256: sha256(evidence.termination_request_id),
        command_evidence_sha256: canonicalRequestHash(evidence),
        voice_lab_run_id_sha256: evidence.run_id_sha256,
        cleanup_obligation_id_sha256: evidence.cleanup_obligation_id_sha256,
        provider_session_id_sha256: evidence.provider_session_id_sha256,
        provider_admission_id_sha256: evidence.provider_admission_id_sha256,
        provider_connection_epoch: evidence.provider_connection_epoch,
        frozen_provider_connection_epochs: evidence.frozen_provider_connection_epochs,
        browser_worker_id_sha256: evidence.browser_worker_id_sha256,
        browser_lease_epoch: evidence.browser_lease_epoch,
        browser_context_id_sha256: evidence.browser_context_id_sha256,
        render_action_request_sha256: evidence.render_action_request_sha256,
        requested_at: evidence.requested_at,
        raw_run_operation_provider_and_browser_identifiers_excluded: true,
      });
      await this.ledger.claimEvent(run.id, "product.d02_browser_worker_termination_freeze_pending", "canonical", freezeIntent,
        "d02-browser-worker-freeze-intent", new Date(evidence.requested_at),
        (snapshot) => assertD02LocalFreezeIntentSnapshot(snapshot, evidence, this.config.serviceVersion));
      const freezeRequest = {
        schema: "sophia_voice_lab_gateway_browser_worker_termination_freeze_request_v1" as const,
        termination_request_id: evidence.termination_request_id,
        voice_lab_run_id_sha256: evidence.run_id_sha256,
        test_run_id: run.testRunId,
        cleanup_obligation_id: run.cleanupObligationId,
        provider_session_id: run.providerSessionId,
        provider_admission_id_sha256: evidence.provider_admission_id_sha256,
        provider_connection_epoch: evidence.provider_connection_epoch,
        frozen_provider_connection_epochs: evidence.frozen_provider_connection_epochs,
        browser_worker_id_sha256: evidence.browser_worker_id_sha256,
        browser_lease_epoch: evidence.browser_lease_epoch,
        browser_context_id_sha256: evidence.browser_context_id_sha256,
        render_action_request_sha256: evidence.render_action_request_sha256,
        requested_at: evidence.requested_at,
      };
      const frozen = await this.d02Gateway.freeze(run.target.gatewayUrl, freezeRequest);
      if (options.requireD02FreezeReplay === true && frozen.idempotent_replay !== true) {
        throw new VoiceLabError(labError("ATTESTATION_TIME_INVALID", "An expired D02 command can only recover one exact Gateway freeze that already committed before response loss.", "evidence"));
      }
      await this.ledger.appendEvent(run.id, "product.d02_gateway_browser_worker_termination_frozen", "canonical", {
        schema: "sophia_voice_lab_d02_gateway_freeze_event_v1",
        termination_request_id_sha256: sha256(evidence.termination_request_id),
        freeze_request_sha256: frozen.freeze_request_sha256,
        voice_lab_run_id_sha256: evidence.run_id_sha256,
        cleanup_obligation_id_sha256: evidence.cleanup_obligation_id_sha256,
        provider_session_id_sha256: evidence.provider_session_id_sha256,
        provider_admission_id_sha256: evidence.provider_admission_id_sha256,
        provider_connection_epoch: evidence.provider_connection_epoch,
        frozen_provider_connection_epochs: evidence.frozen_provider_connection_epochs,
        browser_worker_id_sha256: evidence.browser_worker_id_sha256,
        browser_lease_epoch: evidence.browser_lease_epoch,
        browser_context_id_sha256: evidence.browser_context_id_sha256,
        render_action_request_sha256: evidence.render_action_request_sha256,
        gateway_frozen: true,
        raw_product_identifiers_excluded: true,
      }, `d02-gateway-freeze:${sha256(evidence.termination_request_id)}`);
      return frozen.idempotent_replay ? { gatewayFreezeIdempotentReplay: true } : undefined;
    }
    if (evidence.kind === "d02_api_process_restart") {
      if (run.scenarioId !== "V-D02") throw attestationMismatch("API restart proof was attached to a different scenario.");
      const operation = operations.find((candidate) => candidate.id === evidence.operation_id);
      const replay = events.find((event) => event.kind === `operation.${operation?.type}.idempotent_replay` && event.payload.operation_id === evidence.operation_id && event.payload.exact_request_hash_replay === true && event.payload.no_new_operation === true);
      const boots = await this.ledger.listAuthAuditByArgumentHashes("system.web", [evidence.before_boot_id_sha256, evidence.after_boot_id_sha256], new Date(run.createdAt.getTime() - 300_000));
      const beforeBoot = boots.find((record) => record.action === "service:web_boot" && record.outcome === "allowed" && record.argumentHash === evidence.before_boot_id_sha256 && record.detail.instance_id_sha256 === evidence.before_instance_id_sha256 && record.detail.version_response_sha256 === evidence.before_version_response_sha256 && record.detail.service_version === this.config.serviceVersion);
      const afterBoot = boots.find((record) => record.action === "service:web_boot" && record.outcome === "allowed" && record.argumentHash === evidence.after_boot_id_sha256 && record.detail.instance_id_sha256 === evidence.after_instance_id_sha256 && record.detail.version_response_sha256 === evidence.after_version_response_sha256 && record.detail.service_version === this.config.serviceVersion);
      const browserRuntime = events.find((event) => event.kind === "harness.browser_runtime_acquired" && event.payload.worker_id_sha256 === evidence.browser_worker_id_sha256 && event.payload.browser_lease_epoch === evidence.browser_lease_epoch);
      const durableReceiptHash = operation ? canonicalRequestHash({ operation_id: operation.id, operation_type: operation.type, request_hash: operation.requestHash, state: operation.state, result: operation.result }) : null;
      const operationEvents = operation ? events.filter((event) => event.payload.operation_id === operation.id || (event.payload.receipt as Record<string, unknown> | undefined)?.operation_id === operation.id) : [];
      const productPreconditions = events.filter((event) => event.kind === "product.d02_api_process_restart_precondition" && event.source === "canonical"
        && event.payload.restart_request_id_sha256 === evidence.restart_request_id_sha256);
      const productPrecondition = productPreconditions[0];
      const productPreconditionReceipt = D02GatewayContinuityObservationReceiptSchema.safeParse(productPrecondition?.payload.gateway_receipt);
      const restartCommand = events.find((event) => {
        if (event.kind !== "external.attestation.d02_restart_command" || event.source !== "canonical" || event.payload.binding_validated !== true) return false;
        const command = event.payload.evidence as Record<string, unknown> | undefined;
        return command?.authority === "deployment_control" && typeof command.restart_request_id === "string" && sha256(command.restart_request_id) === evidence.restart_request_id_sha256
          && command.operation_id === evidence.operation_id && command.request_sha256 === evidence.request_sha256 && command.idempotency_key_sha256 === evidence.idempotency_key_sha256
          && command.before_boot_id_sha256 === evidence.before_boot_id_sha256 && command.before_instance_id_sha256 === evidence.before_instance_id_sha256 && command.before_version_response_sha256 === evidence.before_version_response_sha256
          && command.browser_worker_id_sha256 === evidence.browser_worker_id_sha256 && command.browser_lease_epoch === evidence.browser_lease_epoch && command.requested_at === evidence.restart_requested_at
          && command.provider_restart_request_sha256 === evidence.provider_restart_request_sha256
          && command.target_service === "sophia-voice-lab-mcp" && command.restart_mode === "one_shot_after_durable_acceptance" && command.response_loss_expected === true
          && command.provider_mutation_authorized === false && command.one_shot === true;
      });
      const exactInputChain = operation !== undefined && ["speak", "barge_in"].includes(operation.type)
        && ["utterance.resolved", "audio.input.scheduled", "audio.input.started", "audio.input.completed", "audio.input.product_leg"].every((kind) => operationEvents.filter((event) => event.kind === kind).length === 1)
        && operationEvents.some((event) => event.kind === "audio.input.product_turn" && (event.payload.receipt as Record<string, unknown> | undefined)?.source === "public_user_turn");
      const runtimeCount = events.filter((event) => event.kind === "harness.browser_runtime_acquired").length;
      const continuity = await this.deriveD02BrowserContinuity(run, {
        run_id: run.id,
        restart_request_id_sha256: evidence.restart_request_id_sha256,
        operation_id: evidence.operation_id,
        after_boot_id_sha256: evidence.after_boot_id_sha256,
      }, new Date());
      const submittedContinuity = evidence.browser_continuity_proof;
      const submittedUpdatedAt = new Date(submittedContinuity.browser_lease_updated_at);
      const submittedExpiresAt = new Date(submittedContinuity.browser_lease_expires_at);
      const submittedObservedAt = new Date(submittedContinuity.observed_at);
      const stableContinuity = submittedContinuity.run_id_sha256 === continuity.run_id_sha256
        && submittedContinuity.restart_request_id_sha256 === continuity.restart_request_id_sha256
        && submittedContinuity.operation_id_sha256 === continuity.operation_id_sha256
        && submittedContinuity.after_boot_id_sha256 === continuity.after_boot_id_sha256
        && submittedContinuity.browser_worker_id_sha256 === continuity.browser_worker_id_sha256
        && submittedContinuity.browser_lease_epoch === continuity.browser_lease_epoch
        && submittedContinuity.replay_event_seq === continuity.replay_event_seq
        && submittedContinuity.replay_observed_at === continuity.replay_observed_at
        && submittedContinuity.runtime_acquisition_count === 1 && submittedContinuity.loss_or_replacement_count === 0 && submittedContinuity.continuity_proven === true
        && submittedUpdatedAt <= new Date(continuity.browser_lease_updated_at)
        && submittedExpiresAt <= new Date(continuity.browser_lease_expires_at)
        && submittedUpdatedAt > afterBoot!.observedAt && submittedUpdatedAt > replay!.at
        && submittedObservedAt >= submittedUpdatedAt && submittedExpiresAt > submittedObservedAt && submittedObservedAt <= new Date(Date.now() + 30_000);
      if (!operation || !restartCommand || !replay || !productPrecondition || productPreconditions.length !== 1 || !productPreconditionReceipt.success || productPrecondition.seq >= restartCommand.seq || restartCommand.seq >= replay.seq || !exactInputChain || runtimeCount !== 1 || evidence.request_sha256 !== operation.requestHash || evidence.idempotency_key_sha256 !== sha256(operation.idempotencyKey)
        || !beforeBoot || !afterBoot || !browserRuntime || beforeBoot.observedAt >= afterBoot.observedAt || evidence.before_boot_id_sha256 === evidence.after_boot_id_sha256 || evidence.before_instance_id_sha256 === evidence.after_instance_id_sha256
        || evidence.original_receipt_sha256 !== durableReceiptHash || evidence.replay_receipt_sha256 !== durableReceiptHash
        || run.canonicalSessionId === null || evidence.canonical_session_id_sha256 !== sha256(run.canonicalSessionId) || run.threadId === null || evidence.thread_id_sha256 !== sha256(run.threadId)
        || run.providerSessionId === null || evidence.provider_session_id_sha256 !== sha256(run.providerSessionId) || run.providerEpoch === null || evidence.provider_connection_epoch !== run.providerEpoch
        || productPrecondition.payload.schema !== "sophia_voice_lab_d02_product_continuity_event_v1" || productPrecondition.payload.phase !== "before_api_restart"
        || productPrecondition.payload.observation_request_sha256 !== productPreconditionReceipt.data.request_sha256
        || productPrecondition.payload.observation_receipt_sha256 !== productPreconditionReceipt.data.receipt_sha256
        || productPrecondition.payload.source !== "gateway_ed25519_locked_product_continuity" || productPrecondition.payload.raw_product_identifiers_excluded !== true
        || productPreconditionReceipt.data.restart_request_id_sha256 !== evidence.restart_request_id_sha256
        || productPreconditionReceipt.data.product_service_boot_id_sha256 !== evidence.before_boot_id_sha256
        || productPreconditionReceipt.data.render_action_request_sha256 !== evidence.provider_restart_request_sha256
        || productPreconditionReceipt.data.continuity_projection.voice_lab_run_id_sha256 !== sha256(run.id)
        || productPreconditionReceipt.data.continuity_projection.session_id_sha256 !== evidence.canonical_session_id_sha256
        || productPreconditionReceipt.data.continuity_projection.thread_id_sha256 !== evidence.thread_id_sha256
        || productPreconditionReceipt.data.continuity_projection.provider_session_id_sha256 !== evidence.provider_session_id_sha256
        || productPreconditionReceipt.data.continuity_projection.provider_connection_epoch !== evidence.provider_connection_epoch
        || !orderedTimestamps(beforeBoot.observedAt.toISOString(), evidence.restart_requested_at, evidence.new_process_started_at, afterBoot.observedAt.toISOString(), evidence.replay_observed_at)
        || replay.at < afterBoot.observedAt || evidence.browser_worker_id_sha256 !== continuity.browser_worker_id_sha256 || evidence.browser_lease_epoch !== continuity.browser_lease_epoch
        || !stableContinuity) throw attestationMismatch("D02 API restart proof did not join durable before/after web boots, an exact post-replay live browser heartbeat, and the immutable operation replay.");
      const afterObservationRequest = {
        schema: "sophia_voice_lab_d02_product_continuity_observation_request_v1" as const,
        restart_request_id: String((restartCommand.payload.evidence as Record<string, unknown>).restart_request_id),
        cleanup_obligation_id: run.cleanupObligationId,
        phase: "after_api_restart" as const,
        product_service_boot_id_sha256: evidence.after_boot_id_sha256,
        render_action_request_sha256: evidence.provider_restart_request_sha256,
        prior_observation_receipt_sha256: productPreconditionReceipt.data.receipt_sha256,
        observed_at: evidence.replay_observed_at,
      };
      const afterObservation = await this.d02Gateway.observeContinuity(run.target.gatewayUrl, afterObservationRequest);
      if (canonicalRequestHash(afterObservation.continuity_projection) !== canonicalRequestHash(productPreconditionReceipt.data.continuity_projection)
        || afterObservation.restart_request_id_sha256 !== evidence.restart_request_id_sha256
        || afterObservation.prior_observation_receipt_sha256 !== productPreconditionReceipt.data.receipt_sha256
        || afterObservation.product_service_boot_id_sha256 !== evidence.after_boot_id_sha256
        || afterObservation.render_action_request_sha256 !== evidence.provider_restart_request_sha256
        || !orderedTimestamps(evidence.replay_observed_at, afterObservation.database_observed_at)) {
        throw attestationMismatch("D02 API restart changed the locked product session, thread, provider, admission, deployment, or browser-owner projection.");
      }
      if (options.requireD02ContinuityReceiptIssuedBy && new Date(afterObservation.issued_at) > options.requireD02ContinuityReceiptIssuedBy) {
        throw new VoiceLabError(labError("ATTESTATION_TIME_INVALID", "An expired D02 API restart proof can only recover a Gateway continuity receipt issued before the signed proof expired.", "evidence"));
      }
      await this.ledger.appendEvent(run.id, "product.d02_api_process_restart_continuity", "canonical", {
        schema: "sophia_voice_lab_d02_product_continuity_event_v1",
        phase: "after_api_restart",
        restart_request_id_sha256: evidence.restart_request_id_sha256,
        observation_request_sha256: canonicalRequestHash(afterObservationRequest),
        observation_receipt_sha256: afterObservation.receipt_sha256,
        prior_observation_receipt_sha256: productPreconditionReceipt.data.receipt_sha256,
        gateway_receipt: afterObservation,
        source: "gateway_ed25519_locked_product_continuity",
        raw_product_identifiers_excluded: true,
      }, `d02-api-product-continuity:${evidence.restart_request_id_sha256}`);
      return options.requireD02ContinuityReceiptIssuedBy ? { gatewayContinuityIdempotentReplay: true } : undefined;
    }
    if (evidence.kind === "d02_browser_worker_loss") {
      const currentLease = await this.ledger.getBrowserLease(run.id);
      const now = new Date();
      const sourceLossObservation = await this.deriveD02BrowserWorkerLossObservation(run, {
        run_id: run.id,
        termination_request_id_sha256: evidence.termination_request_id_sha256,
      }, now);
      const commands = events.filter((event) => {
        if (event.kind !== "external.attestation.d02_browser_worker_termination_command" || event.source !== "canonical" || event.payload.binding_validated !== true) return false;
        const command = event.payload.evidence as Record<string, unknown> | undefined;
        return typeof command?.termination_request_id === "string" && sha256(command.termination_request_id) === evidence.termination_request_id_sha256;
      });
      const commandEvent = commands[0];
      const command = commandEvent?.payload.evidence as Record<string, unknown> | undefined;
      const gatewayFreezeEvents = events.filter((event) => event.kind === "product.d02_gateway_browser_worker_termination_frozen" && event.source === "canonical"
        && event.payload.termination_request_id_sha256 === evidence.termination_request_id_sha256
        && event.payload.gateway_frozen === true);
      const gatewayFreeze = gatewayFreezeEvents[0];
      const dispatchClaims = events.filter((event) => event.kind === "product.d02_render_worker_dispatch_claimed" && event.source === "canonical"
        && event.payload.termination_request_id_sha256 === evidence.termination_request_id_sha256
        && event.payload.dispatch_claim_sha256 === evidence.render_dispatch_claim_sha256);
      const dispatchClaim = dispatchClaims[0];
      const frozenEpochsMatch = command && canonicalRequestHash(command.frozen_provider_connection_epochs) === canonicalRequestHash(evidence.frozen_provider_connection_epochs);
      if (run.scenarioId !== "V-D02" || run.state !== "aborted_driver_restart" || run.terminalError?.code !== "BROWSER_SESSION_LOST"
        || commands.length !== 1 || !command || !commandEvent || !gatewayFreeze || gatewayFreezeEvents.length !== 1 || dispatchClaims.length !== 1 || !dispatchClaim || currentLease !== null
        || evidence.run_id_sha256 !== sha256(run.id) || evidence.cleanup_obligation_id_sha256 !== sha256(run.cleanupObligationId)
        || evidence.lost_worker_id_sha256 === evidence.replacement_worker_id_sha256
        || sourceLossObservation.run_id_sha256 !== evidence.run_id_sha256 || sourceLossObservation.cleanup_obligation_id_sha256 !== evidence.cleanup_obligation_id_sha256
        || sourceLossObservation.termination_request_id_sha256 !== evidence.termination_request_id_sha256
        || sourceLossObservation.provider_session_id_sha256 !== evidence.provider_session_id_sha256
        || sourceLossObservation.provider_admission_id_sha256 !== evidence.provider_admission_id_sha256
        || sourceLossObservation.provider_connection_epoch !== evidence.provider_connection_epoch
        || canonicalRequestHash(sourceLossObservation.frozen_provider_connection_epochs) !== canonicalRequestHash(evidence.frozen_provider_connection_epochs)
        || sourceLossObservation.product_provider_cleanup_settlement_sha256 !== evidence.product_provider_cleanup_settlement_sha256
        || sourceLossObservation.browser_context_id_sha256 !== evidence.browser_context_id_sha256
        || sourceLossObservation.lost_browser_worker_id_sha256 !== evidence.lost_worker_id_sha256
        || sourceLossObservation.replacement_browser_worker_id_sha256 !== evidence.replacement_worker_id_sha256
        || sourceLossObservation.lost_browser_lease_epoch !== evidence.lost_browser_lease_epoch
        || sourceLossObservation.loss_event_seq !== evidence.loss_event_seq || sourceLossObservation.loss_observed_at !== evidence.loss_observed_at
        || command.run_id_sha256 !== evidence.run_id_sha256 || command.cleanup_obligation_id_sha256 !== evidence.cleanup_obligation_id_sha256
        || command.worker_service_id_sha256 !== evidence.worker_service_id_sha256 || command.provider_session_id_sha256 !== evidence.provider_session_id_sha256
        || command.provider_admission_id_sha256 !== evidence.provider_admission_id_sha256 || command.provider_connection_epoch !== evidence.provider_connection_epoch
        || command.browser_context_id_sha256 !== evidence.browser_context_id_sha256 || command.browser_worker_id_sha256 !== evidence.lost_worker_id_sha256
        || command.browser_lease_epoch !== evidence.lost_browser_lease_epoch || command.before_worker_deploy_id_sha256 !== evidence.before_deploy_id_sha256
        || command.before_worker_instance_set_sha256 !== evidence.before_instance_set_sha256 || command.render_action_request_sha256 !== evidence.render_action_request_sha256
        || command.before_worker_owner_instance_id_sha256 !== evidence.lost_worker_owner_instance_id_sha256
        || command.before_worker_owner_membership_count !== 1 || evidence.lost_worker_owner_instance_id_sha256 !== evidence.lost_worker_id_sha256
        || evidence.replacement_worker_owner_instance_id_sha256 !== evidence.replacement_worker_id_sha256 || evidence.replacement_worker_owner_membership_count !== 1
        || evidence.lost_worker_present_before_restart !== true || evidence.lost_worker_absent_after_restart !== true
        || dispatchClaim.payload.command_attestation_id_sha256 !== sha256(String(commandEvent.payload.attestation_id))
        || dispatchClaim.payload.command_content_sha256 !== commandEvent.payload.content_sha256 || dispatchClaim.payload.command_event_seq !== commandEvent.seq
        || dispatchClaim.payload.worker_service_id_sha256 !== evidence.worker_service_id_sha256 || dispatchClaim.payload.action_request_sha256 !== evidence.render_action_request_sha256
        || dispatchClaim.payload.requested_at !== evidence.action_requested_at || dispatchClaim.payload.raw_action_and_attempt_identifiers_excluded !== true
        || dispatchClaim.payload.dispatch_claim_sha256 !== canonicalRequestHash(Object.fromEntries(Object.entries(dispatchClaim.payload).filter(([key]) => key !== "dispatch_claim_sha256")))
        || commandEvent.seq >= dispatchClaim.seq || dispatchClaim.seq >= sourceLossObservation.loss_event_seq
        || command.requested_at !== evidence.command_requested_at || !frozenEpochsMatch
        || evidence.before_instance_set_sha256 === evidence.after_instance_set_sha256
        || !orderedTimestamps(evidence.command_requested_at, evidence.action_requested_at, evidence.action_accepted_at, evidence.action_settled_at)
        || new Date(evidence.action_settled_at).getTime() > now.getTime() + 30_000
        || !orderedTimestamps(evidence.command_requested_at, evidence.loss_observed_at)
        || operations.some((operation) => ["accepted", "queued", "leased", "executing"].includes(operation.state))) {
        throw attestationMismatch("D02 worker-loss action proof did not join the durable one-shot command, Render replacement receipt, exact lost lease, and terminal Voice Lab abort.");
      }
      if (run.providerSessionId === null || typeof command.termination_request_id !== "string") throw attestationMismatch("D02 settlement lost its raw owning provider or termination lookup authority.");
      const settlementRequest = {
        schema: "sophia_voice_lab_gateway_browser_worker_termination_settlement_request_v1" as const,
        termination_request_id: command.termination_request_id,
        voice_lab_run_id_sha256: evidence.run_id_sha256,
        test_run_id: run.testRunId,
        cleanup_obligation_id: run.cleanupObligationId,
        provider_session_id: run.providerSessionId,
        provider_admission_id_sha256: evidence.provider_admission_id_sha256,
        provider_connection_epoch: evidence.provider_connection_epoch,
        frozen_provider_connection_epochs: evidence.frozen_provider_connection_epochs,
        browser_worker_id_sha256: evidence.lost_worker_id_sha256,
        browser_lease_epoch: evidence.lost_browser_lease_epoch,
        browser_context_id_sha256: evidence.browser_context_id_sha256,
        render_action_request_sha256: evidence.render_action_request_sha256,
        render_action_accepted_response_sha256: evidence.render_action_accepted_response_sha256,
        render_action_settled_snapshot_sha256: evidence.render_action_settled_snapshot_sha256,
        loss_event_seq: evidence.loss_event_seq,
        loss_observed_at: evidence.loss_observed_at,
      };
      const receipt = await this.d02Gateway.settle(run.target.gatewayUrl, settlementRequest);
      if (receipt.scenario_version !== run.scenarioVersion || receipt.environment !== run.environment
        || canonicalRequestHash(receipt.expected_deployment) !== canonicalRequestHash(run.target.expectedDeployment)
        || receipt.provider_settlement_sha256 !== sourceLossObservation.product_provider_cleanup_settlement_sha256
        || receipt.provider_settlement_sha256 !== evidence.product_provider_cleanup_settlement_sha256) {
        throw attestationMismatch("The Gateway settlement receipt did not bind the governed scenario, environment, deployment, and exact browser-authored provider settlement.");
      }
      const receiptSha256 = canonicalRequestHash(receipt);
      await this.ledger.appendEvent(run.id, "product.d02_gateway_browser_worker_termination_settled", "canonical", {
        schema: "sophia_voice_lab_d02_gateway_settlement_event_v1",
        termination_request_id_sha256: evidence.termination_request_id_sha256,
        settlement_request_sha256: canonicalRequestHash(settlementRequest),
        gateway_receipt_sha256: receiptSha256,
        gateway_receipt: receipt,
        source: "gateway_ed25519_settlement_receipt",
        raw_product_identifiers_excluded: true,
      }, `d02-gateway-settlement:${evidence.termination_request_id_sha256}`);
      return;
    }
    if (evidence.kind === "p01_platform_plugin_task") {
      const taskStartedAt = new Date(evidence.fresh_task_started_at);
      const taskCompletedAt = new Date(evidence.fresh_task_completed_at);
      const auditedCalls = (await this.ledger.listAuthAuditForCaller(run.callerId, taskStartedAt, taskCompletedAt))
        .filter((record) => record.action === "mcp.tool_response" && record.outcome === "allowed")
        .sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime() || Number(left.id ?? 0) - Number(right.id ?? 0));
      const referencedOperations = operations.filter((operation) => evidence.operation_ids.includes(operation.id));
      const referencedTypes = new Set(referencedOperations.map((operation) => operation.type));
      const currentEvidence = await this.ledger.getEvidence(run.id);
      const expectedTools = ["get_capabilities", "start_voice_run", "wait_for_turn", "speak", "wait_for_turn", "speak", "wait_for_turn", "inspect_voice_run", "end_voice_run", "export_voice_evidence"] as const;
      const oauthClientHash = this.config.oauth ? sha256(this.config.oauth.clientMetadataUrl) : null;
      const exactCalls = evidence.calls.every((call, index) => call.spine_ordinal === index + 1 && call.tool_name === expectedTools[index]);
      const exactPollingCalls = evidence.polling_call_count === evidence.polling_calls.length && evidence.polling_calls.every((call, index) => call.poll_ordinal === index + 1);
      const attestedTimeline = [...evidence.calls, ...evidence.polling_calls].sort((left, right) => left.chronological_ordinal - right.chronological_ordinal);
      const exactTimeline = attestedTimeline.length === auditedCalls.length && attestedTimeline.every((call, index) => {
        const record = auditedCalls[index];
        const expectedRunHash = call.tool_name === "get_capabilities" ? null : sha256(run.id);
        return record !== undefined && call.chronological_ordinal === index + 1 && record.argumentHash === call.argument_sha256 && record.detail.tool === call.tool_name && record.detail.response_sha256 === call.response_sha256
          && record.detail.result_request_id_sha256 === call.result_request_id_sha256 && call.run_id_sha256 === expectedRunHash && record.detail.run_id_sha256 === expectedRunHash
          && record.detail.operation_id_sha256 === call.operation_id_sha256 && record.detail.polled_operation_id_sha256 === call.polled_operation_id_sha256
          && record.detail.authorization_kind === "oauth" && record.detail.oauth_client_id_sha256 === oauthClientHash && typeof record.detail.oauth_token_id_sha256 === "string";
      });
      const pollCounts = new Map<string, number>();
      const conclusivelySettled = new Set<string>();
      const mutationPolicyByOperation = new Map<string, { mutationCall: (typeof evidence.calls)[number]; boundaryCall: (typeof evidence.calls)[number]; requiresPoll: boolean }>();
      for (const [mutationIndex, boundaryIndex] of [[3, 4], [5, 6], [8, 9]] as const) {
        const mutationCall = evidence.calls[mutationIndex]!;
        const boundaryCall = evidence.calls[boundaryIndex]!;
        const mutationRecord = auditedCalls[mutationCall.chronological_ordinal - 1];
        if (mutationCall.operation_id_sha256) mutationPolicyByOperation.set(mutationCall.operation_id_sha256, {
          mutationCall,
          boundaryCall,
          requiresPoll: mutationRecord?.detail.operation_state !== "succeeded",
        });
      }
      const exactPollSemantics = [...evidence.polling_calls].sort((left, right) => left.chronological_ordinal - right.chronological_ordinal).every((call) => {
        const record = auditedCalls[call.chronological_ordinal - 1];
        const policy = mutationPolicyByOperation.get(call.polled_operation_id_sha256);
        const count = (pollCounts.get(call.polled_operation_id_sha256) ?? 0) + 1;
        pollCounts.set(call.polled_operation_id_sha256, count);
        if (count > 10 || conclusivelySettled.has(call.polled_operation_id_sha256) || !policy || !policy.requiresPoll
          || call.chronological_ordinal <= policy.mutationCall.chronological_ordinal || call.chronological_ordinal >= policy.boundaryCall.chronological_ordinal
          || record?.detail.polled_operation_id_sha256 !== call.polled_operation_id_sha256 || record.detail.wait_condition !== "operation_terminal"
          || typeof record.detail.wait_timeout_ms !== "number" || record.detail.wait_timeout_ms > 10_000
          || !["timeout", "ok", "completed"].includes(String(record.detail.status))) return false;
        if (record.detail.condition_satisfied === true) {
          if (record.detail.observed_operation_state !== "succeeded") return false;
          conclusivelySettled.add(call.polled_operation_id_sha256);
        } else if (record.detail.status !== "timeout") return false;
        return true;
      });
      const exactPollCoverage = [...mutationPolicyByOperation].every(([operationHash, policy]) => policy.requiresPoll
        ? conclusivelySettled.has(operationHash)
        : !pollCounts.has(operationHash));
      const referencedOperationCalls = referencedOperations.every((operation) => {
        const tool = operation.type === "start" ? "start_voice_run" : operation.type === "end" ? "end_voice_run" : operation.type;
        const publicArgumentHash = publicP01OperationArgumentHash(operation);
        return publicArgumentHash !== null && evidence.calls.some((call) => call.tool_name === tool && call.argument_sha256 === publicArgumentHash && call.operation_id_sha256 === sha256(operation.id));
      });
      const exactSuccessfulCanonicalCalls = currentEvidence !== null && evidence.calls.every((call, index) => {
        const record = auditedCalls[call.chronological_ordinal - 1];
        if (!record) return false;
        if (["get_capabilities", "wait_for_turn", "inspect_voice_run", "export_voice_evidence"].includes(call.tool_name) && record.detail.operation_id_sha256 !== null) return false;
        if (index === 0) return record.detail.status === "ok" && call.polled_operation_id_sha256 === null;
        if (index === 2) return record.detail.status === "ok" && record.detail.condition_satisfied === true && record.detail.observed_operation_state === "succeeded"
          && record.detail.wait_condition === "operation_terminal" && typeof record.detail.wait_timeout_ms === "number" && record.detail.wait_timeout_ms <= 10_000
          && call.polled_operation_id_sha256 === evidence.calls[1]!.operation_id_sha256;
        if (index === 4 || index === 6) return record.detail.status === "ok" && record.detail.condition_satisfied === true && call.polled_operation_id_sha256 === null;
        if (call.tool_name === "start_voice_run" || call.tool_name === "speak") return record.detail.submission_outcome === "durably_accepted" && record.detail.replay === false
          && ["accepted", "queued", "leased", "executing", "succeeded"].includes(String(record.detail.operation_state))
          && (call.tool_name === "start_voice_run" || record.detail.operation_state === "succeeded" || call.operation_id_sha256 !== null && conclusivelySettled.has(call.operation_id_sha256));
        if (call.tool_name === "inspect_voice_run") return record.detail.run_state === run.state || record.detail.run_state === "active" || record.detail.run_state === "ready";
        if (call.tool_name === "end_voice_run") return record.detail.submission_outcome === "durably_accepted" && record.detail.replay === false
          && (["accepted", "queued", "leased", "executing"].includes(String(record.detail.operation_state)) ? call.operation_id_sha256 !== null && conclusivelySettled.has(call.operation_id_sha256)
            : record.detail.operation_state === "succeeded" && record.detail.cleanup_complete === true && record.detail.evidence_state === "available"
              && record.detail.manifest_id_sha256 === sha256(currentEvidence.manifestId) && record.detail.manifest_sha256 === currentEvidence.manifestSha256);
        if (call.tool_name === "export_voice_evidence") return record.detail.status === "completed" && record.detail.evidence_state === "available"
          && record.detail.manifest_id_sha256 === sha256(currentEvidence.manifestId) && record.detail.manifest_sha256 === currentEvidence.manifestSha256;
        return true;
      });
      if (run.scenarioId !== "V-P01" || this.config.registeredAppId === null || evidence.registered_app_id !== this.config.registeredAppId || evidence.plugin_version !== this.config.pluginVersion || evidence.plugin_package_sha256 !== this.config.pluginPackageSha256
        || evidence.high_level_call_count !== 10 || evidence.calls.length !== 10 || auditedCalls.length !== 10 + evidence.polling_call_count || !exactCalls || !exactPollingCalls || !exactTimeline || !exactPollSemantics || !exactPollCoverage
        || new Set(evidence.operation_ids).size !== evidence.operation_ids.length || evidence.operation_ids.length !== 4 || referencedOperations.length !== evidence.operation_ids.length || operations.length !== 4
        || !referencedTypes.has("start") || referencedOperations.filter((operation) => operation.type === "speak").length !== 2 || !referencedTypes.has("end") || !referencedOperationCalls
        || referencedOperations.some((operation) => operation.state !== "succeeded") || !TERMINAL_RUN_STATES.has(run.state) || run.terminalError !== null || run.cleanupComplete !== true || currentEvidence === null || !exactSuccessfulCanonicalCalls
        || !orderedTimestamps(evidence.installed_at, evidence.fresh_task_started_at, run.createdAt.toISOString(), evidence.fresh_task_completed_at)
        || referencedOperations.some((operation) => operation.createdAt < new Date(evidence.fresh_task_started_at) || operation.updatedAt > new Date(evidence.fresh_task_completed_at))) throw attestationMismatch("P01 platform proof did not join the registered app/package, fresh task window, successful per-call HTTP receipts, succeeded start/speak/end operations, zero-orphan cleanup, and the exact exported immutable manifest.");
    }
  }

  async startVoiceRun(caller: AuthenticatedCaller, raw: unknown): Promise<LabEnvelope> {
    requireScope(caller, "voice_lab:run");
    this.assertMutationEnabled("start_voice_run");
    const input = StartSchema.parse(raw);
    if (input.scenario_id === "V-L01") requireScope(caller, "voice_lab:fault");
    assertScenarioSupported(input.scenario_id);
    if (input.environment !== this.config.environment) throw new VoiceLabError(labError("ENVIRONMENT_MISMATCH", "Requested environment does not match this isolated Voice Lab deployment.", "deployment"));
    const target = mapTarget(input.target);
    this.validateTarget(target);
    if (input.scenario_id !== "V-S01" && input.scenario_id !== "V-S02") await this.assertProductAdmissionReady(target);
    const policy = input.capture_policy ?? { raw_audio: false, screenshot: true, video: false, retention_hours: 24 };
    if (policy.raw_audio) throw new VoiceLabError(labError("RAW_AUDIO_UNAVAILABLE", "Raw audio capture is unavailable until isolated governed storage is implemented.", "authorization"));
    if (policy.video) throw new VoiceLabError(labError("VIDEO_UNAVAILABLE", "Video capture is unavailable until isolated durable storage is provisioned.", "validation"));
    this.validateRetentionPolicy(policy.retention_hours);
    const now = new Date();
    const runId = randomUUID();
    const operationId = randomUUID();
    const run: RunRecord = {
      id: runId,
      callerId: caller.subject,
      principalId: this.config.principalId,
      testRunId: randomUUID(),
      cleanupObligationId: randomUUID(),
      environment: input.environment,
      scenarioId: input.scenario_id ?? null,
      scenarioVersion: input.scenario_id ? (input.scenario_version ?? SCENARIO_CATALOG_VERSION) : null,
      state: "reserved",
      version: 1,
      target,
      observedDeployment: {},
      capturePolicy: { rawAudio: policy.raw_audio, screenshot: policy.screenshot, video: policy.video, retentionHours: policy.retention_hours },
      verdicts: initialVerdicts(),
      canonicalSessionId: null,
      threadId: null,
      providerSessionId: null,
      traceId: null,
      providerEpoch: null,
      turnId: null,
      latestCursor: 0,
      expiresAt: new Date(now.getTime() + this.config.maxRunSeconds * 1_000),
      createdAt: now,
      updatedAt: now,
      cleanupComplete: false,
      retentionPurgeDueAt: null,
      retentionPurgePending: false,
      retentionPurgeVerifiedAt: null,
      evidencePurgedAt: null,
      terminalError: null,
    };
    const requestHash = canonicalRequestHash(input);
    const providerBearing = input.scenario_id !== "V-S01" && input.scenario_id !== "V-S02";
    const rolling: RollingAdmissionFence = { reservation: {
      reservationKey: sha256(`run\u0000${caller.subject}\u0000${input.idempotency_key}`), requestHash, callerId: caller.subject, environment: input.environment, kind: "run",
      runStarts: 1, providerSeconds: providerBearing ? this.config.maxRunSeconds : 0, suites: 0, suiteChildren: 0, audioDurationMs: 0, audioBytes: 0, observedAt: now,
    }, limits: this.rollingAdmissionLimits() };
    const created = await this.ledger.createRunWithOperation(run, { id: operationId, runId, callerId: caller.subject, type: "start", idempotencyKey: input.idempotency_key, requestHash, input: input as unknown as Record<string, unknown> }, { global: this.config.maxConcurrentRuns, caller: this.config.maxRunsPerCaller }, rolling);
    const rollingAdmission = created.rollingAdmission!;
    if (!created.replay) await this.ledger.appendEvent(created.run.id, "run.accepted", "mcp", { operation_id: created.operation.id, scenario_id: created.run.scenarioId }, `operation:${created.operation.id}:accepted`);
    const fresh = await this.ledger.getRun(created.run.id) ?? created.run;
    return envelope({ run: fresh, operationId: created.operation.id, status: created.operation.state === "succeeded" ? "completed" : "accepted", data: { replay: created.replay, submission_outcome: created.replay ? "idempotent_replay" : "durably_accepted", run_state: fresh.state, operation_state: created.operation.state, rolling_admission: { replay: rollingAdmission.replay, reset_at: rollingAdmission.resetAt.toISOString(), remaining: rollingAdmission.remaining } } });
  }

  async speak(caller: AuthenticatedCaller, raw: unknown): Promise<LabEnvelope> {
    requireScope(caller, "voice_lab:run");
    this.assertMutationEnabled("speak");
    const input = SpeakSchema.parse(raw);
    validateAudioInputLimit(input, this.config.maxTextCharacters);
    await this.ownedRun(caller, input.run_id);
    // Resolve only immutable metadata before the ready-state precondition. This
    // gives V-S02 a real authenticated public `/mcp` path for an unknown
    // fixture while still creating no operation, TTS process, browser, or
    // provider work. Ownership is checked first, so this does not become a
    // fixture-enumeration side channel for unrelated callers.
    const reservation = await reserveAudioInput(input, await this.fixtures(), this.config);
    const run = await this.ownedRun(caller, input.run_id);
    const operationInput = { ...(input as unknown as Record<string, unknown>), _admission: reservation };
    const existing = (await this.ledger.listOperations(run.id)).find((operation) => operation.type === "speak" && operation.idempotencyKey === input.idempotency_key);
    if (!existing) {
      await this.assertInputPreconditions(caller, input.run_id, input);
      await this.assertAdaptiveObservation(run, input);
    }
    const rolling = this.rollingAudioFence(run, caller.subject, "speak", input.idempotency_key, operationInput, reservation);
    const accepted = await this.queueRunOperation(caller, input.run_id, "speak", input.idempotency_key, operationInput, true, rolling);
    return this.awaitSchedulingReceipt(caller, accepted, input.timing_policy?.schedule_timeout_ms ?? 10_000);
  }

  async bargeIn(caller: AuthenticatedCaller, raw: unknown): Promise<LabEnvelope> {
    requireScope(caller, "voice_lab:run");
    this.assertMutationEnabled("barge_in");
    const input = BargeSchema.parse(raw);
    validateAudioInputLimit(input, this.config.maxTextCharacters);
    const run = await this.ownedRun(caller, input.run_id);
    await this.assertInputPreconditions(caller, input.run_id, input);
    await this.assertAdaptiveObservation(run, input);
    const page = await this.ledger.listEvents(input.run_id, input.after_output_event_seq - 1, 1);
    const referenced = page.events.find((event) => event.seq === input.after_output_event_seq && event.kind === "audio.output.started");
    if (!referenced) throw new VoiceLabError(labError("OUTPUT_PRECONDITION_FAILED", "Barge-in must reference an observed output playback-start event.", "conflict", true));
    const productBinding = referenced.payload._product_run_binding as Record<string, unknown> | undefined;
    if (referenced.source !== "product" || productBinding?.app_authenticated !== true || productBinding.test_run_id_sha256 !== sha256(run.testRunId) || productBinding.principal_id_sha256 !== sha256(run.principalId)) throw new VoiceLabError(labError("OUTPUT_PRECONDITION_FAILED", "Barge-in output receipt lacks exact app-authored synthetic run provenance.", "conflict", false));
    const receipt = referenced.payload.receipt as Record<string, unknown> | undefined;
    const realizationId = typeof receipt?.realizationId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(receipt.realizationId) ? receipt.realizationId : null;
    const providerConnectionEpoch = Number(receipt?.providerConnectionEpoch);
    const playbackGeneration = Number(receipt?.playbackGeneration);
    const startedAt = typeof receipt?.timestamp === "string" ? Date.parse(receipt.timestamp) : Number.NaN;
    if (receipt?.phase !== "started" || realizationId === null || !Number.isSafeInteger(providerConnectionEpoch) || providerConnectionEpoch < 0
      || run.providerEpoch === null || providerConnectionEpoch !== run.providerEpoch || !Number.isSafeInteger(playbackGeneration) || playbackGeneration < 0
      || !Number.isFinite(startedAt) || Math.abs(referenced.at.getTime() - startedAt) > 2_000) {
      throw new VoiceLabError(labError("OUTPUT_PRECONDITION_FAILED", "Barge-in requires an exact current-epoch playback-start receipt with realization, generation, and source timestamp.", "conflict", false));
    }
    const targetAt = startedAt + input.delay_ms;
    const lateness = Date.now() - targetAt;
    if (lateness > input.max_lateness_ms) throw new VoiceLabError(labError("BARGE_WINDOW_MISSED", "The cited playback realization can no longer meet the declared barge-in timing window.", "conflict", true, { lateness_ms: lateness, max_lateness_ms: input.max_lateness_ms }));
    let scan = input.after_output_event_seq;
    for (;;) {
      const following = await this.ledger.listEvents(input.run_id, scan, 500);
      if (following.events.some((event) => {
        if (event.kind === "audio.output.started") return true;
        if (!["audio.output.completed", "audio.output.flushed", "audio.output.dropped"].includes(event.kind)) return false;
        const later = event.payload.receipt as Record<string, unknown> | undefined;
        return later?.realizationId === realizationId && Number(later?.providerConnectionEpoch) === providerConnectionEpoch && Number(later?.playbackGeneration) === playbackGeneration;
      })) throw new VoiceLabError(labError("OUTPUT_NOT_ACTIVE", "The referenced assistant playback is no longer the latest active output.", "conflict", true));
      if (following.events.length < 500) break;
      scan = following.events.at(-1)!.seq;
      if (scan - input.after_output_event_seq >= 10_000) throw new VoiceLabError(labError("OUTPUT_ACTIVITY_SCAN_LIMIT", "Output activity proof exceeded the bounded event scan.", "conflict", true));
    }
    let toolTarget: Record<string, unknown> | null = null;
    if (run.scenarioId === "V-I02") {
      if (!input.tool_boundary) throw new VoiceLabError(labError("TOOL_BOUNDARY_REQUIRED", "V-I02 requires an exact app-authored in-flight tool/effect boundary.", "validation", false));
      const boundaryPage = await this.ledger.listEvents(run.id, input.tool_boundary.event_seq - 1, 2);
      const boundary = boundaryPage.events.find((event) => event.seq === input.tool_boundary!.event_seq);
      const entry = boundary?.payload.entry as Record<string, unknown> | undefined;
      const capture = boundary?.payload._capture_provenance as Record<string, unknown> | undefined;
      const toolEvidence = entry?.syntheticToolEvidence as Record<string, unknown> | undefined;
      const ownerOperations = await this.ledger.listOperations(run.id);
      const owner = ownerOperations.find((operation) => operation.id === toolEvidence?.operation_id && (operation.type === "speak" || operation.type === "barge_in") && operation.state === "succeeded");
      if (!boundary || !isExactBoundProductEventForService(run, boundary) || !boundary.kind.includes("gemini-tool-call-ledger") || entry?.toolCallId !== input.tool_boundary.tool_call_id || entry.effectId !== input.tool_boundary.effect_id
        || entry.finalState !== "unknown" || typeof entry.receivedAt !== "string" || entry.toolResponseSentAt !== null || entry.cancelledAt !== null || Number(entry.providerConnectionEpoch) !== run.providerEpoch
        || !Number.isSafeInteger(capture?.generation) || Number(capture?.generation) < 1 || !Number.isSafeInteger(capture?.seq) || Number(capture?.seq) < 1
        || toolEvidence?.schema !== "sophia_synthetic_tool_evidence_v1" || toolEvidence.test_run_id !== run.testRunId || toolEvidence.scenario_id !== run.scenarioId || toolEvidence.scenario_version !== run.scenarioVersion
        || toolEvidence.tool_call_id !== entry.toolCallId || toolEvidence.effect_id !== entry.effectId || toolEvidence.provider_connection_epoch !== entry.providerConnectionEpoch || owner === undefined) {
        throw new VoiceLabError(labError("TOOL_BOUNDARY_PRECONDITION_FAILED", "V-I02 tool boundary was not one exact current-epoch in-flight effect owned by a succeeded synthetic input.", "conflict", false));
      }
      let scan = boundary.seq;
      for (;;) {
        const later = await this.ledger.listEvents(run.id, scan, 500);
        if (later.events.some((event) => {
          const laterEntry = event.payload.entry as Record<string, unknown> | undefined;
          return laterEntry !== undefined && event.kind.includes("gemini-tool-call-ledger") && laterEntry.toolCallId === entry.toolCallId && laterEntry.effectId === entry.effectId && isTerminalToolLedgerEntry(laterEntry);
        })) throw new VoiceLabError(labError("TOOL_BOUNDARY_NOT_ACTIVE", "The cited tool effect settled before barge-in admission.", "conflict", true));
        if (later.events.length < 500) break;
        scan = later.events.at(-1)!.seq;
      }
      toolTarget = { event_seq: boundary.seq, product_generation: Number(capture!.generation), product_seq: Number(capture!.seq), tool_call_id: entry.toolCallId, effect_id: entry.effectId, provider_connection_epoch: entry.providerConnectionEpoch, owner_operation_id: owner.id, owner_utterance_id: toolEvidence.utterance_id, provider_input_sequence: toolEvidence.provider_input_sequence, received_at: entry.receivedAt, activity_state: "in_flight" };
    } else if (input.tool_boundary) throw new VoiceLabError(labError("TOOL_BOUNDARY_NOT_ALLOWED", "A tool boundary target is accepted only for V-I02.", "validation", false));
    const reservation = await reserveAudioInput(input, await this.fixtures(), this.config);
    const operationInput = { ...(input as unknown as Record<string, unknown>), _admission: reservation, _barge_target: { after_output_event_seq: referenced.seq, output_started_at: new Date(startedAt).toISOString(), target_schedule_at: new Date(targetAt).toISOString(), max_lateness_ms: input.max_lateness_ms, intentional_overlap: true, realization_id: realizationId, chunk_hash: receipt?.chunkHash ?? null, provider_connection_epoch: providerConnectionEpoch, playback_generation: playbackGeneration, receipt_phase: "started" }, ...(toolTarget ? { _tool_target: toolTarget } : {}) };
    const rolling = this.rollingAudioFence(run, caller.subject, "barge_in", input.idempotency_key, operationInput, reservation);
    const accepted = await this.queueRunOperation(caller, input.run_id, "barge_in", input.idempotency_key, operationInput, true, rolling);
    return this.awaitSchedulingReceipt(caller, accepted, input.timing_policy?.schedule_timeout_ms ?? 10_000);
  }

  async forceSocketRotation(caller: AuthenticatedCaller, raw: unknown): Promise<LabEnvelope> {
    requireScope(caller, "voice_lab:fault");
    this.assertMutationEnabled("force_socket_rotation");
    const input = RotateSchema.parse(raw);
    const run = await this.ownedRun(caller, input.run_id);
    if (run.scenarioId === "V-N02" && !input.commit_target) throw new VoiceLabError(labError("COMMIT_TARGET_REQUIRED", "V-N02 requires an exact app-authored committed output or tool-effect target.", "validation", false));
    if (run.scenarioId !== "V-N02" && input.commit_target) throw new VoiceLabError(labError("COMMIT_TARGET_NOT_ALLOWED", "A committed-boundary target is only accepted for V-N02.", "validation", false));
    if (input.expected_socket_epoch !== run.providerEpoch) throw new VoiceLabError(labError("PROVIDER_EPOCH_PRECONDITION_FAILED", "Requested provider epoch is not the run's current exact product epoch.", "conflict", true));
    let commitTarget: Record<string, unknown> | null = null;
    if (input.commit_target) {
      const page = await this.ledger.listEvents(run.id, input.commit_target.event_seq - 1, 2);
      const event = page.events.find((candidate) => candidate.seq === input.commit_target!.event_seq);
      const binding = event?.payload._product_run_binding as Record<string, unknown> | undefined;
      const exactBound = event?.source === "product" && binding?.app_authenticated === true && binding.synthetic === true
        && binding.test_run_id_sha256 === sha256(run.testRunId) && binding.principal_id_sha256 === sha256(run.principalId)
        && binding.environment === run.environment && binding.scenario_id === run.scenarioId && binding.scenario_version === run.scenarioVersion;
      if (!event || !exactBound) throw new VoiceLabError(labError("COMMIT_TARGET_PRECONDITION_FAILED", "Committed target is not an exact app-authored event for this synthetic run.", "conflict", false));
      if (input.commit_target.kind === "output_realization") {
        const receipt = event.payload.receipt as Record<string, unknown> | undefined;
        const capture = event.payload._capture_provenance as Record<string, unknown> | undefined;
        const epoch = Number(receipt?.providerConnectionEpoch);
        const generation = Number(receipt?.playbackGeneration);
        if (event.kind !== "audio.output.started" || receipt?.phase !== "started" || receipt.realizationId !== input.commit_target.stable_id
          || epoch !== input.expected_socket_epoch || !Number.isSafeInteger(generation) || generation < 0 || typeof receipt.chunkHash !== "string" || !/^[a-f0-9]{64}$/i.test(receipt.chunkHash)) {
          throw new VoiceLabError(labError("COMMIT_TARGET_PRECONDITION_FAILED", "Output target must be the exact in-flight started realization at the current provider epoch.", "conflict", false));
        }
        if (!Number.isSafeInteger(capture?.generation) || Number(capture?.generation) < 1 || !Number.isSafeInteger(capture?.seq) || Number(capture?.seq) < 1) throw new VoiceLabError(labError("COMMIT_TARGET_PRECONDITION_FAILED", "Output target lacks its exact product capture cursor.", "conflict", false));
        const observed = await readCompleteEventLedger(this.ledger, run.id);
        const reusedIdentity = observed.some((candidate) => {
          if (candidate.seq === event.seq || !isExactBoundProductEventForService(run, candidate)
            || !["audio.output.started", "audio.output.completed", "audio.output.flushed", "audio.output.dropped"].includes(candidate.kind)) return false;
          const other = candidate.payload.receipt as Record<string, unknown> | undefined;
          return other?.realizationId === input.commit_target!.stable_id || other?.chunkHash === receipt.chunkHash;
        });
        if (reusedIdentity) throw new VoiceLabError(labError("COMMIT_TARGET_PRECONDITION_FAILED", "Output target stable realization or chunk identity was already started or terminal elsewhere in the product ledger.", "conflict", false));
        commitTarget = { event_seq: event.seq, product_generation: Number(capture!.generation), product_seq: Number(capture!.seq), kind: input.commit_target.kind, stable_id: input.commit_target.stable_id, provider_connection_epoch: epoch, playback_generation: generation, chunk_hash: receipt.chunkHash, active_at: receipt.timestamp ?? event.at.toISOString(), activity_state: "in_flight" };
      } else {
        const entry = event.payload.entry as Record<string, unknown> | undefined;
        const capture = event.payload._capture_provenance as Record<string, unknown> | undefined;
        const toolEvidence = entry?.syntheticToolEvidence as Record<string, unknown> | undefined;
        const epoch = Number(entry?.providerConnectionEpoch);
        const ownerOperations = await this.ledger.listOperations(run.id);
        const owner = ownerOperations.find((operation) => operation.id === toolEvidence?.operation_id && (operation.type === "speak" || operation.type === "barge_in") && operation.state === "succeeded");
        if (!event.kind.includes("gemini-tool-call-ledger") || entry?.toolCallId !== input.commit_target.stable_id || entry.effectId !== input.commit_target.effect_id
          || entry.finalState !== "unknown" || typeof entry.receivedAt !== "string" || entry.toolResponseSentAt !== null || entry.cancelledAt !== null || epoch !== input.expected_socket_epoch
          || toolEvidence?.schema !== "sophia_synthetic_tool_evidence_v1" || toolEvidence.test_run_id !== run.testRunId || toolEvidence.scenario_id !== run.scenarioId || toolEvidence.scenario_version !== run.scenarioVersion
          || toolEvidence.tool_call_id !== entry.toolCallId || toolEvidence.effect_id !== entry.effectId || toolEvidence.provider_connection_epoch !== entry.providerConnectionEpoch
          || typeof toolEvidence.utterance_id !== "string" || !Number.isSafeInteger(toolEvidence.provider_input_sequence) || Number(toolEvidence.provider_input_sequence) < 1 || owner === undefined) {
          throw new VoiceLabError(labError("COMMIT_TARGET_PRECONDITION_FAILED", "Tool target requires one exact in-flight effect ID at the current provider epoch.", "conflict", false));
        }
        if (!Number.isSafeInteger(capture?.generation) || Number(capture?.generation) < 1 || !Number.isSafeInteger(capture?.seq) || Number(capture?.seq) < 1) throw new VoiceLabError(labError("COMMIT_TARGET_PRECONDITION_FAILED", "Tool target lacks its exact product capture cursor.", "conflict", false));
        commitTarget = { event_seq: event.seq, product_generation: Number(capture!.generation), product_seq: Number(capture!.seq), kind: input.commit_target.kind, stable_id: input.commit_target.stable_id, effect_id: input.commit_target.effect_id, provider_connection_epoch: epoch, owner_operation_id: owner.id, owner_utterance_id: toolEvidence.utterance_id, provider_input_sequence: toolEvidence.provider_input_sequence, active_at: entry.receivedAt, activity_state: "in_flight" };
      }
      let scan = event.seq;
      for (;;) {
        const later = await this.ledger.listEvents(run.id, scan, 500);
        const settled = later.events.some((candidate) => {
          if (input.commit_target!.kind === "output_realization") {
            const receipt = candidate.payload.receipt as Record<string, unknown> | undefined;
            return ["audio.output.completed", "audio.output.flushed", "audio.output.dropped"].includes(candidate.kind) && (receipt?.realizationId === input.commit_target!.stable_id || receipt?.chunkHash === commitTarget?.chunk_hash);
          }
          const entry = candidate.payload.entry as Record<string, unknown> | undefined;
          return candidate.kind.includes("gemini-tool-call-ledger") && entry?.toolCallId === input.commit_target!.stable_id && entry.effectId === input.commit_target!.effect_id && isTerminalToolLedgerEntry(entry);
        });
        if (settled) throw new VoiceLabError(labError("COMMIT_TARGET_NOT_ACTIVE", "The cited N02 work settled before rotation admission.", "conflict", true));
        if (later.events.length < 500) break;
        scan = later.events.at(-1)!.seq;
      }
    }
    let faultTarget: Record<string, unknown> | null = null;
    if (run.scenarioId === "V-O02") {
      const started = await this.ledger.findLatestEvent(run.id, ["audio.output.started"]);
      const binding = started?.payload._product_run_binding as Record<string, unknown> | undefined;
      const receipt = started?.payload.receipt as Record<string, unknown> | undefined;
      const realizationId = typeof receipt?.realizationId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(receipt.realizationId) ? receipt.realizationId : null;
      const epoch = Number(receipt?.providerConnectionEpoch);
      const generation = Number(receipt?.playbackGeneration);
      if (!started || started.source !== "product" || binding?.app_authenticated !== true || binding.test_run_id_sha256 !== sha256(run.testRunId)
        || binding.principal_id_sha256 !== sha256(run.principalId) || receipt?.phase !== "started" || realizationId === null
        || !Number.isSafeInteger(epoch) || epoch !== input.expected_socket_epoch || epoch !== run.providerEpoch || !Number.isSafeInteger(generation) || generation < 0) {
        throw new VoiceLabError(labError("OUTPUT_PRECONDITION_FAILED", "V-O02 rotation requires the exact active output realization at the requested current provider epoch.", "conflict", true));
      }
      faultTarget = { output_event_seq: started.seq, realization_id: realizationId, chunk_hash: receipt.chunkHash ?? null, provider_connection_epoch: epoch, playback_generation: generation, started_at: receipt.timestamp ?? started.at.toISOString(), fault_intent: "invalidate_active_realization" };
    }
    return this.queueRunOperation(caller, input.run_id, "force_socket_rotation", input.idempotency_key, { ...(input as unknown as Record<string, unknown>), ...(faultTarget ? { _fault_target: faultTarget } : {}), ...(commitTarget ? { _commit_target: commitTarget } : {}) });
  }

  async endVoiceRun(caller: AuthenticatedCaller, raw: unknown): Promise<LabEnvelope> {
    requireScope(caller, "voice_lab:run");
    const input = EndSchema.parse(raw);
    const run = await this.ownedRun(caller, input.run_id);
    if (TERMINAL_RUN_STATES.has(run.state)) {
      const recovery = await this.ledger.findLatestEvent(run.id, ["cleanup.recovery"]);
      const evidence = await this.ledger.getEvidence(run.id);
      const complete = run.cleanupComplete && evidence !== null;
      return envelope({ run, status: complete ? "completed" : "unavailable", evidence: evidence?.artifactRefs ?? [], warnings: complete ? [] : [{ code: run.cleanupComplete ? "EVIDENCE_PENDING" : "CLEANUP_RECOVERY_PENDING", message: run.cleanupComplete ? "Run is terminal but its immutable evidence revision is not durable yet." : "Run is terminal but zero-orphan recovery remains pending or failed; the worker will retry the durable recovery boundary." }], retryability: complete ? "not_retryable" : "retryable", data: { replay: true, run_state: run.state, cleanup: run.cleanupComplete ? "complete" : recovery?.payload.pending === true ? "pending" : "failed_or_unobserved", evidence_state: evidence ? "available" : "pending", manifest_id: evidence?.manifestId ?? null, recovery_receipt: recovery ? publicEvent(recovery, run.id, run.testRunId) : null } });
    }
    const accepted = await this.queueRunOperation(caller, input.run_id, "end", input.idempotency_key, input as unknown as Record<string, unknown>);
    return this.awaitEndSettlement(caller, accepted, input.wait_timeout_ms ?? (this.config.endOperationSeconds + 15) * 1_000);
  }

  async waitForTurn(caller: AuthenticatedCaller, raw: unknown): Promise<LabEnvelope> {
    requireScope(caller, "voice_lab:read");
    const input = WaitSchema.parse(raw);
    let run = await this.ownedRun(caller, input.run_id);
    const timeoutMs = Math.min(input.timeout_ms, this.config.maxWaitMs);
    const deadline = Date.now() + timeoutMs;
    let scanCursor = input.after_cursor;
    let scanned = 0;
    const returnedEvents: ReturnType<typeof publicEvent>[] = [];
    do {
      const page = await this.ledger.listEvents(run.id, scanCursor, 500);
      const matches = page.events.filter((event) => (event.source !== "product" || isExactBoundProductEventForService(run, event)) && eventMatches(event, input.condition, input.operation_id));
      scanned += page.events.length;
      returnedEvents.push(...page.events.slice(Math.max(0, page.events.length - 500)).map((event) => publicEvent(event, run.id, run.testRunId)));
      if (returnedEvents.length > 500) returnedEvents.splice(0, returnedEvents.length - 500);
      if (page.events.length > 0) scanCursor = page.events.at(-1)!.seq;
      if (matches.length > 0) {
        const observationReceipts = run.scenarioId === "V-P01"
          ? matches.map((event) => this.mintP01ObservationReceipt(run, event)).filter((receipt) => receipt !== null)
          : [];
        return envelope({ run, after: input.after_cursor, status: TERMINAL_RUN_STATES.has(run.state) ? "completed" : "ok", data: { condition: input.condition, condition_satisfied: true, matched: matches.map((event) => publicEvent(event, run.id, run.testRunId)), ...(observationReceipts.length > 0 ? { observation_receipts: observationReceipts } : {}), events: returnedEvents, terminal: TERMINAL_RUN_STATES.has(run.state), scanned_event_count: scanned, scan_cursor: scanCursor } });
      }
      if (TERMINAL_RUN_STATES.has(run.state)) {
        return envelope({ run, after: input.after_cursor, status: "unavailable", warnings: [{ code: "CONDITION_UNMATCHED_TERMINAL", message: "Run became terminal without the requested exact observation." }], retryability: "not_retryable", data: { condition: input.condition, condition_satisfied: false, matched: [], events: returnedEvents, terminal: true, scanned_event_count: scanned, scan_cursor: scanCursor } });
      }
      if (scanned >= 10_000) return envelope({ run, after: input.after_cursor, status: "unavailable", warnings: [{ code: "WAIT_SCAN_LIMIT", message: "Wait scan exceeded the bounded 10,000-event limit; resume from scan_cursor." }], retryability: "retryable", data: { condition: input.condition, matched: [], scanned_event_count: scanned, scan_cursor: scanCursor, truncation: "bounded_scan_limit" } });
      if (page.events.length === 500) continue;
      await delay(50);
      run = await this.ownedRun(caller, input.run_id);
    } while (Date.now() < deadline);
    return envelope({ run, after: input.after_cursor, status: "timeout", warnings: [{ code: "WAIT_TIMEOUT", message: "No matching event was observed before the bounded timeout." }], retryability: "retryable", data: { condition: input.condition, matched: [], timeout_ms: timeoutMs, scanned_event_count: scanned, scan_cursor: scanCursor } });
  }

  async inspectVoiceRun(caller: AuthenticatedCaller, raw: unknown): Promise<LabEnvelope> {
    requireScope(caller, "voice_lab:read");
    const input = InspectSchema.parse(raw);
    const run = await this.ownedRun(caller, input.run_id);
    const page = await this.ledger.listEvents(run.id, input.after_cursor, input.limit);
    return envelope({ run, after: input.after_cursor, status: TERMINAL_RUN_STATES.has(run.state) ? "completed" : "running", data: { run_state: run.state, events: page.events.map((event) => publicEvent(event, run.id, run.testRunId)), expires_at: run.expiresAt.toISOString(), terminal_error: run.terminalError } });
  }

  async exportVoiceEvidence(caller: AuthenticatedCaller, raw: unknown): Promise<LabEnvelope> {
    requireScope(caller, "voice_lab:read");
    const input = ExportSchema.parse(raw);
    const run = await this.ledger.getRun(input.run_id);
    if (!run) {
      const tombstone = await this.ledger.getRetentionTombstone(input.run_id, caller.subject);
      if (tombstone) return envelope({ status: "unavailable", warnings: [{ code: "EVIDENCE_RETENTION_EXPIRED", message: "Evidence was permanently purged at its signed retention deadline." }], retryability: "not_retryable", data: { evidence_state: "retention_purged", purged_at: tombstone.purgedAt.toISOString(), remote_purge_status: tombstone.remotePurgeStatus } });
      throw new VoiceLabError(labError("RUN_NOT_FOUND", "Run was not found.", "validation"));
    }
    if (run.callerId !== caller.subject) throw new VoiceLabError(labError("RUN_NOT_FOUND", "Run was not found.", "validation"));
    const evidence = await this.ledger.getEvidence(run.id);
    if (!evidence) return envelope({ run, status: "unavailable", warnings: [{ code: "EVIDENCE_PENDING", message: "Evidence is not durable yet; retry after finalization." }], retryability: "retryable", data: { evidence_state: "pending" } });
    return envelope({ run, status: "completed", evidence: evidence.artifactRefs, data: { evidence_state: "available", manifest_id: evidence.manifestId, manifest_sha256: evidence.manifestSha256, schema_version: evidence.schemaVersion, created_at: evidence.createdAt.toISOString() } });
  }

  async runRegressionSuite(caller: AuthenticatedCaller, raw: unknown): Promise<LabEnvelope> {
    requireScope(caller, "voice_lab:run");
    this.assertMutationEnabled("run_regression_suite");
    const input = SuiteSchema.parse(raw);
    const requestHash = canonicalRequestHash(input);
    const now = new Date();
    const policy = input.capture_policy ?? { raw_audio: false, screenshot: true, video: false, retention_hours: 24 };
    if (policy.raw_audio || policy.video) throw new VoiceLabError(labError(policy.raw_audio ? "RAW_AUDIO_UNAVAILABLE" : "VIDEO_UNAVAILABLE", "Suite capture requested a media class without isolated governed storage.", "authorization"));
    this.validateRetentionPolicy(policy.retention_hours);
    if (input.environment !== this.config.environment) throw new VoiceLabError(labError("ENVIRONMENT_MISMATCH", "Requested suite environment does not match this isolated Voice Lab deployment.", "deployment"));
    const target = mapTarget(input.target);
    this.validateTarget(target);
    const hasProviderBearingChild = input.scenarios.some((scenario) => {
      const catalog = SCENARIO_CATALOG.find((candidate) => candidate.id === scenario.id)!;
      return catalog.support === "supported" && scenario.id !== "V-S01" && scenario.id !== "V-S02";
    });
    if (hasProviderBearingChild) await this.assertProductAdmissionReady(target);
    const suite: SuiteRecord = {
      id: randomUUID(), callerId: caller.subject, idempotencyKey: input.idempotency_key, requestHash, state: "accepted",
      scenarioIds: input.scenarios.map((scenario) => scenario.id), runIds: [],
      definition: { environment: input.environment, target, scenarios: input.scenarios.map((scenario) => { const catalog = SCENARIO_CATALOG.find((candidate) => candidate.id === scenario.id)!; return { id: scenario.id, version: scenario.version ?? SCENARIO_CATALOG_VERSION, support: catalog.support, unavailableReason: catalog.unavailableReason ?? null }; }), capturePolicy: { rawAudio: false, screenshot: policy.screenshot, video: false, retentionHours: policy.retention_hours } },
      nextScenarioIndex: 0, createdAt: now, updatedAt: now,
    };
    const supportedChildren = suite.definition.scenarios.filter((scenario) => scenario.support === "supported").length;
    const providerChildren = suite.definition.scenarios.filter((scenario) => scenario.support === "supported" && scenario.id !== "V-S01" && scenario.id !== "V-S02").length;
    const rolling: RollingAdmissionFence = { reservation: {
      reservationKey: sha256(`suite\u0000${caller.subject}\u0000${input.idempotency_key}`), requestHash, callerId: caller.subject, environment: input.environment, kind: "suite",
      runStarts: supportedChildren, providerSeconds: providerChildren * this.config.maxRunSeconds, suites: 1, suiteChildren: supportedChildren, audioDurationMs: 0, audioBytes: 0, observedAt: now,
    }, limits: this.rollingAdmissionLimits() };
    const created = await this.ledger.createSuite(suite, rolling);
    const rollingAdmission = created.rollingAdmission!;
    if (created.replay) {
      const terminal = ["completed", "failed", "cancelled"].includes(created.suite.state);
      const evidence = terminal ? await this.ledger.getSuiteEvidence(created.suite.id) : null;
      return envelope({ suite: created.suite, status: created.suite.state === "completed" ? "completed" : terminal ? "failed" : "running", ...(evidence ? { evidence: evidence.artifactRefs.filter((reference) => reference.kind === "suite_manifest") } : {}), data: { replay: true, state: created.suite.state, run_ids: created.suite.runIds, aggregate_evidence: evidence ? { status: "available", manifest_id: evidence.manifestId, manifest_sha256: evidence.manifestSha256, schema_version: evidence.schemaVersion } : terminal ? { status: "pending", reason: "terminal_aggregate_manifest_pending" } : { status: "pending", reason: "children_not_terminal" } } });
    }
    return envelope({ suite: created.suite, status: "accepted", data: { replay: false, state: created.suite.state, run_ids: [], max_concurrency: 1, scheduling: "agent_guided_sequential", next_required_action: "wait_for_child_ready_then_drive_scenario_recipe", rolling_admission: { replay: rollingAdmission.replay, reset_at: rollingAdmission.resetAt.toISOString(), remaining: rollingAdmission.remaining } } });
  }

  async getSuiteRun(caller: AuthenticatedCaller, raw: unknown): Promise<LabEnvelope> {
    requireScope(caller, "voice_lab:read");
    const input = GetSuiteSchema.parse(raw);
    const suite = await this.ledger.getSuite(input.suite_run_id);
    if (!suite || suite.callerId !== caller.subject) throw new VoiceLabError(labError("SUITE_NOT_FOUND", "Suite run was not found.", "validation"));
    const runs = await Promise.all(suite.runIds.map((id) => this.ledger.getRun(id)));
    const fresh = await this.ledger.getSuite(suite.id) ?? suite;
    const terminal = fresh.state === "completed" || fresh.state === "failed" || fresh.state === "cancelled";
    const current = [...runs].reverse().find((run): run is RunRecord => Boolean(run && !TERMINAL_RUN_STATES.has(run.state))) ?? null;
    const evidence = terminal ? await this.ledger.getSuiteEvidence(fresh.id) : null;
    const unsupported = fresh.definition.scenarios.filter((scenario) => scenario.support === "typed_unsupported").map((scenario) => ({ scenario_id: scenario.id, scenario_version: scenario.version, status: "typed_unsupported", unavailable_reason: scenario.unavailableReason }));
    return envelope({ suite: fresh, status: fresh.state === "completed" ? "completed" : terminal ? "failed" : "running", ...(evidence ? { evidence: evidence.artifactRefs.filter((reference) => reference.kind === "suite_manifest") } : {}), data: { state: fresh.state, scheduling: "agent_guided_sequential", next_scenario_index: fresh.nextScenarioIndex, scenario_count: fresh.definition.scenarios.length, current_child_run_id: current?.id ?? null, next_required_action: terminal ? null : current ? "inspect_child_and_drive_scenario_recipe_then_end" : "wait_for_child_allocation", aggregate_evidence: evidence ? { status: "available", manifest_id: evidence.manifestId, manifest_sha256: evidence.manifestSha256, schema_version: evidence.schemaVersion, resource_id: `voice-lab://suite-evidence/${evidence.manifestId}` } : terminal ? { status: "pending", reason: "terminal_aggregate_manifest_pending" } : { status: "pending", reason: "children_not_terminal" }, unsupported_scenarios: unsupported, runs: runs.filter(Boolean).map((run) => ({ run_id: run!.id, scenario_id: run!.scenarioId, scenario_version: run!.scenarioVersion, state: run!.state, verdicts: run!.verdicts, cleanup_complete: run!.cleanupComplete, event_cursor: run!.latestCursor })) } });
  }

  async queueRunOperation(caller: AuthenticatedCaller, runId: string, type: "speak" | "barge_in" | "force_socket_rotation" | "end", idempotencyKey: string, input: Record<string, unknown>, audioAdmission = false, rolling?: RollingAdmissionFence): Promise<LabEnvelope> {
    const run = await this.ownedRun(caller, runId);
    assertRunAcceptsOperation(run, type);
    const created = await this.ledger.createOperation({ id: randomUUID(), runId, callerId: caller.subject, type, idempotencyKey, requestHash: canonicalRequestHash(input), input }, audioAdmission ? { maxUtterances: this.config.maxUtterancesPerRun, maxTotalDurationMs: this.config.maxInjectedDurationMs, maxTotalBytes: this.config.maxInjectedBytes, minIntervalMs: this.config.minUtteranceIntervalMs } : undefined, rolling);
    if (!created.replay) await this.ledger.appendEvent(runId, `operation.${type}.accepted`, "mcp", { operation_id: created.operation.id }, `operation:${created.operation.id}:accepted`);
    else await this.ledger.appendEvent(runId, `operation.${type}.idempotent_replay`, "mcp", { operation_id: created.operation.id, exact_request_hash_replay: true, no_new_operation: true }, `operation:${created.operation.id}:idempotent-replay`);
    const fresh = await this.ledger.getRun(runId) ?? run;
    return envelope({ run: fresh, operationId: created.operation.id, status: created.operation.state === "succeeded" ? "completed" : "accepted", data: { replay: created.replay, submission_outcome: created.replay ? "idempotent_replay" : "durably_accepted", operation_state: created.operation.state } });
  }

  async awaitSchedulingReceipt(caller: AuthenticatedCaller, accepted: LabEnvelope, timeoutMs: number): Promise<LabEnvelope> {
    if (!accepted.operation_id || !accepted.run_id) return accepted;
    const deadline = Date.now() + Math.min(timeoutMs, this.config.maxOperationSeconds * 1_000);
    while (Date.now() < deadline) {
      const operation = await this.ledger.getOperation(accepted.operation_id);
      const run = await this.ownedRun(caller, accepted.run_id);
      if (!operation) throw new VoiceLabError(labError("OPERATION_NOT_FOUND", "Scheduling operation was not found.", "internal"));
      if (operation.state === "succeeded") return envelope({ run, operationId: operation.id, status: "completed", data: { replay: Boolean(accepted.data.replay), submission_outcome: accepted.data.submission_outcome, operation_state: operation.state, ...(operation.result ?? {}) } });
      if (operation.state === "failed" || operation.state === "timed_out" || operation.state === "cancelled") return envelope({ run, operationId: operation.id, status: "failed", error: operation.error ?? labError("SCHEDULING_FAILED", "Page-side audio scheduling failed.", "harness"), data: { replay: Boolean(accepted.data.replay), submission_outcome: accepted.data.submission_outcome, operation_state: operation.state } });
      await delay(25);
    }
    const run = await this.ownedRun(caller, accepted.run_id);
    const operation = await this.ledger.getOperation(accepted.operation_id);
    return envelope({ run, operationId: accepted.operation_id, status: "timeout", warnings: [{ code: "SCHEDULING_PENDING", message: "Page-side scheduling is still pending; inspect the durable operation and retry with the same idempotency key." }], retryability: "retryable", data: { replay: Boolean(accepted.data.replay), submission_outcome: accepted.data.submission_outcome, operation_state: operation?.state ?? "unknown", receipt: null } });
  }

  async awaitEndSettlement(caller: AuthenticatedCaller, accepted: LabEnvelope, timeoutMs: number): Promise<LabEnvelope> {
    if (!accepted.operation_id || !accepted.run_id) return accepted;
    const boundedMs = Math.min(timeoutMs, (this.config.endOperationSeconds + 15) * 1_000);
    const deadline = Date.now() + boundedMs;
    do {
      const operation = await this.ledger.getOperation(accepted.operation_id);
      const run = await this.ownedRun(caller, accepted.run_id);
      if (!operation) throw new VoiceLabError(labError("OPERATION_NOT_FOUND", "End operation was not found.", "internal"));
      const evidence = await this.ledger.getEvidence(run.id);
      if (["failed", "timed_out", "cancelled"].includes(operation.state)) {
        return envelope({ run, operationId: operation.id, status: "failed", error: operation.error ?? labError("END_FAILED", "Bounded canonical finalization failed.", "harness", false), evidence: evidence?.artifactRefs ?? [], data: { replay: Boolean(accepted.data.replay), submission_outcome: accepted.data.submission_outcome, operation_state: operation.state, run_state: run.state, cleanup_complete: run.cleanupComplete, evidence_state: evidence ? "available" : "pending" } });
      }
      if (operation.state === "succeeded" && TERMINAL_RUN_STATES.has(run.state) && run.cleanupComplete && evidence) {
        return envelope({ run, operationId: operation.id, status: "completed", evidence: evidence.artifactRefs, data: { replay: Boolean(accepted.data.replay), submission_outcome: accepted.data.submission_outcome, operation_state: operation.state, run_state: run.state, cleanup_complete: true, evidence_state: "available", manifest_id: evidence.manifestId, manifest_sha256: evidence.manifestSha256, schema_version: evidence.schemaVersion } });
      }
      await delay(25);
    } while (Date.now() < deadline);
    const run = await this.ownedRun(caller, accepted.run_id);
    const operation = await this.ledger.getOperation(accepted.operation_id);
    return envelope({ run, operationId: accepted.operation_id, status: "timeout", warnings: [{ code: "END_FINALIZATION_PENDING", message: "Canonical finalization, zero-orphan cleanup, or durable evidence did not settle before the bounded end wait." }], retryability: "retryable", data: { replay: Boolean(accepted.data.replay), submission_outcome: accepted.data.submission_outcome, operation_state: operation?.state ?? "unknown", run_state: run.state, cleanup_complete: run.cleanupComplete, evidence_state: (await this.ledger.getEvidence(run.id)) ? "available" : "pending", wait_timeout_ms: boundedMs } });
  }

  private async assertInputPreconditions(caller: AuthenticatedCaller, runId: string, input: { expected_cursor?: number | undefined; expected_provider_epoch?: number | undefined; expected_turn_id?: string | undefined }): Promise<void> {
    const run = await this.ownedRun(caller, runId);
    if (input.expected_cursor !== undefined && input.expected_cursor !== run.latestCursor) throw new VoiceLabError(labError("EVENT_CURSOR_PRECONDITION_FAILED", "Expected event cursor does not match the durable run cursor.", "conflict", true, { expected: input.expected_cursor, observed: run.latestCursor }));
    if (input.expected_provider_epoch === undefined && input.expected_turn_id === undefined) return;
    if (input.expected_provider_epoch !== undefined) {
      const source = await this.ledger.findLatestEvent(run.id, ["provider.connection_epoch"]);
      const receipt = source?.payload.receipt as Record<string, unknown> | undefined;
      if (run.providerEpoch !== input.expected_provider_epoch || Number(receipt?.providerConnectionEpoch) !== input.expected_provider_epoch) throw new VoiceLabError(labError("PROVIDER_EPOCH_PRECONDITION_FAILED", "Expected provider epoch does not match the durable strict join and its latest owning receipt.", "conflict", true));
    }
    if (input.expected_turn_id !== undefined) {
      const source = await this.ledger.findLatestEvent(run.id, ["product.voice-sse.sophia.turn", "product.stream-custom.sophia.turn"]);
      const data = source?.payload.data as Record<string, unknown> | undefined;
      if (run.turnId !== input.expected_turn_id || data?.turnId !== input.expected_turn_id) throw new VoiceLabError(labError("TURN_PRECONDITION_FAILED", "Expected turn ID does not match the durable strict join and its latest owning receipt.", "conflict", true));
    }
  }

  private async assertAdaptiveObservation(run: RunRecord, input: z.infer<typeof SpeakSchema>): Promise<void> {
    const allInputs = (await this.ledger.listOperations(run.id))
      .filter((operation) => operation.type === "speak" || operation.type === "barge_in")
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    const priorInputs = allInputs
      .filter((operation) => (operation.type === "speak" || operation.type === "barge_in") && operation.state === "succeeded")
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    const ordinal = priorInputs.length + 1;
    if (run.scenarioId === "V-P01") {
      const otherSubmissions = allInputs.filter((operation) => operation.idempotencyKey !== input.idempotency_key);
      const submissionOrdinal = otherSubmissions.length + 1;
      if (submissionOrdinal === 1) {
        if (input.adaptive_observation !== undefined) throw new VoiceLabError(labError("ADAPTIVE_OBSERVATION_NOT_ALLOWED", "The first V-P01 utterance must not claim a prior assistant observation.", "validation", false));
        return;
      }
      if (submissionOrdinal > 2) throw new VoiceLabError(labError("P01_UTTERANCE_LIMIT", "V-P01 accepts exactly one initial utterance and one receipt-bound adaptive follow-up.", "validation", false));
      if (otherSubmissions[0]?.state !== "succeeded") throw new VoiceLabError(labError("ADAPTIVE_OBSERVATION_PREDECESSOR_PENDING", "The first V-P01 utterance must durably succeed before its receipt-bound follow-up is submitted.", "conflict", true));
      const adaptive = input.adaptive_observation;
      if (!adaptive || !("receipt" in adaptive) || input.expected_cursor === undefined || input.expected_provider_epoch === undefined || input.expected_turn_id === undefined) {
        throw new VoiceLabError(labError("ADAPTIVE_OBSERVATION_REQUIRED", "The V-P01 follow-up must carry one service-minted observation receipt and the current cursor, provider epoch, and turn preconditions.", "validation", false));
      }
      await this.assertP01ObservationReceipt(run, adaptive.receipt, input.expected_cursor, input.expected_provider_epoch, input.expected_turn_id, otherSubmissions);
      return;
    }
    if (run.scenarioId !== "V-A01") {
      if (input.adaptive_observation !== undefined) throw new VoiceLabError(labError("ADAPTIVE_OBSERVATION_NOT_ALLOWED", "Adaptive observation receipts are accepted only for V-A01 follow-up utterances.", "validation", false));
      return;
    }
    if (ordinal === 1) {
      if (input.adaptive_observation !== undefined) throw new VoiceLabError(labError("ADAPTIVE_OBSERVATION_NOT_ALLOWED", "The V-A01 neutral greeting must not claim a prior assistant observation.", "validation", false));
      return;
    }
    if (ordinal > 6) throw new VoiceLabError(labError("A01_UTTERANCE_LIMIT", "V-A01 accepts exactly one greeting and five adaptive follow-ups.", "validation", false));
    const observation = input.adaptive_observation;
    if (!observation || "receipt" in observation || input.expected_cursor === undefined || input.expected_turn_id === undefined) throw new VoiceLabError(labError("ADAPTIVE_OBSERVATION_REQUIRED", "V-A01 follow-ups must cite the current durable cursor and exact prior app-authored assistant turn.", "validation", false, { utterance_ordinal: ordinal }));
    if (observation.turn_id !== input.expected_turn_id || observation.event_seq > input.expected_cursor) throw new VoiceLabError(labError("ADAPTIVE_OBSERVATION_MISMATCH", "V-A01 follow-up observation fields do not agree with the caller's strict preconditions.", "conflict", true));
    const page = await this.ledger.listEvents(run.id, observation.event_seq - 1, 1);
    const cited = page.events.find((event) => event.seq === observation.event_seq);
    const data = cited?.payload.data as Record<string, unknown> | undefined;
    if (!cited || !isExactBoundProductEventForService(run, cited) || !cited.kind.endsWith(".sophia.turn") || data?.phase !== "agent_ended" || data.turnId !== observation.turn_id) {
      throw new VoiceLabError(labError("ADAPTIVE_OBSERVATION_MISMATCH", "V-A01 follow-up did not cite an exact app-authored completed assistant turn.", "conflict", false));
    }
    const allEvents: typeof page.events = [];
    let cursor = 0;
    for (;;) {
      const events = await this.ledger.listEvents(run.id, cursor, 500);
      allEvents.push(...events.events);
      if (events.events.length < 500) break;
      cursor = events.events.at(-1)!.seq;
      if (allEvents.length >= 10_000) throw new VoiceLabError(labError("ADAPTIVE_OBSERVATION_SCAN_LIMIT", "V-A01 observation proof exceeded the bounded event scan.", "conflict", true));
    }
    const completedTurns = allEvents.filter((event) => {
      const eventData = event.payload.data as Record<string, unknown> | undefined;
      return isExactBoundProductEventForService(run, event) && event.kind.endsWith(".sophia.turn") && eventData?.phase === "agent_ended" && typeof eventData.turnId === "string";
    });
    if (completedTurns.at(-1)?.seq !== cited.seq) throw new VoiceLabError(labError("ADAPTIVE_OBSERVATION_STALE", "V-A01 follow-up must cite the immediately preceding completed assistant turn.", "conflict", true));
    const used = new Set(priorInputs.map((operation) => (operation.input.adaptive_observation as Record<string, unknown> | undefined)?.event_seq).filter((value): value is number => Number.isSafeInteger(value)));
    if (used.has(observation.event_seq)) throw new VoiceLabError(labError("ADAPTIVE_OBSERVATION_REUSED", "Each V-A01 follow-up must derive from a distinct preceding assistant turn.", "conflict", false));
  }

  private mintP01ObservationReceipt(run: RunRecord, event: { seq: number; kind: string; source: string; at: Date; payload: Record<string, unknown> }): z.infer<typeof ObservationReceiptSchema> | null {
    const data = event.payload.data as Record<string, unknown> | undefined;
    if (!isExactBoundProductEventForService(run, event) || !event.kind.endsWith(".sophia.turn") || data?.phase !== "agent_ended" || typeof data.turnId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(data.turnId)) return null;
    const core = {
      schema: "sophia_voice_lab_observation_receipt_v1" as const,
      run_id: run.id,
      test_run_id: run.testRunId,
      scenario_id: "V-P01" as const,
      scenario_version: SCENARIO_CATALOG_VERSION,
      deployment_identity_sha256: canonicalRequestHash({ expected: run.target.expectedDeployment, observed: run.observedDeployment }),
      event_seq: event.seq,
      turn_id: data.turnId,
      observation_class: "assistant_turn_complete" as const,
      issued_at: event.at.toISOString(),
    };
    const secret = this.config.callerPartitionKeys.keys[this.config.callerPartitionKeys.activeKeyId]!;
    return { ...core, receipt_sha256: p01ObservationReceiptMac(secret, core) };
  }

  private async assertP01ObservationReceipt(
    run: RunRecord,
    receipt: z.infer<typeof ObservationReceiptSchema>,
    expectedCursor: number,
    expectedProviderEpoch: number,
    expectedTurnId: string,
    priorInputs: OperationRecord[],
  ): Promise<void> {
    if (run.providerEpoch !== expectedProviderEpoch || run.turnId !== expectedTurnId || receipt.run_id !== run.id || receipt.test_run_id !== run.testRunId
      || receipt.scenario_id !== "V-P01" || receipt.scenario_version !== run.scenarioVersion || receipt.turn_id !== expectedTurnId
      || receipt.event_seq > expectedCursor || receipt.deployment_identity_sha256 !== canonicalRequestHash({ expected: run.target.expectedDeployment, observed: run.observedDeployment })) {
      throw new VoiceLabError(labError("ADAPTIVE_OBSERVATION_MISMATCH", "The V-P01 observation receipt does not match the current run, deployment, cursor, provider epoch, and turn.", "conflict", true));
    }
    const validMac = Object.values(this.config.callerPartitionKeys.keys).some((secret) => p01ObservationReceiptMacMatches(secret, receipt));
    if (!validMac) throw new VoiceLabError(labError("ADAPTIVE_OBSERVATION_INTEGRITY_FAILED", "The V-P01 observation receipt failed service authentication.", "authorization", false));
    const page = await this.ledger.listEvents(run.id, receipt.event_seq - 1, 1);
    const cited = page.events.find((event) => event.seq === receipt.event_seq);
    const minted = cited ? this.mintP01ObservationReceipt(run, cited) : null;
    if (!minted || canonicalRequestHash(minted) !== canonicalRequestHash(receipt)) throw new VoiceLabError(labError("ADAPTIVE_OBSERVATION_MISMATCH", "The V-P01 observation receipt does not reproduce from the exact durable assistant turn.", "conflict", false));
    const used = priorInputs.some((operation) => {
      const adaptive = operation.input.adaptive_observation as Record<string, unknown> | undefined;
      const priorReceipt = adaptive?.receipt as Record<string, unknown> | undefined;
      return priorReceipt?.receipt_sha256 === receipt.receipt_sha256;
    });
    if (used) throw new VoiceLabError(labError("ADAPTIVE_OBSERVATION_REUSED", "The V-P01 observation receipt was already consumed by a successful follow-up.", "conflict", false));
  }

  private async ownedRun(caller: AuthenticatedCaller, runId: string): Promise<RunRecord> {
    const run = await this.ledger.getRun(runId);
    if (!run || (run.callerId !== caller.subject && run.callerId !== `sha256:${sha256(caller.subject)}`)) throw new VoiceLabError(labError("RUN_NOT_FOUND", "Run was not found.", "validation"));
    return run;
  }

  private validateTarget(target: TargetSpec): void {
    validateAllowedOrigin(target.frontendUrl, this.config.allowedOrigins);
    validateAllowedOrigin(target.gatewayUrl, this.config.allowedOrigins);
    validateAllowedOrigin(target.voiceUrl, this.config.allowedOrigins);
    validateAllowedOrigin(target.langgraphUrl, this.config.allowedOrigins);
  }

  private async assertProductAdmissionReady(target: TargetSpec): Promise<void> {
    // Unit-only ledgers may deliberately omit a deployed target. Production
    // config rejects that shape at startup, so this branch cannot become a
    // fail-open production admission path.
    if (this.config.readinessTarget === null && this.config.nodeEnv === "test") return;
    const proof = await this.targetIdentity();
    assertFreshProductAdmissionProof(this.config, target, proof);
  }

  private assertMutationEnabled(tool: string): void {
    if (this.config.killSwitch) throw new VoiceLabError(labError("KILL_SWITCH_ENGAGED", `${tool} is disabled by the Voice Lab kill switch.`, "authorization", true));
  }

  private validateRetentionPolicy(retentionHours: number): void {
    const minimum = Math.ceil((this.config.maxRunSeconds + this.config.endOperationSeconds) / 3_600);
    if (retentionHours < minimum) throw new VoiceLabError(labError("RETENTION_WINDOW_TOO_SHORT", `Retention must be at least ${minimum} hour(s) so the provisional session evidence cannot expire before bounded run finalization.`, "validation", false, { minimum_retention_hours: minimum }));
  }

  private rollingAdmissionLimits(): RollingAdmissionLimits {
    return {
      windowSeconds: this.config.admissionWindowSeconds,
      global: { runStarts: this.config.maxRollingRunStarts, providerSeconds: this.config.maxRollingProviderSeconds, suites: this.config.maxRollingSuites, suiteChildren: this.config.maxRollingSuiteChildren, audioDurationMs: this.config.maxRollingInjectedDurationMs, audioBytes: this.config.maxRollingInjectedBytes },
      caller: { runStarts: this.config.maxRollingRunStartsPerCaller, providerSeconds: this.config.maxRollingProviderSecondsPerCaller, suites: this.config.maxRollingSuitesPerCaller, suiteChildren: this.config.maxRollingSuiteChildrenPerCaller, audioDurationMs: this.config.maxRollingInjectedDurationMsPerCaller, audioBytes: this.config.maxRollingInjectedBytesPerCaller },
    };
  }

  private rollingAudioFence(run: RunRecord, callerId: string, type: "speak" | "barge_in", idempotencyKey: string, input: Record<string, unknown>, reservation: { duration_ms: number; bytes: number }): RollingAdmissionFence {
    return { reservation: {
      reservationKey: sha256(`audio\u0000${callerId}\u0000${run.id}\u0000${type}\u0000${idempotencyKey}`), requestHash: canonicalRequestHash(input), callerId, environment: run.environment, kind: "audio",
      runStarts: 0, providerSeconds: 0, suites: 0, suiteChildren: 0, audioDurationMs: reservation.duration_ms, audioBytes: reservation.bytes, observedAt: new Date(),
    }, limits: this.rollingAdmissionLimits() };
  }

  private publicLimits(): Record<string, number> {
    return { max_concurrent_runs: this.config.maxConcurrentRuns, max_runs_per_caller: this.config.maxRunsPerCaller, max_text_characters: this.config.maxTextCharacters, max_audio_bytes: this.config.maxAudioBytes, max_audio_duration_ms: this.config.maxAudioDurationMs, max_utterances_per_run: this.config.maxUtterancesPerRun, max_injected_duration_ms: this.config.maxInjectedDurationMs, max_injected_bytes: this.config.maxInjectedBytes, min_utterance_interval_ms: this.config.minUtteranceIntervalMs, max_run_seconds: this.config.maxRunSeconds, max_operation_seconds: this.config.maxOperationSeconds, start_operation_seconds: this.config.startOperationSeconds, end_operation_seconds: this.config.endOperationSeconds, fault_operation_seconds: this.config.faultOperationSeconds, max_wait_ms: this.config.maxWaitMs, effective_min_retention_hours: Math.ceil((this.config.maxRunSeconds + this.config.endOperationSeconds) / 3_600), rolling_window_seconds: this.config.admissionWindowSeconds, max_rolling_run_starts: this.config.maxRollingRunStarts, max_rolling_run_starts_per_caller: this.config.maxRollingRunStartsPerCaller, max_rolling_provider_seconds: this.config.maxRollingProviderSeconds, max_rolling_provider_seconds_per_caller: this.config.maxRollingProviderSecondsPerCaller, max_rolling_suites: this.config.maxRollingSuites, max_rolling_suites_per_caller: this.config.maxRollingSuitesPerCaller, max_rolling_suite_children: this.config.maxRollingSuiteChildren, max_rolling_suite_children_per_caller: this.config.maxRollingSuiteChildrenPerCaller, max_rolling_injected_duration_ms: this.config.maxRollingInjectedDurationMs, max_rolling_injected_duration_ms_per_caller: this.config.maxRollingInjectedDurationMsPerCaller, max_rolling_injected_bytes: this.config.maxRollingInjectedBytes, max_rolling_injected_bytes_per_caller: this.config.maxRollingInjectedBytesPerCaller };
  }
}

export function targetAdmissionBinding(target: TargetSpec): string {
  return canonicalRequestHash({
    frontend_origin: new URL(target.frontendUrl).origin,
    gateway_origin: new URL(target.gatewayUrl).origin,
    voice_origin: new URL(target.voiceUrl).origin,
    langgraph_origin: new URL(target.langgraphUrl).origin,
    expected_deployment: {
      frontend: target.expectedDeployment.frontend.toLowerCase(),
      backend: target.expectedDeployment.backend.toLowerCase(),
      voice: target.expectedDeployment.voice.toLowerCase(),
    },
    expected_dependencies: {
      langgraph: target.expectedDependencies.langgraph.toLowerCase(),
    },
  });
}

/** Validates a fresh, direct product admission probe. This check is used once
 * before the API reserves rolling spend and again by the worker immediately
 * before it acquires a browser/auth/provider resource. */
export function assertFreshProductAdmissionProof(config: VoiceLabConfig, target: TargetSpec, proof: Record<string, unknown> & { ok: boolean }, now = Date.now()): void {
  const configured = config.readinessTarget;
  const sameTarget = configured !== null && targetAdmissionBinding(configured) === targetAdmissionBinding(target);
  const observedAt = typeof proof.observed_at === "string" ? new Date(proof.observed_at).getTime() : Number.NaN;
  const fresh = Number.isFinite(observedAt) && observedAt <= now + 2_000 && observedAt >= now - 15_000;
  const probeId = typeof proof.probe_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(proof.probe_id);
  const productMutationGatesOpen = proof.product_mutation_gates_open === true;
  const builds = proof.builds && typeof proof.builds === "object" ? proof.builds as Record<string, unknown> : {};
  const expectedComponents = [
    ["frontend", target.expectedDeployment.frontend],
    ["backend", target.expectedDeployment.backend],
    ["voice", target.expectedDeployment.voice],
    ["langgraph", target.expectedDependencies.langgraph],
  ] as const;
  const components = expectedComponents.every(([component, expectedValue]) => {
    const entry = builds[component] && typeof builds[component] === "object" ? builds[component] as Record<string, unknown> : {};
    const expected = expectedValue.toLowerCase();
    return entry.ready === true && entry.config_status === "ready" && typeof entry.expected === "string" && entry.expected.toLowerCase() === expected
      && typeof entry.observed === "string" && entry.observed.toLowerCase() === expected;
  });
  if (!sameTarget || proof.ok !== true || proof.status !== "verified" || proof.environment !== config.environment
    || proof.target_binding_sha256 !== targetAdmissionBinding(target) || !fresh || !probeId || !components || !productMutationGatesOpen) {
    throw new VoiceLabError(labError("PRODUCT_ADMISSION_NOT_READY", "The exact deployed Voice Lab target did not provide a fresh all-component admission-ready proof.", "deployment", true, {
      configured_target_match: sameTarget,
      probe_status: typeof proof.status === "string" ? proof.status : "malformed",
      fresh,
      component_readiness: components,
      product_mutation_gates_open: productMutationGatesOpen,
    }));
  }
}

function mapTarget(target: z.infer<typeof TargetSchema>): TargetSpec {
  return {
    frontendUrl: target.frontend_url,
    gatewayUrl: target.gateway_url,
    voiceUrl: target.voice_url,
    langgraphUrl: target.langgraph_url,
    expectedDeployment: target.expected_deployment,
    expectedDependencies: target.expected_dependencies,
  };
}

function assertD02LocalFreezeIntentSnapshot(
  snapshot: EventClaimSnapshot,
  evidence: Extract<z.infer<typeof ExternalAttestationEvidenceSchema>, { kind: "d02_browser_worker_termination_command" }>,
  expectedServiceVersion: string,
): void {
  const { run, events, operations, browserLease, databaseNow } = snapshot;
  const requestedAt = new Date(evidence.requested_at);
  const completeLedger = events.length === run.latestCursor && events.every((event, index) => event.seq === index + 1);
  const liveOperation = operations.some((operation) => ["accepted", "queued", "leased", "executing"].includes(operation.state));
  const priorFenceOrTerminalSource = events.some((event) => event.kind === "product.d02_browser_worker_termination_freeze_pending"
    || event.kind === "product.d02_gateway_browser_worker_termination_frozen"
    || event.kind === "product.d02_render_worker_dispatch_claimed"
    || event.kind === "durability.browser_worker_shutdown_observed"
    || event.kind === "durability.browser_worker_replacement_observed"
    || event.kind === "durability.browser_worker_loss_observed");
  const contextEvents = events.filter((event) => event.kind === "harness.browser_context_bound");
  const runtimeEvents = events.filter((event) => event.kind === "harness.browser_runtime_acquired");
  const contextEvent = contextEvents[0];
  const runtimeEvent = runtimeEvents[0];
  const context = contextEvent?.payload;
  const runtime = runtimeEvent?.payload;
  const exactContextKeys = context !== undefined && exactRecordKeys(context, [
    "schema", "test_run_id_sha256", "cleanup_obligation_id_sha256", "voice_lab_run_id_sha256",
    "browser_worker_id_sha256", "browser_lease_epoch", "browser_context_id_sha256", "context_allocation",
    "driver_attested", "raw_run_worker_and_context_identifiers_excluded",
  ]);
  const exactRuntimeKeys = runtime !== undefined && exactRecordKeys(runtime, [
    "worker_id_sha256", "browser_lease_epoch", "browser_context_id_sha256", "operation_id", "engine", "version",
    "service_version", "acquired_at", "raw_worker_identifier_excluded",
  ]);
  const runtimeOperation = operations.find((operation) => operation.id === runtime?.operation_id);
  const exactContext = contextEvents.length === 1 && contextEvent?.source === "canonical" && exactContextKeys
    && context.schema === "sophia_voice_lab_browser_context_binding_v1"
    && context.test_run_id_sha256 === sha256(run.testRunId)
    && context.cleanup_obligation_id_sha256 === sha256(run.cleanupObligationId)
    && context.voice_lab_run_id_sha256 === sha256(run.id)
    && context.browser_worker_id_sha256 === evidence.browser_worker_id_sha256
    && context.browser_lease_epoch === evidence.browser_lease_epoch
    && context.browser_context_id_sha256 === evidence.browser_context_id_sha256
    && context.context_allocation === "deterministic_run_worker_lease_v1"
    && context.driver_attested === true
    && context.raw_run_worker_and_context_identifiers_excluded === true;
  const exactRuntime = runtimeEvents.length === 1 && runtimeEvent?.source === "canonical" && exactRuntimeKeys
    && runtime.worker_id_sha256 === evidence.browser_worker_id_sha256
    && runtime.browser_lease_epoch === evidence.browser_lease_epoch
    && runtime.browser_context_id_sha256 === evidence.browser_context_id_sha256
    && typeof runtime.engine === "string" && runtime.engine.length > 0
    && typeof runtime.version === "string" && runtime.version.length > 0
    && runtime.service_version === expectedServiceVersion
    && runtime.raw_worker_identifier_excluded === true
    && typeof runtime.acquired_at === "string" && ExternalTimestampSchema.safeParse(runtime.acquired_at).success
    && runtimeOperation?.runId === run.id && runtimeOperation.type === "start" && runtimeOperation.state === "succeeded";
  const exactBindingOrder = contextEvent !== undefined && runtimeEvent !== undefined
    && contextEvent.seq < runtimeEvent.seq && runtimeEvent.at <= requestedAt
    && new Date(String(runtime?.acquired_at)).getTime() <= requestedAt.getTime();
  const frozenEpochs = evidence.frozen_provider_connection_epochs;
  const canonicalEpochs = frozenEpochs.every((epoch, index) => index === 0 || frozenEpochs[index - 1]! < epoch);
  if (!completeLedger || liveOperation || priorFenceOrTerminalSource || !exactContext || !exactRuntime || !exactBindingOrder
    || run.scenarioId !== "V-D02" || TERMINAL_RUN_STATES.has(run.state)
    || run.cleanupComplete || run.evidencePurgedAt !== null || run.expiresAt <= databaseNow || run.providerSessionId === null || run.providerEpoch === null
    || evidence.run_id_sha256 !== sha256(run.id) || evidence.cleanup_obligation_id_sha256 !== sha256(run.cleanupObligationId)
    || evidence.provider_session_id_sha256 !== sha256(run.providerSessionId) || evidence.provider_connection_epoch !== run.providerEpoch
    || !canonicalEpochs || !frozenEpochs.includes(run.providerEpoch) || !browserLease || browserLease.expiresAt <= databaseNow
    || sha256(browserLease.workerId) !== evidence.browser_worker_id_sha256 || browserLease.leaseEpoch !== evidence.browser_lease_epoch
    || requestedAt < new Date(databaseNow.getTime() - 900_000) || requestedAt > new Date(databaseNow.getTime() + 30_000)) {
    throw attestationMismatch("D02 local freeze intent could not atomically fence a live operation-free run, provider, and exact browser owner.");
  }
}

function assertD02RenderWorkerDispatchSnapshot(snapshot: EventClaimSnapshot, input: D02RenderWorkerDispatchClaimRequest): void {
  const { run, events, operations, browserLease, databaseNow } = snapshot;
  const requestedAt = new Date(input.requested_at);
  const terminationRequestIdSha256 = sha256(input.termination_request_id);
  const completeLedger = events.length === run.latestCursor && events.every((event, index) => event.seq === index + 1);
  const intentEvents = events.filter((event) => event.kind === "product.d02_browser_worker_termination_freeze_pending");
  const commandEvents = events.filter((event) => event.kind === "external.attestation.d02_browser_worker_termination_command");
  const freezeEvents = events.filter((event) => event.kind === "product.d02_gateway_browser_worker_termination_frozen");
  const priorDispatchOrTerminalSource = events.some((event) => event.kind === "product.d02_render_worker_dispatch_claimed"
    || event.kind === "durability.browser_worker_shutdown_observed"
    || event.kind === "durability.browser_worker_replacement_observed"
    || event.kind === "durability.browser_worker_loss_observed");
  const liveOperation = operations.some((operation) => ["accepted", "queued", "leased", "executing"].includes(operation.state));
  const intentEvent = intentEvents[0];
  const commandEvent = commandEvents[0];
  const freezeEvent = freezeEvents[0];
  const parsedIntent = D02LocalFreezeIntentEventSchema.safeParse(intentEvent?.payload);
  const parsedCommand = ExternalAttestationEvidenceSchema.safeParse(commandEvent?.payload.evidence);
  const parsedFreeze = D02GatewayFreezeEventSchema.safeParse(freezeEvent?.payload);
  if (!completeLedger || run.scenarioId !== "V-D02" || TERMINAL_RUN_STATES.has(run.state) || run.cleanupComplete
    || run.evidencePurgedAt !== null || run.expiresAt <= databaseNow || intentEvents.length !== 1 || commandEvents.length !== 1 || freezeEvents.length !== 1
    || !intentEvent || intentEvent.source !== "canonical" || !commandEvent || commandEvent.source !== "canonical" || !freezeEvent || freezeEvent.source !== "canonical"
    || !parsedIntent.success || !parsedCommand.success || parsedCommand.data.kind !== "d02_browser_worker_termination_command" || !parsedFreeze.success
    || priorDispatchOrTerminalSource || liveOperation || !browserLease || browserLease.expiresAt <= databaseNow) {
    throw attestationMismatch("D02 Render dispatch did not atomically retain one live run, browser lease, source-validated command, and durable Gateway freeze.");
  }
  const command = parsedCommand.data;
  const intent = parsedIntent.data;
  const freeze = parsedFreeze.data;
  const commandPayloadCore = { ...commandEvent.payload };
  delete commandPayloadCore.content_sha256;
  const sortedEpochs = command.frozen_provider_connection_epochs.every((epoch, index) => index === 0 || command.frozen_provider_connection_epochs[index - 1]! < epoch);
  if (commandEvent.seq !== input.command_event_seq || commandEvent.payload.schema !== "sophia_voice_lab_external_attestation_v1"
    || commandEvent.payload.binding_validated !== true || commandEvent.payload.raw_identifiers_excluded !== true
    || commandEvent.payload.attestation_id !== input.command_attestation_id || commandEvent.payload.content_sha256 !== input.command_content_sha256
    || commandEvent.payload.content_sha256 !== canonicalRequestHash(commandPayloadCore)
    || commandEvent.payload.scenario_id !== "V-D02" || commandEvent.payload.scenario_version !== run.scenarioVersion
    || commandEvent.payload.environment !== run.environment || commandEvent.payload.test_run_id_sha256 !== sha256(run.testRunId)
    || commandEvent.payload.cleanup_obligation_id_sha256 !== sha256(run.cleanupObligationId)
    || canonicalRequestHash(commandEvent.payload.expected_deployment) !== canonicalRequestHash(run.target.expectedDeployment)
    || command.authority !== "deployment_control" || command.termination_request_id !== input.termination_request_id
    || command.run_id_sha256 !== sha256(run.id) || command.cleanup_obligation_id_sha256 !== sha256(run.cleanupObligationId)
    || run.providerSessionId === null || run.providerEpoch === null || command.provider_session_id_sha256 !== sha256(run.providerSessionId)
    || command.provider_connection_epoch !== run.providerEpoch || !sortedEpochs || !command.frozen_provider_connection_epochs.includes(run.providerEpoch)
    || command.worker_service_id_sha256 !== input.worker_service_id_sha256 || command.render_action_request_sha256 !== input.action_request_sha256
    || command.target_service !== "sophia-voice-lab-worker" || command.termination_mode !== "render_service_restart_one_shot"
    || command.worker_mutation_authorized !== true || command.product_mutation_authorized !== false || command.one_shot !== true
    || sha256(browserLease.workerId) !== command.browser_worker_id_sha256 || browserLease.leaseEpoch !== command.browser_lease_epoch
    || requestedAt < commandEvent.at || requestedAt < new Date(databaseNow.getTime() - 60_000) || requestedAt > new Date(databaseNow.getTime() + 30_000)) {
    throw attestationMismatch("D02 Render dispatch did not bind the exact current run, provider, command, action, and live browser owner.");
  }
  const expectedFreezeRequest = {
    schema: "sophia_voice_lab_gateway_browser_worker_termination_freeze_request_v1" as const,
    termination_request_id: command.termination_request_id,
    voice_lab_run_id_sha256: command.run_id_sha256,
    test_run_id: run.testRunId,
    cleanup_obligation_id: run.cleanupObligationId,
    provider_session_id: run.providerSessionId,
    provider_admission_id_sha256: command.provider_admission_id_sha256,
    provider_connection_epoch: command.provider_connection_epoch,
    frozen_provider_connection_epochs: command.frozen_provider_connection_epochs,
    browser_worker_id_sha256: command.browser_worker_id_sha256,
    browser_lease_epoch: command.browser_lease_epoch,
    browser_context_id_sha256: command.browser_context_id_sha256,
    render_action_request_sha256: command.render_action_request_sha256,
    requested_at: command.requested_at,
  };
  const expectedIntent = D02LocalFreezeIntentEventSchema.parse({
    schema: "sophia_voice_lab_d02_local_browser_worker_freeze_intent_v1",
    termination_request_id_sha256: terminationRequestIdSha256,
    command_evidence_sha256: canonicalRequestHash(command),
    voice_lab_run_id_sha256: command.run_id_sha256,
    cleanup_obligation_id_sha256: command.cleanup_obligation_id_sha256,
    provider_session_id_sha256: command.provider_session_id_sha256,
    provider_admission_id_sha256: command.provider_admission_id_sha256,
    provider_connection_epoch: command.provider_connection_epoch,
    frozen_provider_connection_epochs: command.frozen_provider_connection_epochs,
    browser_worker_id_sha256: command.browser_worker_id_sha256,
    browser_lease_epoch: command.browser_lease_epoch,
    browser_context_id_sha256: command.browser_context_id_sha256,
    render_action_request_sha256: command.render_action_request_sha256,
    requested_at: command.requested_at,
    raw_run_operation_provider_and_browser_identifiers_excluded: true,
  });
  const expectedFreeze = D02GatewayFreezeEventSchema.parse({
    schema: "sophia_voice_lab_d02_gateway_freeze_event_v1",
    termination_request_id_sha256: terminationRequestIdSha256,
    freeze_request_sha256: canonicalRequestHash(expectedFreezeRequest),
    voice_lab_run_id_sha256: command.run_id_sha256,
    cleanup_obligation_id_sha256: command.cleanup_obligation_id_sha256,
    provider_session_id_sha256: command.provider_session_id_sha256,
    provider_admission_id_sha256: command.provider_admission_id_sha256,
    provider_connection_epoch: command.provider_connection_epoch,
    frozen_provider_connection_epochs: command.frozen_provider_connection_epochs,
    browser_worker_id_sha256: command.browser_worker_id_sha256,
    browser_lease_epoch: command.browser_lease_epoch,
    browser_context_id_sha256: command.browser_context_id_sha256,
    render_action_request_sha256: command.render_action_request_sha256,
    gateway_frozen: true,
    raw_product_identifiers_excluded: true,
  });
  if (intentEvent.seq >= freezeEvent.seq || freezeEvent.seq >= commandEvent.seq
    || canonicalRequestHash(intent) !== canonicalRequestHash(expectedIntent)
    || canonicalRequestHash(freeze) !== canonicalRequestHash(expectedFreeze)) {
    throw attestationMismatch("D02 Render dispatch did not join the exact immutable Gateway freeze projection and request digest.");
  }
}

function exactRecordKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

async function readCompleteEventLedger(ledger: VoiceLabLedger, runId: string): Promise<import("./domain.js").LabEvent[]> {
  const events: import("./domain.js").LabEvent[] = [];
  let after = 0;
  while (true) {
    const page = await ledger.listEvents(runId, after, 500);
    for (const event of page.events) {
      if (event.seq !== after + 1) throw new VoiceLabError(labError("EVENT_SEQUENCE_GAP", "External attestation could not be joined across a gap in the durable event ledger.", "evidence"));
      events.push(event);
      after = event.seq;
      if (events.length > 100_000) throw new VoiceLabError(labError("ATTESTATION_LEDGER_BOUND", "External attestation cross-join exceeded the bounded event-ledger limit.", "evidence"));
    }
    if (page.events.length === 0 || after >= page.latest) break;
  }
  return events;
}

function orderedTimestamps(...values: string[]): boolean {
  const times = values.map((value) => new Date(value).getTime());
  return times.every(Number.isFinite) && times.every((value, index) => index === 0 || times[index - 1]! <= value);
}

function attestationMismatch(message: string): VoiceLabError {
  return new VoiceLabError(labError("ATTESTATION_CROSS_JOIN_FAILED", message, "evidence"));
}

function assertScenarioSupported(id: string | undefined): void {
  if (!id) return;
  const scenario = SCENARIO_CATALOG.find((candidate) => candidate.id === id)!;
  if (scenario.support === "typed_unsupported") throw new VoiceLabError(labError("SCENARIO_OWNING_PRIMITIVE_UNAVAILABLE", `Scenario ${id} is not executable on this target because its owning product primitive is unavailable.`, "validation", false, { scenario_id: id, scenario_version: SCENARIO_CATALOG_VERSION, unavailable_reason: scenario.unavailableReason }));
}

function isExactBoundProductEventForService(run: RunRecord, event: { source: string; payload: Record<string, unknown> }): boolean {
  const binding = event.payload._product_run_binding as Record<string, unknown> | undefined;
  return event.source === "product" && binding?.app_authenticated === true && binding.synthetic === true
    && binding.test_run_id_sha256 === sha256(run.testRunId) && binding.principal_id_sha256 === sha256(run.principalId)
    && binding.environment === run.environment && binding.scenario_id === run.scenarioId && binding.scenario_version === run.scenarioVersion
    && binding.retention_hours === run.capturePolicy.retentionHours
    && binding.provider_expires_at === run.expiresAt.toISOString()
    && binding.cleanup_obligation_id_sha256 === sha256(run.cleanupObligationId);
}

function publicEvent(event: { seq: number; kind: string; source: string; at: Date; payload: Record<string, unknown> }, runId: string, testRunId: string): Record<string, unknown> {
  return { seq: event.seq, kind: event.kind, source: event.source, observed_at: event.at.toISOString(), payload: projectSyntheticEventPayload(event.kind, event.payload, runId, testRunId) };
}

export function eventMatches(event: { kind: string; payload: Record<string, unknown> }, condition: z.infer<typeof WaitSchema>["condition"], operationId?: string): boolean {
  const { kind, payload } = event;
  const phase = nestedValue(payload, ["phase"]);
  const turnComplete = nestedValue(payload, ["turnComplete", "turn_complete"]);
  const entry = nestedValue(payload, ["entry"]);
  const toolEntry = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
  if (condition === "any_event") return true;
  if (condition === "input_transcription") return kind === "transcript.input.final" || kind.endsWith(".sophia.user_transcript");
  if (condition === "assistant_first_audio") return kind === "audio.output.started";
  if (condition === "assistant_turn_complete") return kind === "turn.assistant.completed" || (kind.endsWith(".sophia.turn") && phase === "agent_ended") || turnComplete === true;
  if (condition === "tool_call") return kind === "tool.call" || (kind.includes("gemini-tool-call-ledger") && typeof toolEntry.toolCallId === "string");
  if (condition === "tool_settlement") return kind === "tool.settled" || (kind.includes("gemini-tool-call-ledger") && isTerminalToolLedgerEntry(toolEntry));
  if (condition === "task_state") return kind === "builder.task_state" || kind.endsWith(".sophia.builder_task");
  if (condition === "ui_projection") return kind === "ui.projection" || kind.includes("artifact");
  if (condition === "session_lifecycle_state") return kind.startsWith("session.") || kind.startsWith("run.");
  return (kind === "operation.succeeded" || kind === "operation.failed") && event.payload.operation_id === operationId;
}

function isTerminalToolLedgerEntry(entry: Record<string, unknown>): boolean {
  const state = entry.finalState;
  return typeof state === "string" && ["responded", "cancelled-before-send", "cancelled-after-send", "suppressed", "rejected"].includes(state)
    && (typeof entry.toolResponseSentAt === "string" || typeof entry.cancelledAt === "string");
}

function projectSyntheticEventPayload(kind: string, payload: Record<string, unknown>, runId: string, testRunId: string): unknown {
  const semanticKind = kind === "transcript.input.final" || kind === "transcript.assistant.final" || kind.endsWith(".sophia.user_transcript") || kind.endsWith(".sophia.transcript");
  if (!semanticKind) return projectPublicData(payload);
  const runnerBinding = payload._runner_binding && typeof payload._runner_binding === "object" ? payload._runner_binding as Record<string, unknown> : {};
  const productBinding = payload._product_run_binding && typeof payload._product_run_binding === "object" ? payload._product_run_binding as Record<string, unknown> : {};
  if (runnerBinding.run_id !== runId || runnerBinding.test_run_id_sha256 !== sha256(testRunId) || productBinding.app_authenticated !== true || productBinding.synthetic !== true || productBinding.test_run_id_sha256 !== sha256(testRunId)) return projectPublicData(payload);
  assertSyntheticPayloadSecretFree(payload);
  const project = (value: unknown, key = "root", depth = 0): unknown => {
    if (depth > 10) return "[DEPTH_LIMIT]";
    if (typeof value === "string" && /^(text|transcript)$/i.test(key)) return value.length <= 500 ? value : { synthetic_preview: value.slice(0, 500), character_length: [...value].length, truncated: true };
    if (typeof value === "string") return projectPublicData(value, key, depth);
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => project(item, key, depth + 1));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 200).map(([childKey, child]) => [childKey, project(child, childKey, depth + 1)]));
  };
  return project(payload);
}

function assertSyntheticPayloadSecretFree(payload: Record<string, unknown>): void {
  const serialized = JSON.stringify(payload);
  if (/(authorization|cookie|token|secret|password|api[_-]?key|resumption[_-]?handle|continuation[_-]?handle)/i.test(serialized)) throw new VoiceLabError(labError("SECRET_IN_LIVE_PROJECTION", "Synthetic semantic event contained forbidden secret-like material.", "evidence"));
}

function nestedValue(value: unknown, keys: readonly string[], depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 8) return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) if (keys.includes(key)) return child;
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = nestedValue(child, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function envelope(input: {
  run?: RunRecord;
  suite?: SuiteRecord;
  operationId?: string;
  after?: number;
  status: LabEnvelope["status"];
  warnings?: { code: string; message: string }[];
  error?: LabError;
  retryability?: LabEnvelope["retryability"];
  evidence?: LabEnvelope["evidence_references"];
  data: Record<string, unknown>;
}): LabEnvelope {
  const run = input.run;
  const evidence = input.evidence ?? [];
  const expected = run?.target.expectedDeployment ?? {};
  const observed = run?.observedDeployment ?? {};
  return {
    contract_version: CONTRACT_VERSION,
    request_id: randomUUID(),
    test_run_id: run?.testRunId ?? null,
    run_id: run?.id ?? null,
    operation_id: input.operationId ?? null,
    suite_run_id: input.suite?.id ?? null,
    status: input.status,
    event_cursor: run?.latestCursor ?? null,
    deployment_identity: { expected, observed },
    session_id: run?.canonicalSessionId ?? null,
    thread_id: run?.threadId ?? null,
    provider_session_id: run?.providerSessionId ?? null,
    trace_id: run?.traceId ?? null,
    provider_connection_epoch: run?.providerEpoch ?? null,
    turn_id: run?.turnId ?? null,
    evidence_references: evidence,
    retryability: input.retryability ?? (input.error?.retryable ? "retryable" : "not_retryable"),
    error_class: input.error?.code ?? null,
    observed_at: new Date().toISOString(),
    cursor: { after: input.after ?? null, latest: run?.latestCursor ?? null },
    deployment: { expected, observed },
    joins: {
      test_run_id: run?.testRunId ?? null,
      canonical_session_id: run?.canonicalSessionId ?? null,
      thread_id: run?.threadId ?? null,
      provider_session_id: run?.providerSessionId ?? null,
      trace_id: run?.traceId ?? null,
      provider_connection_epoch: run?.providerEpoch ?? null,
      turn_id: run?.turnId ?? null,
      availability: {
        canonical_session: run?.canonicalSessionId ? "available" : run && TERMINAL_RUN_STATES.has(run.state) ? "owning_contract_unavailable" : "not_yet_observed",
        thread: run?.threadId ? "available" : run && TERMINAL_RUN_STATES.has(run.state) ? "owning_contract_unavailable" : "not_yet_observed",
        provider_session: run?.providerSessionId ? "available" : run && TERMINAL_RUN_STATES.has(run.state) ? "owning_contract_unavailable" : "not_yet_observed",
        trace: run?.traceId ? "available" : "trace_unavailable",
        provider_epoch: run?.providerEpoch !== null && run?.providerEpoch !== undefined ? "available" : run && TERMINAL_RUN_STATES.has(run.state) ? "owning_contract_unavailable" : "not_yet_observed",
        turn: run?.turnId ? "available" : run && TERMINAL_RUN_STATES.has(run.state) ? "owning_contract_unavailable" : "not_yet_observed",
      },
    },
    verdicts: run?.verdicts ?? null,
    warnings: input.warnings ?? [],
    error: input.error ?? null,
    data: input.data,
  };
}

export function errorEnvelope(error: unknown, run?: RunRecord): LabEnvelope {
  const detail = error instanceof VoiceLabError
    ? error.detail
    : error instanceof z.ZodError
      ? labError("INVALID_ARGUMENTS", "Tool arguments did not match the strict contract.", "validation", false, { issues: error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })) })
      : labError("INTERNAL_ERROR", "Voice Lab encountered an unexpected internal error.", "internal");
  return envelope({ ...(run === undefined ? {} : { run }), status: "failed", error: detail, retryability: detail.retryable ? "retryable" : "not_retryable", data: {} });
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
