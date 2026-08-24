import { createHmac, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from "node:crypto";

import { z } from "zod";

import type { VoiceLabConfig } from "./config.js";
import { VoiceLabError, labError } from "./domain.js";
import { canonicalRequestHash, sha256, validateAllowedOrigin } from "./security.js";

const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const UUID_V4 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "Expected canonical lowercase UUIDv4.");
const CANONICAL_UTC_MILLIS = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}, "Expected canonical UTC milliseconds.");
const POSITIVE_EPOCHS = z.array(z.number().int().positive()).min(1).max(64);
const D02_GATEWAY_BINDING_SHAPE = {
  termination_request_id: UUID_V4,
  voice_lab_run_id_sha256: SHA256,
  test_run_id: UUID_V4,
  cleanup_obligation_id: UUID_V4,
  provider_session_id: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
  provider_admission_id_sha256: SHA256,
  provider_connection_epoch: z.number().int().positive(),
  frozen_provider_connection_epochs: POSITIVE_EPOCHS,
  browser_worker_id_sha256: SHA256,
  browser_lease_epoch: z.number().int().positive(),
  browser_context_id_sha256: SHA256,
  render_action_request_sha256: SHA256,
} as const;

export const D02GatewayFreezeRequestSchema = z.object({
  schema: z.literal("sophia_voice_lab_gateway_browser_worker_termination_freeze_request_v1"),
  ...D02_GATEWAY_BINDING_SHAPE,
  requested_at: CANONICAL_UTC_MILLIS,
}).strict().superRefine((value, context) => {
  if (new Set(value.frozen_provider_connection_epochs).size !== value.frozen_provider_connection_epochs.length
    || value.frozen_provider_connection_epochs.some((epoch, index) => index > 0 && epoch <= value.frozen_provider_connection_epochs[index - 1]!)) {
    context.addIssue({ code: "custom", path: ["frozen_provider_connection_epochs"], message: "Frozen provider epochs must be unique and strictly ascending." });
  }
  if (!value.frozen_provider_connection_epochs.includes(value.provider_connection_epoch)) context.addIssue({ code: "custom", path: ["provider_connection_epoch"], message: "Current provider epoch must be frozen." });
});

export const D02GatewaySettlementRequestSchema = z.object({
  schema: z.literal("sophia_voice_lab_gateway_browser_worker_termination_settlement_request_v1"),
  ...D02_GATEWAY_BINDING_SHAPE,
  render_action_accepted_response_sha256: SHA256,
  render_action_settled_snapshot_sha256: SHA256,
  loss_event_seq: z.number().int().positive(),
  loss_observed_at: CANONICAL_UTC_MILLIS,
}).strict().superRefine((value, context) => {
  if (new Set(value.frozen_provider_connection_epochs).size !== value.frozen_provider_connection_epochs.length
    || value.frozen_provider_connection_epochs.some((epoch, index) => index > 0 && epoch <= value.frozen_provider_connection_epochs[index - 1]!)) {
    context.addIssue({ code: "custom", path: ["frozen_provider_connection_epochs"], message: "Frozen provider epochs must be unique and strictly ascending." });
  }
  if (!value.frozen_provider_connection_epochs.includes(value.provider_connection_epoch)) context.addIssue({ code: "custom", path: ["provider_connection_epoch"], message: "Current provider epoch must be frozen." });
});

export const D02GatewayFreezeResponseSchema = z.object({
  frozen: z.literal(true),
  idempotent_replay: z.boolean(),
  freeze_request_sha256: SHA256,
}).strict();

export const D02GatewayContinuityObservationRequestSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_product_continuity_observation_request_v1"),
  restart_request_id: UUID_V4,
  cleanup_obligation_id: UUID_V4,
  phase: z.enum(["before_api_restart", "after_api_restart"]),
  product_service_boot_id_sha256: SHA256,
  render_action_request_sha256: SHA256,
  prior_observation_receipt_sha256: SHA256.nullable(),
  observed_at: CANONICAL_UTC_MILLIS,
}).strict().superRefine((value, context) => {
  if (value.phase === "before_api_restart" && value.prior_observation_receipt_sha256 !== null) context.addIssue({ code: "custom", path: ["prior_observation_receipt_sha256"], message: "Before-restart continuity cannot cite a prior observation." });
  if (value.phase === "after_api_restart" && value.prior_observation_receipt_sha256 === null) context.addIssue({ code: "custom", path: ["prior_observation_receipt_sha256"], message: "After-restart continuity must cite the exact before receipt." });
});

const D02GatewayContinuityProjectionSchema = z.object({
  session_id_sha256: SHA256,
  thread_id_sha256: SHA256,
  principal_id_hmac: SHA256,
  test_run_id_sha256: SHA256,
  cleanup_obligation_id_sha256: SHA256,
  provider_session_id_sha256: SHA256,
  provider_admission_id_sha256: SHA256,
  voice_lab_run_id_sha256: SHA256,
  browser_worker_id_sha256: SHA256,
  browser_lease_epoch: z.number().int().positive(),
  browser_context_id_sha256: SHA256,
  voice_runtime_instance_id_sha256: SHA256,
  expected_deployment: z.object({ frontend: z.string().regex(/^[a-f0-9]{40}$/), backend: z.string().regex(/^[a-f0-9]{40}$/), voice: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  session_status: z.enum(["active", "open", "paused", "resumable"]),
  message_revision: z.number().int().nonnegative(),
  canonical_provider_state: z.literal("active"),
  provider_connection_epoch: z.number().int().positive(),
  provider_pending_connection_epoch: z.number().int().positive().nullable(),
}).strict().superRefine((value, context) => {
  if (value.provider_pending_connection_epoch !== null && value.provider_pending_connection_epoch !== value.provider_connection_epoch + 1) {
    context.addIssue({ code: "custom", path: ["provider_pending_connection_epoch"], message: "A pending provider epoch must be the exact next epoch." });
  }
});

export const D02GatewayContinuityObservationReceiptSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_product_continuity_observation_v1"),
  receipt_id: UUID_V4,
  restart_request_id_sha256: SHA256,
  phase: z.enum(["before_api_restart", "after_api_restart"]),
  request_sha256: SHA256,
  product_service_boot_id_sha256: SHA256,
  render_action_request_sha256: SHA256,
  prior_observation_receipt_sha256: SHA256.nullable(),
  continuity_projection: D02GatewayContinuityProjectionSchema,
  cleanup_obligation_state: z.literal("open"),
  cleanup_lifecycle_phase: z.literal("session_provisional"),
  d02_freeze_absent: z.literal(true),
  database_observed_at: CANONICAL_UTC_MILLIS,
  issuer: z.literal("sophia-gateway"),
  audience: z.literal("sophia-voice-lab-d02-product-continuity"),
  authority_key_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  jti: UUID_V4,
  nonce: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
  issued_at: CANONICAL_UTC_MILLIS,
  expires_at: CANONICAL_UTC_MILLIS,
  signature_algorithm: z.literal("ed25519-sha256-canonical-request-v1"),
  receipt_sha256: SHA256,
  signature: z.string().length(86).regex(/^[A-Za-z0-9_-]+$/),
}).strict().superRefine((value, context) => {
  if (value.receipt_id !== value.jti) context.addIssue({ code: "custom", path: ["jti"], message: "Receipt JTI must equal the receipt ID." });
  if (value.phase === "before_api_restart" && value.prior_observation_receipt_sha256 !== null) context.addIssue({ code: "custom", path: ["prior_observation_receipt_sha256"], message: "Before receipt cannot cite a prior observation." });
  if (value.phase === "after_api_restart" && value.prior_observation_receipt_sha256 === null) context.addIssue({ code: "custom", path: ["prior_observation_receipt_sha256"], message: "After receipt must cite the exact before receipt." });
  const issued = new Date(value.issued_at).getTime();
  const expires = new Date(value.expires_at).getTime();
  if (value.database_observed_at !== value.issued_at || expires <= issued || expires - issued > 900_000) context.addIssue({ code: "custom", path: ["expires_at"], message: "Gateway continuity receipt lifetime is invalid." });
});

export const D02GatewaySettlementReceiptSchema = z.object({
  schema: z.literal("sophia_voice_lab_gateway_browser_worker_termination_settlement_v1"),
  receipt_id: UUID_V4,
  termination_request_id_sha256: SHA256,
  voice_lab_run_id_sha256: SHA256,
  test_run_id_sha256: SHA256,
  cleanup_obligation_id_sha256: SHA256,
  principal_id_hmac: SHA256,
  scenario_id: z.literal("V-D02"),
  scenario_version: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  environment: z.enum(["production", "staging"]),
  expected_deployment: z.object({ frontend: z.string().regex(/^[a-f0-9]{40}$/), backend: z.string().regex(/^[a-f0-9]{40}$/), voice: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  provider_session_id_sha256: SHA256,
  provider_admission_id_sha256: SHA256,
  provider_connection_epoch: z.number().int().positive(),
  frozen_provider_connection_epochs: POSITIVE_EPOCHS,
  browser_worker_id_sha256: SHA256,
  browser_lease_epoch: z.number().int().positive(),
  browser_context_id_sha256: SHA256,
  render_action_request_sha256: SHA256,
  render_action_accepted_response_sha256: SHA256,
  render_action_settled_snapshot_sha256: SHA256,
  loss_event_seq: z.number().int().positive(),
  loss_observed_at: CANONICAL_UTC_MILLIS,
  voice_terminal_receipts_sha256: SHA256,
  provider_settlement_sha256: SHA256,
  cleanup_obligation_state: z.enum(["closed", "complete"]),
  canonical_provider_state: z.literal("closed"),
  canonical_pending_epoch: z.null(),
  all_frozen_provider_epochs_terminal: z.literal(true),
  provider_admission_absent: z.literal(true),
  voice_provider_session_absent: z.literal(true),
  gateway_browser_relay_absent: z.literal(true),
  database_observed_at: CANONICAL_UTC_MILLIS,
  issuer: z.literal("sophia-gateway"),
  audience: z.literal("sophia-voice-lab-d02-gateway-settlement"),
  authority_key_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  jti: UUID_V4,
  nonce: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
  issued_at: CANONICAL_UTC_MILLIS,
  expires_at: CANONICAL_UTC_MILLIS,
  signature_algorithm: z.literal("ed25519-sha256-canonical-request-v1"),
  signature: z.string().length(86).regex(/^[A-Za-z0-9_-]+$/),
}).strict().superRefine((value, context) => {
  if (value.receipt_id !== value.jti) context.addIssue({ code: "custom", path: ["jti"], message: "Receipt JTI must equal the receipt ID." });
  if (new Set(value.frozen_provider_connection_epochs).size !== value.frozen_provider_connection_epochs.length
    || value.frozen_provider_connection_epochs.some((epoch, index) => index > 0 && epoch <= value.frozen_provider_connection_epochs[index - 1]!)) {
    context.addIssue({ code: "custom", path: ["frozen_provider_connection_epochs"], message: "Frozen provider epochs must be unique and strictly ascending." });
  }
  if (!value.frozen_provider_connection_epochs.includes(value.provider_connection_epoch)) context.addIssue({ code: "custom", path: ["provider_connection_epoch"], message: "Current provider epoch must be frozen." });
  const issued = new Date(value.issued_at).getTime();
  const expires = new Date(value.expires_at).getTime();
  if (value.database_observed_at !== value.issued_at || expires <= issued || expires - issued > 900_000) context.addIssue({ code: "custom", path: ["expires_at"], message: "Gateway receipt lifetime is invalid." });
});

export type D02GatewayFreezeRequest = z.infer<typeof D02GatewayFreezeRequestSchema>;
export type D02GatewaySettlementRequest = z.infer<typeof D02GatewaySettlementRequestSchema>;
export type D02GatewayContinuityObservationRequest = z.infer<typeof D02GatewayContinuityObservationRequestSchema>;
export type D02GatewayFreezeResponse = z.infer<typeof D02GatewayFreezeResponseSchema>;
export type D02GatewaySettlementReceipt = z.infer<typeof D02GatewaySettlementReceiptSchema>;
export type D02GatewayContinuityObservationReceipt = z.infer<typeof D02GatewayContinuityObservationReceiptSchema>;

const CAPABILITY_ISSUER = "sophia-voice-lab";
const CAPABILITY_AUDIENCE = "sophia-gateway-d02-settlement";
const CAPABILITY_HEADER = "X-Sophia-Voice-Lab-D02-Gateway-Capability";
const MAX_RESPONSE_BYTES = 1_000_000;

function capabilityToken(input: {
  secret: string;
  operation: "freeze" | "settle" | "observe_continuity";
  requestSha256: string;
  cleanupObligationId: string;
  terminationRequestId: string;
  now: Date;
}): string {
  const seconds = Math.floor(input.now.getTime() / 1_000);
  const claims = {
    v: 1,
    iss: CAPABILITY_ISSUER,
    aud: CAPABILITY_AUDIENCE,
    op: input.operation,
    request_sha256: input.requestSha256,
    cleanup_obligation_id: input.cleanupObligationId,
    termination_request_id_sha256: sha256(input.terminationRequestId),
    iat: seconds,
    nbf: seconds - 2,
    exp: seconds + 120,
    jti: randomUUID(),
    nonce: randomBytes(24).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", input.secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new VoiceLabError(labError("D02_GATEWAY_RESPONSE_INVALID", "The D02 Gateway response exceeded the bounded response contract.", "internal"));
  try { return JSON.parse(text) as unknown; } catch { throw new VoiceLabError(labError("D02_GATEWAY_RESPONSE_INVALID", "The D02 Gateway response was not canonical JSON.", "internal")); }
}

export class D02GatewayClient {
  constructor(
    readonly config: Pick<VoiceLabConfig, "allowedOrigins" | "d02GatewayCapabilitySecret" | "d02GatewayReceiptAuthority">,
    readonly fetchImpl: typeof fetch = fetch,
    readonly now: () => Date = () => new Date(),
  ) {}

  async freeze(gatewayOrigin: string, raw: D02GatewayFreezeRequest): Promise<D02GatewayFreezeResponse> {
    const body = D02GatewayFreezeRequestSchema.parse(raw);
    const response = await this.post(gatewayOrigin, "/internal/voice-lab/d02/browser-worker-termination-freezes", "freeze", body);
    const parsedResult = D02GatewayFreezeResponseSchema.safeParse(response);
    if (!parsedResult.success) throw new VoiceLabError(labError("D02_GATEWAY_FREEZE_PENDING", "The D02 Gateway freeze response shape was ambiguous and must be read back by exact replay.", "evidence", true));
    const parsed = parsedResult.data;
    if (parsed.freeze_request_sha256 !== canonicalRequestHash(body)) throw new VoiceLabError(labError("D02_GATEWAY_FREEZE_CONFLICT", "The Gateway freeze response did not bind the exact request.", "evidence"));
    return parsed;
  }

  async settle(gatewayOrigin: string, raw: D02GatewaySettlementRequest): Promise<D02GatewaySettlementReceipt> {
    const body = D02GatewaySettlementRequestSchema.parse(raw);
    const response = await this.post(gatewayOrigin, "/internal/voice-lab/d02/browser-worker-termination-settlements", "settle", body);
    const parsed = D02GatewaySettlementReceiptSchema.safeParse(response);
    if (!parsed.success) throw new VoiceLabError(labError("D02_GATEWAY_SETTLEMENT_PENDING", "The D02 Gateway settlement response shape was ambiguous and must be read back by exact replay.", "evidence", true));
    const authority = this.config.d02GatewayReceiptAuthority;
    const receiptPublicKey = authority?.publicKeysById[parsed.data.authority_key_id];
    if (authority === null || receiptPublicKey === undefined) throw new VoiceLabError(labError("D02_GATEWAY_RECEIPT_INVALID", "The D02 Gateway settlement receipt authority is unavailable or not retained.", "authorization"));
    const unsigned: Record<string, unknown> = { ...parsed.data };
    delete unsigned.signature;
    let valid = false;
    try {
      const key = createPublicKey({ key: Buffer.from(receiptPublicKey, "base64"), format: "der", type: "spki" });
      valid = verifySignature(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), key, Buffer.from(parsed.data.signature, "base64url"));
    } catch { valid = false; }
    const now = this.now().getTime();
    const issued = new Date(parsed.data.issued_at).getTime();
    // The Gateway returns the immutable, signed settlement receipt on exact
    // response-loss replay. Its short expiry bounds first issuance, not the
    // retention-period readback of an already-committed product fact.
    if (!valid || issued > now + 30_000) throw new VoiceLabError(labError("D02_GATEWAY_RECEIPT_INVALID", "The D02 Gateway settlement receipt signature or issuance time is invalid.", "authorization"));
    if (parsed.data.termination_request_id_sha256 !== sha256(body.termination_request_id)
      || parsed.data.voice_lab_run_id_sha256 !== body.voice_lab_run_id_sha256
      || parsed.data.test_run_id_sha256 !== sha256(body.test_run_id)
      || parsed.data.cleanup_obligation_id_sha256 !== sha256(body.cleanup_obligation_id)
      || parsed.data.provider_session_id_sha256 !== sha256(body.provider_session_id)
      || parsed.data.provider_admission_id_sha256 !== body.provider_admission_id_sha256
      || parsed.data.provider_connection_epoch !== body.provider_connection_epoch
      || canonicalRequestHash(parsed.data.frozen_provider_connection_epochs) !== canonicalRequestHash(body.frozen_provider_connection_epochs)
      || parsed.data.browser_worker_id_sha256 !== body.browser_worker_id_sha256
      || parsed.data.browser_lease_epoch !== body.browser_lease_epoch
      || parsed.data.browser_context_id_sha256 !== body.browser_context_id_sha256
      || parsed.data.render_action_request_sha256 !== body.render_action_request_sha256
      || parsed.data.render_action_accepted_response_sha256 !== body.render_action_accepted_response_sha256
      || parsed.data.render_action_settled_snapshot_sha256 !== body.render_action_settled_snapshot_sha256
      || parsed.data.loss_event_seq !== body.loss_event_seq
      || parsed.data.loss_observed_at !== body.loss_observed_at) {
      throw new VoiceLabError(labError("D02_GATEWAY_RECEIPT_BINDING_MISMATCH", "The authentic D02 Gateway receipt did not bind the exact settlement request.", "evidence"));
    }
    return parsed.data;
  }

  async observeContinuity(gatewayOrigin: string, raw: D02GatewayContinuityObservationRequest): Promise<D02GatewayContinuityObservationReceipt> {
    const body = D02GatewayContinuityObservationRequestSchema.parse(raw);
    const response = await this.post(gatewayOrigin, "/internal/voice-lab/d02/product-continuity-observations", "observe_continuity", body);
    const parsed = D02GatewayContinuityObservationReceiptSchema.safeParse(response);
    if (!parsed.success) throw new VoiceLabError(labError("D02_GATEWAY_CONTINUITY_PENDING", "The D02 Gateway product continuity response shape was ambiguous and must be read back by exact replay.", "evidence", true));
    const authority = this.config.d02GatewayReceiptAuthority;
    const receiptPublicKey = authority?.publicKeysById[parsed.data.authority_key_id];
    if (authority === null || receiptPublicKey === undefined) throw new VoiceLabError(labError("D02_GATEWAY_RECEIPT_INVALID", "The D02 Gateway continuity receipt authority is unavailable or not retained.", "authorization"));
    const unsigned: Record<string, unknown> = { ...parsed.data };
    delete unsigned.signature;
    const receiptCore: Record<string, unknown> = { ...unsigned };
    delete receiptCore.receipt_sha256;
    let valid = false;
    try {
      const key = createPublicKey({ key: Buffer.from(receiptPublicKey, "base64"), format: "der", type: "spki" });
      valid = verifySignature(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), key, Buffer.from(parsed.data.signature, "base64url"));
    } catch { valid = false; }
    const now = this.now().getTime();
    const issued = new Date(parsed.data.issued_at).getTime();
    const requestObservedAt = new Date(body.observed_at).getTime();
    if (!valid || parsed.data.receipt_sha256 !== canonicalRequestHash(receiptCore) || issued > now + 30_000 || requestObservedAt > issued + 30_000) {
      throw new VoiceLabError(labError("D02_GATEWAY_RECEIPT_INVALID", "The D02 Gateway continuity receipt signature, content hash, or issuance time is invalid.", "authorization"));
    }
    if (parsed.data.restart_request_id_sha256 !== sha256(body.restart_request_id)
      || parsed.data.phase !== body.phase || parsed.data.request_sha256 !== canonicalRequestHash(body)
      || parsed.data.product_service_boot_id_sha256 !== body.product_service_boot_id_sha256
      || parsed.data.render_action_request_sha256 !== body.render_action_request_sha256
      || parsed.data.prior_observation_receipt_sha256 !== body.prior_observation_receipt_sha256
      || parsed.data.continuity_projection.cleanup_obligation_id_sha256 !== sha256(body.cleanup_obligation_id)) {
      throw new VoiceLabError(labError("D02_GATEWAY_RECEIPT_BINDING_MISMATCH", "The authentic D02 Gateway continuity receipt did not bind the exact observation request.", "evidence"));
    }
    return parsed.data;
  }

  private async post(gatewayOrigin: string, pathname: string, operation: "freeze" | "settle" | "observe_continuity", body: D02GatewayFreezeRequest | D02GatewaySettlementRequest | D02GatewayContinuityObservationRequest): Promise<unknown> {
    const origin = validateAllowedOrigin(gatewayOrigin, this.config.allowedOrigins).origin;
    const secret = this.config.d02GatewayCapabilitySecret;
    if (secret === null) throw new VoiceLabError(labError("D02_GATEWAY_AUTHORITY_UNAVAILABLE", "The product-owned D02 Gateway authority is unavailable.", "internal"));
    const requestSha256 = canonicalRequestHash(body);
    const actionRequestId = "termination_request_id" in body ? body.termination_request_id : body.restart_request_id;
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(pathname, origin), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          [CAPABILITY_HEADER]: capabilityToken({ secret, operation, requestSha256, cleanupObligationId: body.cleanup_obligation_id, terminationRequestId: actionRequestId, now: this.now() }),
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new VoiceLabError(labError(operation === "freeze" ? "D02_GATEWAY_FREEZE_PENDING" : operation === "settle" ? "D02_GATEWAY_SETTLEMENT_PENDING" : "D02_GATEWAY_CONTINUITY_PENDING", "The exact D02 Gateway transaction has not been read back yet.", "evidence", true));
    }
    let parsed: unknown;
    try {
      parsed = await boundedJson(response);
    } catch {
      throw new VoiceLabError(labError(operation === "freeze" ? "D02_GATEWAY_FREEZE_PENDING" : operation === "settle" ? "D02_GATEWAY_SETTLEMENT_PENDING" : "D02_GATEWAY_CONTINUITY_PENDING", "The D02 Gateway transaction response was ambiguous and must be read back by exact replay.", "evidence", true));
    }
    if (!response.ok) {
      const code = typeof parsed === "object" && parsed !== null && typeof (parsed as { detail?: { code?: unknown } }).detail?.code === "string"
        ? (parsed as { detail: { code: string } }).detail.code
        : "unclassified";
      throw new VoiceLabError(labError(operation === "freeze" ? "D02_GATEWAY_FREEZE_PENDING" : operation === "settle" ? "D02_GATEWAY_SETTLEMENT_PENDING" : "D02_GATEWAY_CONTINUITY_PENDING", `The D02 Gateway ${operation} transaction is unavailable (${code}).`, response.status === 401 || response.status === 403 ? "authorization" : "evidence", response.status === 409 || response.status >= 500));
    }
    return parsed;
  }
}
