import { createPublicKey } from "node:crypto";

import { z } from "zod";

import { FINAL_CODEX_PLUGIN_VERSION_PATTERN } from "../../src/config.js";
import { canonicalRequestHash, sha256 } from "../../src/security.js";
import { D02BrowserContinuityProofSchema, D02BrowserWorkerLossObservationSchema, ExternalAttestationSchema, toolInputSchemas } from "../../src/service.js";

export { D02BrowserContinuityProofSchema, D02BrowserWorkerLossObservationSchema };
export type D02BrowserContinuityProof = z.infer<typeof D02BrowserContinuityProofSchema>;
export type D02BrowserWorkerLossObservation = z.infer<typeof D02BrowserWorkerLossObservationSchema>;

export const AUTHORITY_NAMES = ["external_mcp_client", "deployment_control", "platform_plugin"] as const;
export type AuthorityName = (typeof AUTHORITY_NAMES)[number];

export const AUTHORITY_DEFAULTS: Readonly<Record<AuthorityName, { issuer: string; subject: string }>> = Object.freeze({
  external_mcp_client: {
    issuer: "sophia-voice-lab-external-client-controller",
    subject: "voice-lab-attester.external-client",
  },
  deployment_control: {
    issuer: "sophia-voice-lab-deployment-controller",
    subject: "voice-lab-attester.deployment-control",
  },
  platform_plugin: {
    issuer: "sophia-platform-plugin-controller",
    subject: "voice-lab-attester.platform-plugin",
  },
});

const IdentifierSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const UuidV4Schema = z.string().uuid().refine((value) => value[14]?.toLowerCase() === "4", "UUID must be version 4");
const TimestampSchema = z.string().datetime({ offset: true });
const DeploymentSchema = z.object({
  frontend: z.string().regex(/^[a-f0-9]{40}$/),
  backend: z.string().regex(/^[a-f0-9]{40}$/),
  voice: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();

export const AuthorityPublicConfigSchema = z.object({
  issuer: IdentifierSchema,
  subject: IdentifierSchema,
  key_id: IdentifierSchema,
  public_key_spki_base64: z.string().min(40).max(512),
}).strict().superRefine((value, context) => {
  try {
    const bytes = Buffer.from(value.public_key_spki_base64, "base64");
    if (bytes.toString("base64") !== value.public_key_spki_base64) throw new Error("non-canonical base64");
    if (createPublicKey({ key: bytes, format: "der", type: "spki" }).asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
  } catch {
    context.addIssue({ code: "custom", path: ["public_key_spki_base64"], message: "Public key must be canonical Ed25519 SPKI base64." });
  }
});

export const PublicAuthorityConfigSchema = z.object({
  external_mcp_client: AuthorityPublicConfigSchema,
  deployment_control: AuthorityPublicConfigSchema,
  platform_plugin: AuthorityPublicConfigSchema,
}).strict().superRefine((value, context) => {
  const entries = Object.entries(value) as Array<[AuthorityName, z.infer<typeof AuthorityPublicConfigSchema>]>;
  if (new Set(entries.map(([, entry]) => entry.issuer)).size !== entries.length) context.addIssue({ code: "custom", message: "Every authority must have a distinct issuer." });
  if (new Set(entries.map(([, entry]) => entry.subject)).size !== entries.length) context.addIssue({ code: "custom", message: "Every authority must have a distinct subject." });
  if (new Set(entries.map(([, entry]) => entry.key_id)).size !== entries.length) context.addIssue({ code: "custom", message: "Every authority must have a distinct key ID." });
  if (new Set(entries.map(([, entry]) => sha256(Buffer.from(entry.public_key_spki_base64, "base64")))).size !== entries.length) context.addIssue({ code: "custom", message: "Every authority must have a distinct Ed25519 key." });
  for (const [authority, entry] of entries) {
    const expected = AUTHORITY_DEFAULTS[authority];
    if (entry.issuer !== expected.issuer || entry.subject !== expected.subject) context.addIssue({ code: "custom", path: [authority], message: "Issuer and transport subject must match the frozen source authority." });
  }
});

export const TransportTokensSchema = z.object({
  external_mcp_client: z.string().min(32).max(512),
  deployment_control: z.string().min(32).max(512),
  platform_plugin: z.string().min(32).max(512),
}).strict().superRefine((value, context) => {
  if (new Set(Object.values(value)).size !== AUTHORITY_NAMES.length) context.addIssue({ code: "custom", message: "Every authority must have a distinct transport token." });
});

export const BearerSecretFileSchema = z.object({ bearer_token: z.string().min(32).max(4096) }).strict();

export const RunBindingSchema = z.object({
  run_id: UuidV4Schema,
  test_run_id_sha256: Sha256Schema,
  cleanup_obligation_id_sha256: Sha256Schema,
  scenario_id: z.enum(["V-A03", "V-D02", "V-P01"]),
  scenario_version: z.literal("vt00.scenarios.v1"),
  environment: z.enum(["production", "staging"]),
  expected_deployment: DeploymentSchema,
}).strict();

export const UnsignedExternalAttestationSchema = ExternalAttestationSchema.omit({ signature: true });
export type UnsignedExternalAttestation = z.infer<typeof UnsignedExternalAttestationSchema>;
export type SignedExternalAttestation = z.infer<typeof ExternalAttestationSchema>;

const KIND_BINDING: Readonly<Record<SignedExternalAttestation["evidence"]["kind"], { authority: AuthorityName; scenario: "V-A03" | "V-D02" | "V-P01" }>> = Object.freeze({
  a03_http_response_loss: { authority: "external_mcp_client", scenario: "V-A03" },
  d02_restart_command: { authority: "deployment_control", scenario: "V-D02" },
  d02_browser_worker_termination_command: { authority: "deployment_control", scenario: "V-D02" },
  d02_api_process_restart: { authority: "deployment_control", scenario: "V-D02" },
  d02_browser_worker_loss: { authority: "deployment_control", scenario: "V-D02" },
  p01_platform_plugin_task: { authority: "platform_plugin", scenario: "V-P01" },
});

const FORBIDDEN_CONTENT_KEYS = /^(?:authorization|cookie|token|secret|password|private_key|request_body|response_body|request_content|response_content|prompt|message|transcript|source_text|raw_request|raw_response)$/i;

export function assertContentFreeClaim(value: unknown, path: readonly string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertContentFreeClaim(entry, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CONTENT_KEYS.test(key)) throw new Error(`Content-bearing or secret field is forbidden at ${[...path, key].join(".")}.`);
    assertContentFreeClaim(child, [...path, key]);
  }
}

export function parseUnsignedClaim(
  raw: unknown,
  publicConfig: z.infer<typeof PublicAuthorityConfigSchema>,
  now = new Date(),
): UnsignedExternalAttestation {
  assertContentFreeClaim(raw);
  const input = UnsignedExternalAttestationSchema.parse(raw);
  const binding = KIND_BINDING[input.evidence.kind];
  const authority = publicConfig[binding.authority];
  if (input.evidence.authority !== binding.authority || input.scenario_id !== binding.scenario) throw new Error("Attestation kind, source authority, and scenario are not exactly bound.");
  if (input.issuer !== authority.issuer || input.authority_key_id !== authority.key_id) throw new Error("Attestation issuer or key ID does not match the selected source authority.");
  if (input.audience !== "sophia-voice-lab-attestation" || input.signature_algorithm !== "ed25519-sha256-canonical-request-v1") throw new Error("Attestation audience or signature algorithm is invalid.");
  if (input.attestation_id !== input.jti) throw new Error("Attestation ID and JTI must be identical.");
  const issuedAt = new Date(input.issued_at);
  const expiresAt = new Date(input.expires_at);
  if (issuedAt.getTime() > now.getTime() + 30_000 || expiresAt.getTime() <= now.getTime() || expiresAt.getTime() <= issuedAt.getTime() || expiresAt.getTime() - issuedAt.getTime() > 900_000) throw new Error("Attestation issued/expiry times are outside the strict 15-minute boundary.");
  return input;
}

export function parseSignedClaim(
  raw: unknown,
  publicConfig: z.infer<typeof PublicAuthorityConfigSchema>,
  now = new Date(),
): SignedExternalAttestation {
  const input = ExternalAttestationSchema.parse(raw);
  parseUnsignedClaim(stripSignature(input), publicConfig, now);
  return input;
}

export function stripSignature(input: SignedExternalAttestation): UnsignedExternalAttestation {
  const unsigned = { ...input } as Record<string, unknown>;
  delete unsigned.signature;
  return UnsignedExternalAttestationSchema.parse(unsigned);
}

export function authorityForClaim(input: UnsignedExternalAttestation | SignedExternalAttestation): AuthorityName {
  return KIND_BINDING[input.evidence.kind].authority;
}

export const A03ControllerInputSchema = z.object({
  schema: z.literal("sophia_voice_lab_a03_controller_input_v1"),
  mcp_url: z.string().url(),
  run: RunBindingSchema.extend({ scenario_id: z.literal("V-A03") }).strict(),
  speak_arguments: toolInputSchemas.speak,
}).strict().superRefine((value, context) => {
  if (value.speak_arguments.run_id !== value.run.run_id) context.addIssue({ code: "custom", path: ["speak_arguments", "run_id"], message: "Speak arguments must target the bound run." });
});

export const A03ExecutionRecordSchema = z.object({
  schema: z.literal("sophia_voice_lab_a03_external_client_record_v1"),
  run_id: UuidV4Schema,
  tool_name: z.literal("speak"),
  argument_sha256: Sha256Schema,
  idempotency_key_sha256: Sha256Schema,
  initial_client_request_id_sha256: Sha256Schema,
  retry_client_request_id_sha256: Sha256Schema,
  initial_http_status: z.literal(200),
  retry_http_status: z.literal(200),
  initial_application_response_observed: z.literal(false),
  initial_body_bytes_retained: z.literal(0),
  transport_outcome: z.literal("connection_closed_after_durable_acceptance"),
  operation_id: UuidV4Schema,
  retry_result_request_id_sha256: Sha256Schema,
  retry_response_sha256: Sha256Schema,
  accepted_at: TimestampSchema,
  response_lost_at: TimestampSchema,
  retry_at: TimestampSchema,
  retry_observed_at: TimestampSchema,
  retry_status: z.literal("completed"),
  retry_operation_state: z.literal("succeeded"),
  retry_flag: z.literal(true),
  effect_join_status: z.literal("requires_product_authored_operation_lineage"),
}).strict().superRefine((value, context) => {
  if (value.initial_client_request_id_sha256 === value.retry_client_request_id_sha256) context.addIssue({ code: "custom", message: "Initial and retry HTTP identities must differ." });
  const ordered = [value.accepted_at, value.response_lost_at, value.retry_at, value.retry_observed_at].map((entry) => new Date(entry).getTime());
  if (ordered.some((entry, index) => index > 0 && entry < ordered[index - 1]!)) context.addIssue({ code: "custom", message: "A03 client timestamps are not monotonic." });
});

export const D02RenderControllerInputSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_render_controller_input_v1"),
  voice_lab_url: z.string().url(),
  render_api_origin: z.literal("https://api.render.com"),
  render_service_id: z.string().regex(/^srv-[0-9a-z]{20}$/),
  run: RunBindingSchema.extend({ scenario_id: z.literal("V-D02") }).strict(),
  operation: z.object({
    operation_id: UuidV4Schema,
    operation_type: z.enum(["speak", "barge_in"]),
    public_argument_sha256: Sha256Schema,
    request_sha256: Sha256Schema,
    idempotency_key_sha256: Sha256Schema,
    durable_receipt_sha256: Sha256Schema,
    replay_arguments: z.record(z.string(), z.unknown()),
  }).strict(),
  browser: z.object({ worker_id_sha256: Sha256Schema, lease_epoch: z.number().int().positive() }).strict(),
  product: z.object({
    canonical_session_id_sha256: Sha256Schema,
    thread_id_sha256: Sha256Schema,
    provider_session_id_sha256: Sha256Schema,
    provider_connection_epoch: z.number().int().positive(),
  }).strict(),
  authorization: z.object({
    service_id_sha256: Sha256Schema,
    one_shot: z.literal(true),
    provider_mutation_authorized: z.literal(true),
    confirmation: z.literal("RESTART_EXACT_VOICE_LAB_MCP_SERVICE_ONCE"),
  }).strict(),
  poll: z.object({ timeout_ms: z.number().int().min(30_000).max(900_000), interval_ms: z.number().int().min(1_000).max(15_000) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.authorization.service_id_sha256 !== sha256(value.render_service_id)) context.addIssue({ code: "custom", path: ["authorization", "service_id_sha256"], message: "Render service ID authorization hash mismatch." });
  const replay = value.operation.replay_arguments;
  if (replay.run_id !== value.run.run_id || replay.idempotency_key === undefined || sha256(String(replay.idempotency_key)) !== value.operation.idempotency_key_sha256 || canonicalRequestHash(replay) !== value.operation.public_argument_sha256) context.addIssue({ code: "custom", path: ["operation", "replay_arguments"], message: "Replay arguments must exactly match the public argument hash, run, and idempotency key; the augmented durable operation hash remains separately bound." });
});

export const D02LocalControllerReceiptSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_render_controller_receipt_v1"),
  receipt_id: UuidV4Schema,
  restart_request_id: UuidV4Schema,
  run_id: UuidV4Schema,
  test_run_id_sha256: Sha256Schema,
  environment: z.enum(["production", "staging"]),
  expected_deployment: DeploymentSchema,
  authority: z.literal("deployment_control"),
  issuer: IdentifierSchema,
  subject: IdentifierSchema,
  authority_key_id: IdentifierSchema,
  audience: z.literal("sophia-voice-lab-deployment-controller-receipt"),
  render: z.object({
    service_id_sha256: Sha256Schema,
    before_service_response_sha256: Sha256Schema,
    after_service_response_sha256: Sha256Schema,
    before_deploy_id_sha256: Sha256Schema,
    after_deploy_id_sha256: Sha256Schema,
    before_deploy_response_sha256: Sha256Schema,
    after_deploy_response_sha256: Sha256Schema,
    before_instance_set_sha256: Sha256Schema,
    after_instance_set_sha256: Sha256Schema,
    restart_request_sha256: Sha256Schema,
    restart_accepted_response_sha256: Sha256Schema,
    restart_http_status: z.literal(200),
    restart_requested_at: TimestampSchema,
    restart_accepted_at: TimestampSchema,
    deploy_started_at: TimestampSchema,
    deploy_settled_at: TimestampSchema,
    provider_action_state: z.literal("settled_live"),
  }).strict(),
  service: z.object({
    before_boot_id_sha256: Sha256Schema,
    after_boot_id_sha256: Sha256Schema,
    before_instance_id_sha256: Sha256Schema,
    after_instance_id_sha256: Sha256Schema,
    before_version_response_sha256: Sha256Schema,
    after_version_response_sha256: Sha256Schema,
    exact_candidate_sha_preserved: z.literal(true),
  }).strict(),
  browser: z.object({ continuity_proof: D02BrowserContinuityProofSchema }).strict(),
  replay: z.object({
    operation_id: UuidV4Schema,
    request_sha256: Sha256Schema,
    original_receipt_sha256: Sha256Schema,
    replay_receipt_sha256: Sha256Schema,
    replay_response_sha256: Sha256Schema,
    observed_at: TimestampSchema,
    duplicate_injection_count: z.literal(0),
  }).strict(),
  nonce: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
  issued_at: TimestampSchema,
  expires_at: TimestampSchema,
  signature_algorithm: z.literal("ed25519-sha256-canonical-request-v1"),
  signature: z.string().min(80).max(96).regex(/^[A-Za-z0-9_-]+$/),
}).strict().superRefine((value, context) => {
  if (value.receipt_id !== value.restart_request_id) context.addIssue({ code: "custom", path: ["receipt_id"], message: "Receipt ID must be the exact restart request ID." });
  if (value.render.before_deploy_id_sha256 === value.render.after_deploy_id_sha256 || value.render.before_instance_set_sha256 === value.render.after_instance_set_sha256 || value.service.before_boot_id_sha256 === value.service.after_boot_id_sha256 || value.service.before_instance_id_sha256 === value.service.after_instance_id_sha256) context.addIssue({ code: "custom", message: "Restart receipt must prove changed deploy, instance set, boot, and service instance identities." });
  if (value.replay.original_receipt_sha256 !== value.replay.replay_receipt_sha256) context.addIssue({ code: "custom", path: ["replay"], message: "Durable operation receipt changed across restart." });
  const requestedAt = new Date(value.render.restart_requested_at).getTime();
  const acceptedAt = new Date(value.render.restart_accepted_at).getTime();
  const deployStartedAt = new Date(value.render.deploy_started_at).getTime();
  const deploySettledAt = new Date(value.render.deploy_settled_at).getTime();
  const replayObservedAt = new Date(value.replay.observed_at).getTime();
  const continuityObservedAt = new Date(value.browser.continuity_proof.observed_at).getTime();
  const issuedAt = new Date(value.issued_at).getTime();
  // Render can start processing the accepted restart before the controller
  // receives the HTTP 200. Bind both observations after submission and before
  // settlement without pretending their two clocks have a total ordering.
  if (acceptedAt < requestedAt || deployStartedAt < requestedAt || deploySettledAt < acceptedAt || deploySettledAt < deployStartedAt || replayObservedAt < deploySettledAt) context.addIssue({ code: "custom", message: "D02 controller receipt timestamps do not prove request/acceptance/start/settlement/replay ordering." });
  if (continuityObservedAt < replayObservedAt || issuedAt < continuityObservedAt) context.addIssue({ code: "custom", path: ["browser"], message: "D02 controller receipt must contain a server-derived continuity observation after replay and before signing." });
});

export const D02RenderWorkerTerminationInputSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_render_worker_termination_input_v1"),
  voice_lab_url: z.string().url(),
  render_api_origin: z.literal("https://api.render.com"),
  render_worker_service_id: z.string().regex(/^srv-[0-9a-z]{20}$/),
  run: RunBindingSchema.extend({ scenario_id: z.literal("V-D02") }).strict(),
  provider: z.object({
    session_id_sha256: Sha256Schema,
    admission_id_sha256: Sha256Schema,
    connection_epoch: z.number().int().positive(),
    frozen_connection_epochs: z.array(z.number().int().positive()).min(1).max(64),
  }).strict(),
  browser: z.object({
    worker_id_sha256: Sha256Schema,
    lease_epoch: z.number().int().positive(),
    context_id_sha256: Sha256Schema,
  }).strict(),
  authorization: z.object({
    service_id_sha256: Sha256Schema,
    one_shot: z.literal(true),
    worker_mutation_authorized: z.literal(true),
    product_mutation_authorized: z.literal(false),
    confirmation: z.literal("RESTART_EXACT_VOICE_LAB_BROWSER_WORKER_ONCE"),
  }).strict(),
  poll: z.object({ timeout_ms: z.number().int().min(30_000).max(900_000), interval_ms: z.number().int().min(1_000).max(15_000) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.authorization.service_id_sha256 !== sha256(value.render_worker_service_id)) context.addIssue({ code: "custom", path: ["authorization", "service_id_sha256"], message: "Render worker service authorization hash mismatch." });
  if (new Set(value.provider.frozen_connection_epochs).size !== value.provider.frozen_connection_epochs.length
    || value.provider.frozen_connection_epochs.some((epoch, index) => index > 0 && epoch <= value.provider.frozen_connection_epochs[index - 1]!)) {
    context.addIssue({ code: "custom", path: ["provider", "frozen_connection_epochs"], message: "Frozen provider epochs must be unique and strictly ascending." });
  }
  if (!value.provider.frozen_connection_epochs.includes(value.provider.connection_epoch)) context.addIssue({ code: "custom", path: ["provider", "connection_epoch"], message: "Current provider epoch must be present in the frozen epoch set." });
});

export const D02WorkerTerminationControllerReceiptSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_render_worker_termination_receipt_v1"),
  receipt_id: UuidV4Schema,
  termination_request_id: UuidV4Schema,
  run_id: UuidV4Schema,
  test_run_id_sha256: Sha256Schema,
  cleanup_obligation_id_sha256: Sha256Schema,
  environment: z.enum(["production", "staging"]),
  expected_deployment: DeploymentSchema,
  authority: z.literal("deployment_control"),
  issuer: IdentifierSchema,
  subject: IdentifierSchema,
  authority_key_id: IdentifierSchema,
  audience: z.literal("sophia-voice-lab-browser-worker-termination-receipt"),
  binding: z.object({
    worker_service_id_sha256: Sha256Schema,
    provider_session_id_sha256: Sha256Schema,
    provider_admission_id_sha256: Sha256Schema,
    provider_connection_epoch: z.number().int().positive(),
    frozen_provider_connection_epochs: z.array(z.number().int().positive()).min(1).max(64),
    browser_worker_id_sha256: Sha256Schema,
    browser_lease_epoch: z.number().int().positive(),
    browser_context_id_sha256: Sha256Schema,
  }).strict(),
  render: z.object({
    before_service_response_sha256: Sha256Schema,
    after_service_response_sha256: Sha256Schema,
    before_deploy_id_sha256: Sha256Schema,
    after_deploy_id_sha256: Sha256Schema,
    before_deploy_response_sha256: Sha256Schema,
    after_deploy_response_sha256: Sha256Schema,
    before_instance_response_sha256: Sha256Schema,
    after_instance_response_sha256: Sha256Schema,
    before_instance_set_sha256: Sha256Schema,
    after_instance_set_sha256: Sha256Schema,
    before_worker_owner_instance_id_sha256: Sha256Schema,
    before_worker_owner_membership_count: z.literal(1),
    replacement_worker_owner_instance_id_sha256: Sha256Schema,
    replacement_worker_owner_membership_count: z.literal(1),
    lost_worker_present_before_restart: z.literal(true),
    lost_worker_absent_after_restart: z.literal(true),
    dispatch_attempt_id_sha256: Sha256Schema,
    dispatch_claim_sha256: Sha256Schema,
    dispatch_claim_event_seq: z.number().int().positive(),
    action_request_sha256: Sha256Schema,
    action_accepted_response_sha256: Sha256Schema,
    action_settled_snapshot_sha256: Sha256Schema,
    action_http_status: z.literal(200),
    action_requested_at: TimestampSchema,
    action_accepted_at: TimestampSchema,
    action_settled_at: TimestampSchema,
    old_worker_instances_absent: z.literal(true),
    replacement_worker_instances_observed: z.literal(true),
    action_state: z.literal("settled_live_replacement"),
  }).strict(),
  voice_lab: z.object({ worker_loss_observation: D02BrowserWorkerLossObservationSchema }).strict(),
  gateway: z.object({ settlement_schema_status: z.literal("not_yet_included"), settlement_receipt_included: z.literal(false) }).strict(),
  nonce: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
  issued_at: TimestampSchema,
  expires_at: TimestampSchema,
  signature_algorithm: z.literal("ed25519-sha256-canonical-request-v1"),
  signature: z.string().min(80).max(96).regex(/^[A-Za-z0-9_-]+$/),
}).strict().superRefine((value, context) => {
  if (value.receipt_id !== value.termination_request_id) context.addIssue({ code: "custom", path: ["receipt_id"], message: "Receipt ID must equal the one-shot termination request ID." });
  if (value.render.before_instance_set_sha256 === value.render.after_instance_set_sha256) context.addIssue({ code: "custom", path: ["render"], message: "Worker termination receipt must prove a disjoint replacement instance set." });
  if (value.render.before_worker_owner_instance_id_sha256 !== value.binding.browser_worker_id_sha256) context.addIssue({ code: "custom", path: ["render", "before_worker_owner_instance_id_sha256"], message: "Worker termination receipt must bind the exact Render owner to the governed browser worker." });
  const epochs = value.binding.frozen_provider_connection_epochs;
  if (new Set(epochs).size !== epochs.length || epochs.some((epoch, index) => index > 0 && epoch <= epochs[index - 1]!) || !epochs.includes(value.binding.provider_connection_epoch)) context.addIssue({ code: "custom", path: ["binding", "frozen_provider_connection_epochs"], message: "Receipt provider epoch set is not canonical." });
  if (!orderedReceiptTimes(value.render.action_requested_at, value.render.action_accepted_at, value.render.action_settled_at, value.issued_at, value.expires_at)) context.addIssue({ code: "custom", path: ["render"], message: "Worker termination receipt timestamps are not ordered." });
  const observation = value.voice_lab.worker_loss_observation;
  if (observation.run_id_sha256 !== sha256(value.run_id) || observation.test_run_id_sha256 !== value.test_run_id_sha256 || observation.cleanup_obligation_id_sha256 !== value.cleanup_obligation_id_sha256
    || observation.termination_request_id_sha256 !== sha256(value.termination_request_id) || observation.provider_session_id_sha256 !== value.binding.provider_session_id_sha256
    || observation.provider_admission_id_sha256 !== value.binding.provider_admission_id_sha256 || observation.provider_connection_epoch !== value.binding.provider_connection_epoch
    || canonicalRequestHash(observation.frozen_provider_connection_epochs) !== canonicalRequestHash(value.binding.frozen_provider_connection_epochs)
    || observation.browser_context_id_sha256 !== value.binding.browser_context_id_sha256 || observation.lost_browser_worker_id_sha256 !== value.binding.browser_worker_id_sha256
    || observation.lost_browser_lease_epoch !== value.binding.browser_lease_epoch
    || observation.replacement_browser_worker_id_sha256 !== value.render.replacement_worker_owner_instance_id_sha256) context.addIssue({ code: "custom", path: ["voice_lab"], message: "Voice Lab loss observation does not bind the exact controller identities and Render replacement owner." });
});

function orderedReceiptTimes(...values: string[]): boolean {
  const times = values.map((value) => new Date(value).getTime());
  return times.every(Number.isFinite) && times.every((value, index) => index === 0 || times[index - 1]! <= value);
}

/**
 * P01 accepts execution intent and immutable expected identities only. It has
 * deliberately no `evidence`, transcript, response, or `call_observations`
 * field: the source controller must obtain those facts from the signed Codex
 * binary's CLI and App Server byte streams before the platform key is opened.
 */
export const P01CollectorInputSchema = z.object({
  schema: z.literal("sophia_voice_lab_p01_official_collector_input_v1"),
  campaign: z.object({
    scenario_id: z.literal("V-P01"),
    scenario_version: z.literal("vt00.scenarios.v1"),
    environment: z.enum(["production", "staging"]),
    expected_deployment: DeploymentSchema,
  }).strict(),
  codex: z.object({
    binary_path: z.string().min(1).max(4_096),
    binary_sha256: Sha256Schema,
    version: z.string().regex(/^codex-cli \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  }).strict(),
  plugin: z.object({
    source_root: z.string().min(1).max(4_096),
    selector: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}@[a-z0-9][a-z0-9._-]{1,63}$/),
    plugin_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}@[a-z0-9][a-z0-9._-]{1,63}$/),
    name: z.literal("sophia-voice-lab"),
    marketplace_name: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
    version: z.string().regex(FINAL_CODEX_PLUGIN_VERSION_PATTERN),
    package_sha256: Sha256Schema,
    skill_name: z.literal("sophia-voice-lab:autonomous-voice-dogfood"),
    skill_relative_path: z.literal("skills/autonomous-voice-dogfood/SKILL.md"),
  }).strict(),
  app: z.object({
    registered_app_id: z.string().regex(/^plugin_asdk_app[0-9A-Za-z_-]{4,112}$/),
    runtime_name: z.string().min(1).max(128),
  }).strict(),
  execution: z.object({
    cwd: z.string().min(1).max(4_096),
    model: z.string().min(2).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    request_timeout_ms: z.number().int().min(10_000).max(3_600_000),
    shutdown_timeout_ms: z.number().int().min(1_000).max(30_000).default(5_000),
    maximum_frame_bytes: z.number().int().min(65_536).max(16_777_216).default(4_194_304),
    maximum_capture_bytes: z.number().int().min(1_048_576).max(67_108_864).default(16_777_216),
  }).strict(),
}).strict().superRefine((value, context) => {
  const expectedPluginId = `${value.plugin.name}@${value.plugin.marketplace_name}`;
  if (value.plugin.selector !== expectedPluginId || value.plugin.plugin_id !== expectedPluginId) {
    context.addIssue({ code: "custom", path: ["plugin", "plugin_id"], message: "Plugin selector, ID, name, and marketplace must be one exact identity." });
  }
});

export type PublicAuthorityConfig = z.infer<typeof PublicAuthorityConfigSchema>;
export type TransportTokens = z.infer<typeof TransportTokensSchema>;
export type RunBinding = z.infer<typeof RunBindingSchema>;
export type A03ControllerInput = z.infer<typeof A03ControllerInputSchema>;
export type A03ExecutionRecord = z.infer<typeof A03ExecutionRecordSchema>;
export type D02RenderControllerInput = z.infer<typeof D02RenderControllerInputSchema>;
export type D02LocalControllerReceipt = z.infer<typeof D02LocalControllerReceiptSchema>;
export type D02RenderWorkerTerminationInput = z.infer<typeof D02RenderWorkerTerminationInputSchema>;
export type D02WorkerTerminationControllerReceipt = z.infer<typeof D02WorkerTerminationControllerReceiptSchema>;
export type P01CollectorInput = z.infer<typeof P01CollectorInputSchema>;
