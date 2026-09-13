import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import { z } from "zod";
import { canonicalRequestHash, sha256 } from "./security.js";
const ExternalShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ExternalTimestampSchema = z.string().datetime({ offset: true });
const Sha256Schema = ExternalShaSchema;
const TimestampSchema = ExternalTimestampSchema;
const IdentifierSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const UuidV4Schema = z.string().uuid().refine(value => value[14]?.toLowerCase() === "4", "UUID must be version 4");
const DeploymentSchema = z.object({ frontend: z.string().regex(/^[a-f0-9]{40}$/), backend: z.string().regex(/^[a-f0-9]{40}$/), voice: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
function orderedTimestamps(...values: string[]): boolean { const times = values.map(v => new Date(v).getTime()); return times.every(Number.isFinite) && times.every((v,i) => i === 0 || times[i-1]! <= v); }
const orderedReceiptTimes = orderedTimestamps;
export const D02BrowserWorkerLossObservationCoreSchema = z.object({
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

export type D02WorkerTerminationControllerReceipt = z.infer<typeof D02WorkerTerminationControllerReceiptSchema>;
export type WorkerReceiptAuthority = { issuer: string; subject: string; key_id: string; public_key_spki_base64: string };
export function verifyD02WorkerTerminationSignature(input: unknown, authority: WorkerReceiptAuthority): D02WorkerTerminationControllerReceipt {
  const parsed = D02WorkerTerminationControllerReceiptSchema.parse(input);
  if (parsed.issuer !== authority.issuer || parsed.subject !== authority.subject || parsed.authority_key_id !== authority.key_id) throw new Error("D02 worker-termination receipt does not match the deployment-control public configuration.");
  const unsigned = { ...parsed } as Record<string, unknown>; delete unsigned.signature;
  const key = createPublicKey({ key: Buffer.from(authority.public_key_spki_base64, "base64"), format: "der", type: "spki" });
  if (!ed25519Verify(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), key, Buffer.from(parsed.signature, "base64url"))) throw new Error("D02 worker-termination controller receipt signature verification failed.");
  return parsed;
}
