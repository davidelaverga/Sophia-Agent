import { createPublicKey, randomUUID, verify as ed25519Verify } from "node:crypto";

import { z } from "zod";

import { canonicalRequestHash, sha256 } from "../../src/security.js";
import { ExternalAttestationSchema } from "../../src/service.js";
import {
  A03ExecutionRecordSchema,
  PublicAuthorityConfigSchema,
  TransportTokensSchema,
  authorityForClaim,
  stripSignature,
  type A03ControllerInput,
  type A03ExecutionRecord,
  type PublicAuthorityConfig,
  type SignedExternalAttestation,
  type TransportTokens,
} from "./contracts.js";

const MAX_RESPONSE_BYTES = 2_000_000;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const AttestationReceiptSchema = z.object({
  contract_version: z.literal("sophia.voice-lab.v1"),
  request_id: z.string().uuid(),
  run_id: z.string().uuid(),
  test_run_id: z.string().uuid(),
  status: z.literal("completed"),
  event_cursor: z.number().int().nonnegative(),
  deployment_identity: z.object({ expected: z.record(z.string(), z.string()), observed: z.record(z.string(), z.string()) }).strict(),
  data: z.object({
    attestation_id: z.string().uuid(),
    attestation_kind: z.enum(["a03_http_response_loss", "d02_restart_command", "d02_browser_worker_termination_command", "d02_api_process_restart", "d02_browser_worker_loss", "p01_platform_plugin_task"]),
    content_sha256: Sha256Schema,
    event_seq: z.number().int().positive(),
    immutable: z.literal(true),
    replay: z.boolean().optional(),
    gateway_freeze_idempotent_replay: z.literal(true).optional(),
    gateway_continuity_idempotent_replay: z.literal(true).optional(),
    proof_status: z.literal("pending_evaluator_cross_join"),
  }).passthrough(),
}).passthrough();

const McpEnvelopeSchema = z.object({
  contract_version: z.literal("sophia.voice-lab.v1"),
  request_id: z.string().uuid(),
  run_id: z.string().uuid().nullable(),
  test_run_id: z.string().uuid().nullable(),
  operation_id: z.string().uuid().nullable(),
  status: z.enum(["ok", "accepted", "running", "completed", "failed", "timeout", "unavailable"]),
  observed_at: z.string().datetime({ offset: true }),
  data: z.record(z.string(), z.unknown()),
}).passthrough();

export const VerifiedAttestationReceiptSchema = z.object({
  first_response_sha256: Sha256Schema,
  replay_response_sha256: Sha256Schema,
  attestation_id: z.string().uuid(),
  attestation_kind: z.enum(["a03_http_response_loss", "d02_restart_command", "d02_browser_worker_termination_command", "d02_api_process_restart", "d02_browser_worker_loss", "p01_platform_plugin_task"]),
  content_sha256: Sha256Schema,
  event_seq: z.number().int().positive(),
  event_cursor: z.number().int().nonnegative(),
  immutable: z.literal(true),
  exact_replay_verified: z.literal(true),
}).strict().superRefine((value, context) => {
  if (value.event_cursor < value.event_seq) context.addIssue({ code: "custom", path: ["event_cursor"], message: "Verified receipt cursor predates its immutable event." });
});

export type VerifiedAttestationReceipt = z.infer<typeof VerifiedAttestationReceiptSchema>;

export const AttestationResponseCheckpointSchema = z.object({
  ordinal: z.union([z.literal(1), z.literal(2)]),
  response_sha256: Sha256Schema,
  envelope: AttestationReceiptSchema,
}).strict();

export type AttestationResponseCheckpoint = z.infer<typeof AttestationResponseCheckpointSchema>;

export interface AttestationRetryPolicy {
  maxAttempts: number;
  intervalMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function postAttestationAndVerifyReplay(input: {
  baseUrl: string;
  claim: SignedExternalAttestation;
  publicConfig: PublicAuthorityConfig;
  transportTokens: TransportTokens;
  fetchImpl?: typeof fetch;
  allowHttpForTest?: boolean;
  priorResponses?: readonly AttestationResponseCheckpoint[];
  onResponse?: (response: AttestationResponseCheckpoint) => Promise<void>;
  retry?: AttestationRetryPolicy;
}): Promise<VerifiedAttestationReceipt> {
  const publicConfig = PublicAuthorityConfigSchema.parse(input.publicConfig);
  const claim = ExternalAttestationSchema.parse(input.claim);
  verifyPersistedExternalClaimSignature(claim, publicConfig);
  const authority = authorityForClaim(claim);
  const tokens = TransportTokensSchema.parse(input.transportTokens);
  const endpoint = exactEndpoint(input.baseUrl, "/internal/voice-lab/attestations", input.allowHttpForTest === true);
  const retry = normalizeRetryPolicy(input.retry);
  const prior = [...(input.priorResponses ?? [])].map((value) => AttestationResponseCheckpointSchema.parse(value));
  if (prior.length > 2 || prior.some((value, index) => value.ordinal !== index + 1)) throw new Error("Attestation response checkpoints must be one contiguous immutable prefix.");
  for (const response of prior) assertReceiptBinding(response.envelope, claim, response.ordinal === 2);

  const responses = [...prior];
  while (responses.length < 2) {
    const ordinal = (responses.length + 1) as 1 | 2;
    const response = await requestAttestationWithExactRetry({
      endpoint,
      claim,
      bearer: tokens[authority],
      fetchImpl: input.fetchImpl ?? fetch,
      ordinal,
      retry,
    });
    // A durable caller records each successful response before the next POST.
    // Callback failure is intentionally terminal for this invocation; the next
    // invocation can replay these exact signed bytes without minting a claim.
    await input.onResponse?.(response);
    responses.push(response);
  }
  const [first, replay] = responses as [AttestationResponseCheckpoint, AttestationResponseCheckpoint];
  if (first.envelope.data.event_seq !== replay.envelope.data.event_seq || first.envelope.data.content_sha256 !== replay.envelope.data.content_sha256) throw new Error("Exact attestation replay did not resolve to the immutable original receipt.");
  return VerifiedAttestationReceiptSchema.parse({
    first_response_sha256: first.response_sha256,
    replay_response_sha256: replay.response_sha256,
    attestation_id: claim.attestation_id,
    attestation_kind: claim.evidence.kind,
    content_sha256: first.envelope.data.content_sha256,
    event_seq: first.envelope.data.event_seq,
    event_cursor: Math.max(first.envelope.event_cursor, replay.envelope.event_cursor),
    immutable: true,
    exact_replay_verified: true,
  });
}

/** Verify signature/authority/binding without applying the short transport TTL.
 * The service authorizes delayed recovery only for an exact already-signed D02
 * claim; the controller must therefore be able to replay those identical bytes
 * after expiry without minting a replacement claim. */
export function verifyPersistedExternalClaimSignature(input: SignedExternalAttestation, publicConfig: PublicAuthorityConfig): void {
  const claim = ExternalAttestationSchema.parse(input);
  const authorityName = authorityForClaim(claim);
  const authority = PublicAuthorityConfigSchema.parse(publicConfig)[authorityName];
  const expectedScenario = claim.evidence.kind === "a03_http_response_loss" ? "V-A03" : claim.evidence.kind === "p01_platform_plugin_task" ? "V-P01" : "V-D02";
  const issuedAt = new Date(claim.issued_at).getTime();
  const expiresAt = new Date(claim.expires_at).getTime();
  if (claim.issuer !== authority.issuer || claim.authority_key_id !== authority.key_id || claim.evidence.authority !== authorityName
    || claim.scenario_id !== expectedScenario || claim.jti !== claim.attestation_id || claim.audience !== "sophia-voice-lab-attestation"
    || claim.signature_algorithm !== "ed25519-sha256-canonical-request-v1" || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || expiresAt <= issuedAt || expiresAt - issuedAt > 900_000) {
    throw new Error("Persisted external attestation authority, scenario, key, JTI, audience, or structural time binding is invalid.");
  }
  const publicKey = createPublicKey({ key: Buffer.from(authority.public_key_spki_base64, "base64"), format: "der", type: "spki" });
  const valid = ed25519Verify(null, Buffer.from(canonicalRequestHash(stripSignature(claim)), "hex"), publicKey, Buffer.from(claim.signature, "base64url"));
  if (!valid) throw new Error("Persisted external attestation signature verification failed.");
}

async function requestAttestationWithExactRetry(input: {
  endpoint: URL;
  claim: SignedExternalAttestation;
  bearer: string;
  fetchImpl: typeof fetch;
  ordinal: 1 | 2;
  retry: Required<AttestationRetryPolicy>;
}): Promise<AttestationResponseCheckpoint> {
  let lastRetryable: Error | null = null;
  for (let attempt = 1; attempt <= input.retry.maxAttempts; attempt += 1) {
    try {
      let response: Response;
      try {
        response = await input.fetchImpl(input.endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: {
            accept: "application/json",
            authorization: `Bearer ${input.bearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input.claim),
        });
      } catch (error) {
        throw new RetryableAttestationError("Attestation transport ended without an unambiguous response.", error);
      }
      let bytes: Buffer;
      try {
        bytes = await readBoundedResponse(response);
      } catch (error) {
        throw new RetryableAttestationError("Attestation response was ambiguous while reading its bounded body.", error);
      }
      if (response.status !== 200) {
        const code = attestationErrorCode(bytes);
        if (isRetryableAttestationFailure(response.status, code)) throw new RetryableAttestationError(`Attestation endpoint is pending or ambiguous (HTTP ${response.status}, ${code ?? "no_code"}).`);
        throw new Error(`Attestation endpoint rejected the exact claim (HTTP ${response.status}, ${code ?? "no_code"}).`);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString("utf8")); }
      catch (error) { throw new RetryableAttestationError("Attestation endpoint returned an ambiguous invalid-JSON success response.", error); }
      const envelope = AttestationReceiptSchema.parse(parsed);
      assertExpiredD02GatewayRecovery(envelope, input.claim);
      assertReceiptBinding(envelope, input.claim, input.ordinal === 2);
      return AttestationResponseCheckpointSchema.parse({ ordinal: input.ordinal, response_sha256: sha256(bytes), envelope });
    } catch (error) {
      const retryable = error instanceof RetryableAttestationError;
      if (!retryable) throw error;
      lastRetryable = error instanceof Error ? error : new Error("Attestation request was ambiguous.");
      if (attempt >= input.retry.maxAttempts) break;
      await input.retry.sleep(input.retry.intervalMs);
    }
  }
  throw new Error(`Exact signed attestation remained pending or ambiguous after ${input.retry.maxAttempts} bounded attempts.`, { cause: lastRetryable ?? undefined });
}

function assertExpiredD02GatewayRecovery(receipt: z.infer<typeof AttestationReceiptSchema>, claim: SignedExternalAttestation): void {
  const isBrowserWorkerCommand = claim.evidence.kind === "d02_browser_worker_termination_command";
  const isApiContinuityClaim = claim.evidence.kind === "d02_restart_command" || claim.evidence.kind === "d02_api_process_restart";
  const expired = new Date(claim.expires_at).getTime() <= Date.now();
  const gatewayFreezeReplay = receipt.data.gateway_freeze_idempotent_replay === true;
  const gatewayContinuityReplay = receipt.data.gateway_continuity_idempotent_replay === true;
  if (gatewayFreezeReplay && (!isBrowserWorkerCommand || !expired)) throw new Error("Gateway freeze replay evidence appeared outside an expired D02 browser-worker command recovery.");
  if (gatewayContinuityReplay && (!isApiContinuityClaim || !expired)) throw new Error("Gateway continuity replay evidence appeared outside an expired D02 API-restart recovery.");
  if (isBrowserWorkerCommand && expired && receipt.data.replay !== true && !gatewayFreezeReplay) throw new Error("Expired D02 browser-worker command recovery did not prove an exact attestation replay or an already-committed Gateway freeze replay.");
  if (isApiContinuityClaim && expired && receipt.data.replay !== true && !gatewayContinuityReplay) throw new Error("Expired D02 API-restart recovery did not prove an exact attestation replay or an already-committed Gateway continuity replay.");
}

class RetryableAttestationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RetryableAttestationError";
  }
}

function normalizeRetryPolicy(value: AttestationRetryPolicy | undefined): Required<AttestationRetryPolicy> {
  if (value === undefined) return { maxAttempts: 1, intervalMs: 0, sleep: async () => undefined };
  if (!Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 1_024) throw new Error("Attestation retry attempts are outside the bounded controller contract.");
  if (!Number.isSafeInteger(value.intervalMs) || value.intervalMs < 0 || value.intervalMs > 60_000) throw new Error("Attestation retry interval is outside the bounded controller contract.");
  return { maxAttempts: value.maxAttempts, intervalMs: value.intervalMs, sleep: value.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))) };
}

function isRetryableAttestationFailure(status: number, code: string | null): boolean {
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  return code !== null && (code.endsWith("_PENDING") || code.endsWith("_UNAVAILABLE"));
}

function attestationErrorCode(bytes: Buffer): string | null {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.code === "string") return record.code;
    const error = record.error;
    return error && typeof error === "object" && !Array.isArray(error) && typeof (error as Record<string, unknown>).code === "string"
      ? String((error as Record<string, unknown>).code)
      : null;
  } catch { return null; }
}

function assertReceiptBinding(receipt: z.infer<typeof AttestationReceiptSchema>, claim: SignedExternalAttestation, replay: boolean): void {
  if (receipt.run_id !== claim.run_id || receipt.data.attestation_id !== claim.attestation_id || receipt.data.attestation_kind !== claim.evidence.kind || receipt.event_cursor < receipt.data.event_seq) throw new Error("Attestation receipt did not bind the exact signed run, kind, and event sequence.");
  if (canonicalRequestHash(receipt.deployment_identity.expected) !== canonicalRequestHash(claim.expected_deployment)) throw new Error("Attestation receipt deployment identity does not match the signed claim.");
  if (replay && receipt.data.replay !== true) throw new Error("Second attestation POST was not acknowledged as an exact immutable replay.");
}

export async function executeA03LostResponse(input: {
  controller: A03ControllerInput;
  mcpBearer: string;
  fetchImpl?: typeof fetch;
  allowHttpForTest?: boolean;
  now?: () => Date;
  requestIds?: readonly [string, string];
}): Promise<A03ExecutionRecord> {
  if (Buffer.byteLength(input.mcpBearer) < 32) throw new Error("MCP bearer credential is invalid.");
  const controller = input.controller;
  const endpoint = exactEndpoint(controller.mcp_url, "/mcp", input.allowHttpForTest === true);
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const [initialClientRequestId, retryClientRequestId] = input.requestIds ?? [randomUUID(), randomUUID()];
  if (initialClientRequestId === retryClientRequestId || !isUuidV4(initialClientRequestId) || !isUuidV4(retryClientRequestId)) throw new Error("A03 requires two distinct UUIDv4 client request identities.");

  const jsonRpc = (id: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "speak", arguments: controller.speak_arguments } });
  const commonHeaders = { accept: "application/json, text/event-stream", authorization: `Bearer ${input.mcpBearer}`, "content-type": "application/json" };
  const initial = await fetchImpl(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
    headers: { ...commonHeaders, "x-sophia-voice-lab-client-request-id": initialClientRequestId },
    body: JSON.stringify(jsonRpc(`a03-initial-${initialClientRequestId}`)),
  });
  if (initial.status !== 200 || !initial.body) throw new Error(`Initial A03 MCP request did not reach an HTTP 200 response boundary (HTTP ${initial.status}).`);
  const reader = initial.body.getReader();
  const firstChunk = await reader.read();
  if (firstChunk.done || !firstChunk.value || firstChunk.value.byteLength === 0) throw new Error("Initial A03 response closed before the durable response-write boundary was observed.");
  // Deliberately retain zero bytes and never parse the application response.
  const responseLostAt = now();
  firstChunk.value.fill(0);
  await reader.cancel("intentional-v-a03-response-loss").catch(() => undefined);

  const retryAt = now();
  const retry = await fetchImpl(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
    headers: { ...commonHeaders, "x-sophia-voice-lab-client-request-id": retryClientRequestId },
    body: JSON.stringify(jsonRpc(`a03-retry-${retryClientRequestId}`)),
  });
  const retryBytes = await readBoundedResponse(retry);
  if (retry.status !== 200) throw new Error(`A03 retry returned HTTP ${retry.status}.`);
  const structured = McpEnvelopeSchema.parse(extractMcpStructuredContent(retryBytes, retry.headers.get("content-type")));
  const retryObservedAt = now();
  const scheduleReceipt = structured.data.schedule_receipt;
  const acceptedAt = scheduleReceipt && typeof scheduleReceipt === "object" && typeof (scheduleReceipt as Record<string, unknown>).observed_at === "string"
    ? String((scheduleReceipt as Record<string, unknown>).observed_at)
    : null;
  if (!acceptedAt || Number.isNaN(new Date(acceptedAt).getTime())) throw new Error("A03 replay response lacks the original page scheduling timestamp needed for the durable acceptance join.");
  if (structured.run_id !== controller.run.run_id || structured.operation_id === null || structured.status !== "completed" || structured.data.operation_state !== "succeeded" || structured.data.replay !== true) throw new Error("A03 retry did not return the original succeeded operation as an exact replay.");
  return A03ExecutionRecordSchema.parse({
    schema: "sophia_voice_lab_a03_external_client_record_v1",
    run_id: controller.run.run_id,
    tool_name: "speak",
    argument_sha256: canonicalRequestHash(controller.speak_arguments),
    idempotency_key_sha256: sha256(controller.speak_arguments.idempotency_key),
    initial_client_request_id_sha256: sha256(initialClientRequestId),
    retry_client_request_id_sha256: sha256(retryClientRequestId),
    initial_http_status: initial.status,
    retry_http_status: retry.status,
    initial_application_response_observed: false,
    initial_body_bytes_retained: 0,
    transport_outcome: "connection_closed_after_durable_acceptance",
    operation_id: structured.operation_id,
    retry_result_request_id_sha256: sha256(structured.request_id),
    retry_response_sha256: canonicalRequestHash(structured),
    accepted_at: new Date(acceptedAt).toISOString(),
    response_lost_at: responseLostAt.toISOString(),
    retry_at: retryAt.toISOString(),
    retry_observed_at: retryObservedAt.toISOString(),
    retry_status: structured.status,
    retry_operation_state: structured.data.operation_state,
    retry_flag: structured.data.replay,
    effect_join_status: "requires_product_authored_operation_lineage",
  });
}

export function extractMcpStructuredContent(bytes: Buffer, contentType: string | null): unknown {
  const text = bytes.toString("utf8");
  const candidates: unknown[] = [];
  if (contentType?.includes("text/event-stream") || text.trimStart().startsWith("event:") || text.includes("\ndata:")) {
    for (const block of text.split(/\r?\n\r?\n/u)) {
      const payload = block.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!payload || payload === "[DONE]") continue;
      try { candidates.push(JSON.parse(payload) as unknown); } catch { /* ignore non-terminal SSE fragments */ }
    }
  } else {
    try { candidates.push(JSON.parse(text) as unknown); } catch { /* handled below */ }
  }
  for (const candidate of candidates.reverse()) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    if (record.error) throw new Error("MCP returned a JSON-RPC error at the A03 retry boundary.");
    const result = record.result;
    if (result && typeof result === "object" && (result as Record<string, unknown>).structuredContent !== undefined) return (result as Record<string, unknown>).structuredContent;
  }
  throw new Error("MCP response did not contain one structured tool envelope.");
}

export async function callMcpTool(input: {
  mcpUrl: string;
  bearer: string;
  toolName: string;
  arguments: Record<string, unknown>;
  clientRequestId?: string;
  fetchImpl?: typeof fetch;
  allowHttpForTest?: boolean;
  timeoutMs?: number;
}): Promise<{ envelope: z.infer<typeof McpEnvelopeSchema>; responseSha256: string; httpStatus: number }> {
  const endpoint = exactEndpoint(input.mcpUrl, "/mcp", input.allowHttpForTest === true);
  const clientRequestId = input.clientRequestId ?? randomUUID();
  const body = { jsonrpc: "2.0", id: `controller-${clientRequestId}`, method: "tools/call", params: { name: input.toolName, arguments: input.arguments } };
  const response = await (input.fetchImpl ?? fetch)(endpoint, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(input.timeoutMs ?? 180_000),
    headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${input.bearer}`, "content-type": "application/json", "x-sophia-voice-lab-client-request-id": clientRequestId },
    body: JSON.stringify(body),
  });
  const bytes = await readBoundedResponse(response);
  if (response.status !== 200) throw new Error(`MCP tool call returned HTTP ${response.status}.`);
  const envelope = McpEnvelopeSchema.parse(extractMcpStructuredContent(bytes, response.headers.get("content-type")));
  return { envelope, responseSha256: canonicalRequestHash(envelope), httpStatus: response.status };
}

export function exactEndpoint(baseUrl: string, pathname: string, allowHttpForTest = false): URL {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error("Controller endpoint must not contain credentials, query, or fragment.");
  if (url.protocol !== "https:" && !(allowHttpForTest && url.protocol === "http:")) throw new Error("Controller endpoint must use HTTPS.");
  const normalizedBasePath = url.pathname.replace(/\/$/u, "");
  if (normalizedBasePath && normalizedBasePath !== pathname) throw new Error(`Controller endpoint path must be exactly ${pathname} or a bare origin.`);
  url.pathname = pathname;
  return url;
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("Controller HTTP response exceeded the two-megabyte cap.");
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
