import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createHttpApp, listen } from "../src/http-server.js";
import { VoiceLabService } from "../src/service.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CompositeRequestAuthenticator, StaticAttestationAuthenticator, StaticBearerAuthenticator, canonicalRequestHash, sha256 } from "../src/security.js";
import { testConfig, testRun } from "./helpers.js";
import { genericOwnerLossDispatchFromControl } from "../src/generic-owner-dispatch.js";

it("restricts retained owner dispatch HTTP access to the closed, exact deployment-control lane", async () => {
  const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true", SOPHIA_VOICE_LAB_GENERIC_RECOVERY_WORKER_SERVICE_ID: "srv-0123456789abcdefghij" });
  const ledger = new MemoryVoiceLabLedger("test");
  const service = new VoiceLabService(ledger, config, async () => []);
  const names = ["external_mcp_client", "deployment_control", "platform_plugin"] as const;
  const entries = Object.fromEntries(names.map(name => [name, { token: config.attestationTransportTokens![name], subject: config.attestationAuthorities[name].subject }])) as ConstructorParameters<typeof StaticAttestationAuthenticator>[0];
  const auth = new CompositeRequestAuthenticator([new StaticAttestationAuthenticator(entries), new StaticBearerAuthenticator(config.bearerToken, "ordinary-caller", config.faultBearerToken)]);
  const server = await listen(createHttpApp(config, service, ledger, auth), 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  const endpoint = `http://127.0.0.1:${address.port}/internal/voice-lab/recovery/owner-dispatch`;
  const run = testRun({ state: "failed_harness", retentionPurgeDueAt: new Date(0) });
  config.readinessTarget = run.target;
  const signingPair = generateKeyPairSync("ed25519");
  config.attestationAuthorities.deployment_control.publicKeySpkiBase64 = signingPair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
  const lease = await ledger.upsertBrowserLease(run.id, "http-owner", 60);
  await ledger.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch);
  const prepareSpy = vi.spyOn(ledger, "prepareGenericOwnerDispatch");
  const consumeSpy = vi.spyOn(ledger, "consumeGenericOwnerDispatch");
  const initial = (await ledger.getRecoveryControl(run.id))!;
  const body = { action: "prepare", runId: run.id, expectedVersion: initial.version, requestId: randomUUID() };
  const token = entries.deployment_control.token;
  const post = (value: unknown, bearer: string | null = token) => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(value) });
  try {
    for (const [bearer, status] of [[null, 401], ["invalid", 401], [config.bearerToken, 403], [config.faultBearerToken, 403], [entries.external_mcp_client.token, 403], [entries.platform_plugin.token, 403]] as const) {
      const response = await post(body, bearer);
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(run.id);
      expect((await post({ action: "ingest_owner_loss", runId: run.id, expectedVersion: initial.version, receipt: {} }, bearer)).status).toBe(status);
    }
    config.killSwitch = false;
    expect((await post(body)).status).toBe(409);
    config.killSwitch = true;
    const configuredService = config.genericRecoveryWorkerServiceId;
    config.genericRecoveryWorkerServiceId = null;
    expect((await post(body)).status).toBe(409);
    config.genericRecoveryWorkerServiceId = configuredService;
    for (const binding of [
      { ...initial.binding, principalId: "foreign-principal" },
      { ...initial.binding, environment: "staging" as const },
      { ...initial.binding, scenarioId: "V-D02" },
    ]) {
      vi.spyOn(ledger, "getRecoveryControl").mockResolvedValueOnce({ ...initial, binding });
      expect((await post(body)).status).toBe(403);
    }
    expect((await post({ ...body, workerServiceId: "srv-foreign" })).status).toBe(409);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(consumeSpy).not.toHaveBeenCalled();
    expect(await ledger.getRecoveryControl(run.id)).toEqual(initial);
    const response = await post(body);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const prepared = await response.json();
    expect(prepared.dispatchAllowed).toBe(false);
    expect(prepared.workerServiceId).toBe(config.genericRecoveryWorkerServiceId);
    const consume = { action: "consume", runId: run.id, expectedVersion: prepared.control.version, preparedProofSha256: prepared.control.genericOwnerDispatch.proofSha256 };
    const replies = await Promise.all(Array.from({ length: 4 }, async () => (await post(consume)).json()));
    expect(replies.filter(reply => reply.dispatchAllowed)).toHaveLength(1);
    await ledger.purgeExpiredRetention(new Date(), 10);
    expect(await ledger.getRun(run.id)).toBeNull();
    expect((await (await post(consume)).json()).dispatchAllowed).toBe(false);
    expect((await (await post({ action: "inspect", runId: run.id })).json()).control.genericOwnerDispatch.consumedAt).not.toBeNull();
    const retained = (await ledger.getRecoveryControl(run.id))!;
    const dispatch = genericOwnerLossDispatchFromControl(retained);
    const authority = config.attestationAuthorities.deployment_control;
    const observedAt = new Date().toISOString();
    const snapshot = { serviceResponseSha256: sha256("service"), deployResponseSha256: sha256("deploy"), instanceResponseSha256: sha256("inventory"), deployIdSha256: sha256("deploy-id"), deployStatus: "live" };
    const unsigned = { schema: "sophia.voice-lab.generic-owner-loss-receipt.v1", receiptId: body.requestId,
      authority: "deployment_control", issuer: authority.issuer, subject: authority.subject, authorityKeyId: authority.keyId,
      audience: "sophia-voice-lab-generic-owner-loss", ...dispatch,
      expectedLabSha: config.serviceVersion, expectedLangGraphSha: run.target.expectedDependencies.langgraph,
      workerIdSha256: sha256("http-owner"), browserLeaseEpoch: lease.leaseEpoch,
      actionAcceptedResponseSha256: sha256("accepted"), actionHttpStatus: 200, actionAcceptedAt: observedAt,
      before: { ...snapshot, instanceIdsSha256: [sha256("http-owner")], instanceCreatedAt: retained.binding.createdAt, observedAt: dispatch.actionRequestedAt },
      after: { ...snapshot, instanceIdsSha256: [sha256("replacement")], instanceCreatedAt: observedAt, observedAt },
      providerCleanupProven: false, liveResourcesZeroProven: false, issuedAt: observedAt, expiresAt: new Date(Date.now() + 60000).toISOString(), signatureAlgorithm: "ed25519-sha256-canonical-request-v1" };
    const receipt = { ...unsigned, signature: sign(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), signingPair.privateKey).toString("base64url") };
    const ingestion = { action: "ingest_owner_loss", runId: run.id, expectedVersion: retained.version, receipt };
    expect((await post({ ...ingestion, receipt: { ...receipt, expectedLabSha: "f".repeat(40) } })).status).toBe(409);
    expect((await post({ ...ingestion, expectedVersion: retained.version + 1 })).status).toBe(409);
    config.killSwitch = false;
    expect((await post(ingestion)).status).toBe(409);
    config.killSwitch = true;
    config.readinessTarget = null;
    expect((await post(ingestion)).status).toBe(409);
    config.readinessTarget = { ...run.target, expectedDeployment: { ...run.target.expectedDeployment, voice: "f".repeat(40) } };
    expect((await post(ingestion)).status).toBe(409);
    config.readinessTarget = run.target;
    expect(await ledger.getRecoveryControl(run.id)).toEqual(retained);
    const accepted = await post(ingestion);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    const acceptedBody = await accepted.json();
    expect(acceptedBody.control.genericOwnerLoss).toMatchObject({ signedReceiptSha256: canonicalRequestHash(receipt), providerCleanupProven: false, liveResourcesZeroProven: false });
    expect(acceptedBody.control.liveCleanupComplete).toBe(false);
    expect(await (await post(ingestion)).json()).toEqual(acceptedBody);
    const proofAudit = await ledger.listAuthAuditByArgumentHashes(entries.deployment_control.subject, [canonicalRequestHash(ingestion)], new Date(0));
    expect(proofAudit.some(audit => audit.detail?.owner_loss_proof_sha256 === acceptedBody.control.genericOwnerLoss.proofSha256)).toBe(true);
    expect(JSON.stringify(proofAudit)).not.toContain(receipt.signature);
    const audits = await ledger.listAuthAuditByArgumentHashes(entries.deployment_control.subject, [canonicalRequestHash(consume)], new Date(0));
    expect(audits.some(audit => audit.detail?.dispatch_allowed === true)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(token);
    const malformed = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{" });
    expect(malformed.status).toBe(400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it("defaults generic worker recovery off and rejects malformed service configuration", () => {
  expect(testConfig().genericRecoveryWorkerServiceId).toBeNull();
  expect(testConfig().genericRecoveryReceiptSha256).toBeNull();
  expect(testConfig({ SOPHIA_VOICE_LAB_GENERIC_RECOVERY_RECEIPT_SHA256: "a".repeat(64) }).genericRecoveryReceiptSha256).toBe("a".repeat(64));
  expect(() => testConfig({ SOPHIA_VOICE_LAB_GENERIC_RECOVERY_RECEIPT_SHA256: "not-a-digest" })).toThrow();
  expect(() => testConfig({ SOPHIA_VOICE_LAB_GENERIC_RECOVERY_WORKER_SERVICE_ID: "https://untrusted.invalid/" })).toThrow();
});
