import { z } from "zod";

import { sha256 } from "../../src/security.js";
import {
  A03ExecutionRecordSchema,
  type A03ExecutionRecord,
  type PublicAuthorityConfig,
  type SignedExternalAttestation,
} from "./contracts.js";
import { newUnsignedClaim, signExternalClaim } from "./crypto.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const A03ManifestProjectionSchema = z.object({
  run_id: z.string().uuid(),
  test_run_id: z.string().uuid(),
  cleanup_obligation: z.object({ cleanup_obligation_id_sha256: Sha256Schema }).passthrough(),
  environment: z.enum(["production", "staging"]),
  scenario: z.object({ id: z.literal("V-A03"), version: z.literal("vt00.scenarios.v1") }).passthrough(),
  deployment_identity: z.object({ expected: z.object({ frontend: z.string().regex(/^[a-f0-9]{40}$/), backend: z.string().regex(/^[a-f0-9]{40}$/), voice: z.string().regex(/^[a-f0-9]{40}$/) }).strict() }).passthrough(),
  operations: z.array(z.object({
    operation_id: z.string().uuid(),
    type: z.string(),
    state: z.string(),
    idempotency_key_hash: Sha256Schema,
    request_hash: Sha256Schema,
  }).passthrough()),
  authorization_audit: z.array(z.object({
    action: z.string(),
    argument_hash: Sha256Schema,
    outcome: z.string(),
    detail: z.record(z.string(), z.unknown()),
    observed_at: z.string().datetime({ offset: true }),
  }).passthrough()),
}).passthrough();

/** Build the source attestation only after the terminal immutable manifest is
 * available. This is where the controller joins its lost-response transcript
 * to the server-owned operation hash and both durable HTTP response audits. */
export async function buildA03ClaimFromManifest(input: {
  record: A03ExecutionRecord;
  manifest: unknown;
  publicConfig: PublicAuthorityConfig;
  externalClientPrivateKeyPath: string;
  now?: Date;
}): Promise<SignedExternalAttestation> {
  const record = A03ExecutionRecordSchema.parse(input.record);
  const manifest = A03ManifestProjectionSchema.parse(input.manifest);
  if (manifest.run_id !== record.run_id || sha256(manifest.test_run_id).length !== 64) throw new Error("A03 client record and terminal manifest identify different runs.");
  const operations = manifest.operations.filter((operation) => operation.operation_id === record.operation_id);
  if (operations.length !== 1 || operations[0]!.type !== "speak" || operations[0]!.state !== "succeeded" || operations[0]!.idempotency_key_hash !== record.idempotency_key_sha256) throw new Error("A03 terminal manifest lacks the exact succeeded speak operation.");
  const operation = operations[0]!;
  const audits = manifest.authorization_audit.filter((audit) => audit.action === "mcp.tool_response" && audit.outcome === "allowed" && audit.detail.tool === "speak"
    && [record.initial_client_request_id_sha256, record.retry_client_request_id_sha256].includes(String(audit.detail.client_request_id_hash)));
  if (audits.length !== 2 || new Set(audits.map((audit) => audit.detail.client_request_id_hash)).size !== 2) throw new Error("A03 terminal manifest lacks the two distinct durable client-request response audits.");
  const first = audits.find((audit) => audit.detail.client_request_id_hash === record.initial_client_request_id_sha256);
  const retry = audits.find((audit) => audit.detail.client_request_id_hash === record.retry_client_request_id_sha256);
  if (!first || !retry || first.detail.replay !== false || retry.detail.replay !== true || first.detail.operation_id_sha256 !== sha256(record.operation_id) || retry.detail.operation_id_sha256 !== sha256(record.operation_id) || retry.detail.response_sha256 !== record.retry_response_sha256) throw new Error("A03 response audits do not match the independently observed original/replay operation and response.");
  const orderedTimes = [record.accepted_at, first.observed_at, record.response_lost_at, record.retry_at, retry.observed_at, record.retry_observed_at].map((value) => new Date(value).getTime());
  if (orderedTimes.some((value, index) => index > 0 && value < orderedTimes[index - 1]!)) throw new Error("A03 independent client and owning server audit timestamps are not monotonically joinable.");
  // HTTP audits own the public speak arguments. The operation hash separately
  // owns the server-augmented request with its required `_admission` record.
  // Never collapse the two domains or substitute the client hash for the
  // durable operation hash carried by the signed evidence.
  if (first.argument_hash !== record.argument_sha256 || retry.argument_hash !== record.argument_sha256) throw new Error("A03 public HTTP audit hashes do not match the independently submitted speak arguments.");
  const now = input.now ?? new Date();
  const evidence = {
    kind: "a03_http_response_loss" as const,
    authority: "external_mcp_client" as const,
    operation_id: record.operation_id,
    replayed_operation_id: record.operation_id,
    request_sha256: operation.request_hash,
    idempotency_key_sha256: record.idempotency_key_sha256,
    initial_client_request_id_sha256: record.initial_client_request_id_sha256,
    retry_client_request_id_sha256: record.retry_client_request_id_sha256,
    retry_response_sha256: record.retry_response_sha256,
    accepted_at: record.accepted_at,
    response_lost_at: record.response_lost_at,
    retry_at: record.retry_at,
    transport_outcome: "connection_closed_after_durable_acceptance" as const,
    initial_response_observed: false as const,
  };
  const unsigned = newUnsignedClaim({
    run: {
      run_id: manifest.run_id,
      test_run_id_sha256: sha256(manifest.test_run_id),
      cleanup_obligation_id_sha256: manifest.cleanup_obligation.cleanup_obligation_id_sha256,
      scenario_id: "V-A03",
      scenario_version: "vt00.scenarios.v1",
      environment: manifest.environment,
      expected_deployment: manifest.deployment_identity.expected,
    },
    authority: "external_mcp_client",
    publicConfig: input.publicConfig,
    evidence,
    now,
  });
  return signExternalClaim(unsigned, input.publicConfig, input.externalClientPrivateKeyPath, now);
}
