import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { expect } from "vitest";
import type { RecoveryControlRecord } from "../src/recovery-control.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";
import { deriveRetainedD02SettlementLookup, verifyRetainedD02ProviderSettlement } from "../src/retained-d02-provider.js";
import { verifyCombinedRecoveryFixture } from "./retained-d02-recovery-helper.js";

export function verifyRetainedProviderFixture(control: RecoveryControlRecord) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const encoded = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const authority = { keyId: "gateway-test-v1", publicKeySpkiBase64: encoded, publicKeysById: { "gateway-test-v1": encoded } };
  const b = control.binding, j = control.d02Journal!, o = control.d02OwnerDeath!;
  const lookup = deriveRetainedD02SettlementLookup(control);
  expect(lookup).toMatchObject({ cleanup_obligation_id: b.cleanupObligationId,
    termination_request_id_sha256: j.terminationRequestIdSha256, provider_session_id_sha256: j.providerSessionIdSha256,
    render_action_accepted_response_sha256: o.actionAcceptedResponseSha256, loss_event_seq: o.lossEventSeq });
  expect(JSON.stringify(lookup)).not.toContain(b.testRunId);
  expect(lookup).not.toHaveProperty("provider_session_id");
  expect(lookup).not.toHaveProperty("termination_request_id");
  expect(() => deriveRetainedD02SettlementLookup({ ...control, d02OwnerDeath: undefined })).toThrow();
  const now = new Date(Math.max(Date.now(), Date.parse(o.settledAt), Date.parse(o.lossObservedAt)) + 1);
  const id = randomUUID();
  const core = {
    schema: "sophia_voice_lab_gateway_browser_worker_termination_settlement_v1",
    receipt_id: id, jti: id, termination_request_id_sha256: j.terminationRequestIdSha256,
    voice_lab_run_id_sha256: sha256(b.runId), test_run_id_sha256: sha256(b.testRunId), cleanup_obligation_id_sha256: sha256(b.cleanupObligationId),
    principal_id_hmac: sha256("synthetic-principal-hmac"), scenario_id: b.scenarioId, scenario_version: b.scenarioVersion,
    environment: b.environment, expected_deployment: b.expectedDeployment,
    provider_session_id_sha256: j.providerSessionIdSha256, provider_admission_id_sha256: j.providerAdmissionIdSha256,
    provider_connection_epoch: j.providerConnectionEpoch, frozen_provider_connection_epochs: j.frozenProviderConnectionEpochs,
    browser_worker_id_sha256: j.workerIdSha256, browser_lease_epoch: j.browserLeaseEpoch, browser_context_id_sha256: j.browserContextIdSha256,
    render_action_request_sha256: j.actionRequestSha256, render_action_accepted_response_sha256: o.actionAcceptedResponseSha256,
    render_action_settled_snapshot_sha256: o.actionSettledSnapshotSha256, loss_event_seq: o.lossEventSeq, loss_observed_at: o.lossObservedAt,
    voice_terminal_receipts_sha256: sha256("synthetic-terminals"), provider_settlement_sha256: sha256("synthetic-provider-settlement"),
    cleanup_obligation_state: "closed", canonical_provider_state: "closed", canonical_pending_epoch: null,
    all_frozen_provider_epochs_terminal: true, provider_admission_absent: true, voice_provider_session_absent: true, gateway_browser_relay_absent: true,
    database_observed_at: now.toISOString(), issued_at: now.toISOString(), expires_at: new Date(now.getTime() + 60_000).toISOString(),
    issuer: "sophia-gateway", audience: "sophia-voice-lab-d02-gateway-settlement", authority_key_id: authority.keyId,
    nonce: "synthetic_nonce_000000000000000000000000", signature_algorithm: "ed25519-sha256-canonical-request-v1",
  };
  const signed = (patch: Record<string, unknown> = {}) => {
    const value = { ...core, ...patch };
    return { ...value, signature: sign(null, Buffer.from(canonicalRequestHash(value), "hex"), privateKey).toString("base64url") };
  };
  const proof = verifyRetainedD02ProviderSettlement(control, signed(), authority, now);
  verifyCombinedRecoveryFixture({ ...control, d02ProviderSettlement: proof });
  expect(proof).toMatchObject({ providerCleanupProven: true, authCleanupProven: false, builderCleanupProven: false, liveResourcesZeroProven: false, ownerDeathProofSha256: o.proofSha256 });
  expect(JSON.stringify(proof)).not.toContain(b.runId);
  for (const key of ["voice_lab_run_id_sha256", "test_run_id_sha256", "cleanup_obligation_id_sha256", "termination_request_id_sha256",
    "provider_session_id_sha256", "provider_admission_id_sha256", "browser_worker_id_sha256", "browser_context_id_sha256",
    "render_action_request_sha256", "render_action_accepted_response_sha256", "render_action_settled_snapshot_sha256"]) {
    expect(() => verifyRetainedD02ProviderSettlement(control, signed({ [key]: sha256(`different-${key}`) }), authority, now)).toThrow("RETAINED_D02_PROVIDER_BINDING_MISMATCH");
  }
  for (const patch of [{ loss_event_seq: o.lossEventSeq + 1 }, { browser_lease_epoch: j.browserLeaseEpoch + 1 },
    { environment: b.environment === "production" ? "staging" : "production" }, { scenario_version: "different.version" },
    { database_observed_at: new Date(Date.parse(o.settledAt) - 1).toISOString(), issued_at: new Date(Date.parse(o.settledAt) - 1).toISOString() }]) {
    expect(() => verifyRetainedD02ProviderSettlement(control, signed(patch), authority, now)).toThrow("RETAINED_D02_PROVIDER_BINDING_MISMATCH");
  }
  expect(() => verifyRetainedD02ProviderSettlement(control, { ...signed(), signature: "a".repeat(86) }, authority, now)).toThrow();
  expect(() => verifyRetainedD02ProviderSettlement(control, signed(), null, now)).toThrow();
  expect(() => verifyRetainedD02ProviderSettlement({ ...control, d02OwnerDeath: undefined } as unknown as RecoveryControlRecord, signed(), authority, now)).toThrow();
  return { receipt: signed(), authority, proof };
}
