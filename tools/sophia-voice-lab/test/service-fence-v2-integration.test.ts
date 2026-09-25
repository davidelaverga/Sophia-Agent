import { expect, it, vi } from "vitest";

import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { VoiceLabService } from "../src/service.js";
import { createHttpApp, listen } from "../src/http-server.js";
import { CompositeRequestAuthenticator, StaticAttestationAuthenticator, StaticBearerAuthenticator, canonicalRequestHash, sha256 } from "../src/security.js";
import { ingestGenericOwnerLoss } from "../src/generic-owner-loss.js";
import { deriveExecutionEpochCleanupProof } from "../src/execution-cleanup.js";
import { PLATFORM_EXECUTION_TERMINATION_KIND } from "../src/platform-execution-termination.js";
import { serviceOwnerFenceV2Fixture } from "./service-owner-fence-fixture.js";
import { recovery } from "./execution-cleanup-fixture.js";
import { testConfig, testRun } from "./helpers.js";
import type { LabEvent, RunRecord } from "../src/domain.js";

/**
 * Collector receipt -> authenticated HTTP ingestion -> retained v2 proof ->
 * canonical platform-termination event -> cleanup evaluator. The termination
 * event is written by production code, never constructed by the test.
 */
it("settles an owner-lost epoch end to end through the real ingestion boundary", async () => {
  const f = serviceOwnerFenceV2Fixture(new Date(Date.now() - 370_000));
  const ledger = new MemoryVoiceLabLedger("test");
  let control = structuredClone(f.inputV2.control);
  const binding = control.binding;

  const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true",
    SOPHIA_VOICE_LAB_GENERIC_RECOVERY_WORKER_SERVICE_ID: f.serviceId });
  config.serviceVersion = f.unsignedV2.expectedLabSha;
  config.readinessTarget = { ...testRun().target, expectedDeployment: f.unsignedV2.expectedRecoveryDeployment,
    expectedDependencies: { langgraph: f.unsignedV2.expectedLangGraphSha } };
  const authority = f.inputV2.authority;
  Object.assign(config.attestationAuthorities.deployment_control, { issuer: authority.issuer, subject: authority.subject,
    keyId: authority.key_id, publicKeySpkiBase64: authority.public_key_spki_base64 });

  // A real run whose ledger holds the genuine acquisition pair.
  const run: RunRecord = { ...testRun(), id: binding.runId, testRunId: binding.testRunId,
    cleanupObligationId: binding.cleanupObligationId, principalId: binding.principalId, environment: binding.environment };
  const events: LabEvent[] = [];
  vi.spyOn(ledger, "getRecoveryControl").mockImplementation(async () => structuredClone(control));
  vi.spyOn(ledger, "persistGenericOwnerLoss").mockImplementation(async input => {
    const result = ingestGenericOwnerLoss(control, input, new Date());
    if (!result.replay) control = { ...control, version: result.version, genericOwnerLoss: result.proof };
    return result;
  });
  vi.spyOn(ledger, "appendEvent").mockImplementation(async (runId, kind, source, payload, dedupeKey) => {
    const existing = dedupeKey ? events.find(event => event.dedupeKey === dedupeKey) : undefined;
    if (existing) return structuredClone(existing);
    const event: LabEvent = { runId, seq: events.length + 1, kind, source, payload: structuredClone(payload) as Record<string, unknown>,
      at: new Date(events.length * 1_000 + 1_000), dedupeKey: dedupeKey ?? null };
    events.push(event);
    return structuredClone(event);
  });

  const ownership = f.ownership;
  await ledger.appendEvent(run.id, "harness.browser_process_acquired", "browser", {
    schema: "sophia_voice_lab_browser_process_ownership_v1",
    voice_lab_run_id_sha256: sha256(run.id), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
    process_id_sha256: ownership.processIdSha256, browser_boot_id_sha256: ownership.browserBootIdSha256,
    execution_epoch_sha256: ownership.executionEpochSha256, one_process_per_run: true, raw_process_id_excluded: true });
  await ledger.appendEvent(run.id, "harness.browser_runtime_acquired", "canonical", {
    worker_id_sha256: ownership.workerIdSha256, browser_lease_epoch: ownership.browserLeaseEpoch });

  const names = ["external_mcp_client", "deployment_control", "platform_plugin"] as const;
  const entries = Object.fromEntries(names.map(name => [name, { token: config.attestationTransportTokens![name],
    subject: config.attestationAuthorities[name].subject }])) as ConstructorParameters<typeof StaticAttestationAuthenticator>[0];
  const auth = new CompositeRequestAuthenticator([new StaticAttestationAuthenticator(entries),
    new StaticBearerAuthenticator(config.bearerToken, "ordinary-caller", config.faultBearerToken)]);
  const server = await listen(createHttpApp(config, new VoiceLabService(ledger, config, async () => []), ledger, auth), 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  const body = { action: "ingest_service_fence", runId: binding.runId, expectedVersion: control.version, receipt: f.inputV2.receipt };
  const post = () => fetch(`http://127.0.0.1:${address.port}/internal/voice-lab/recovery/owner-dispatch`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${entries.deployment_control.token}` }, body: JSON.stringify(body) });

  try {
    // Before ingestion the epoch cannot settle: no browser close can ever exist.
    const before = deriveExecutionEpochCleanupProof(run, structuredClone(events));
    expect(before.ready).toBe(false);
    expect(before.reason).toBe("process_death_proof_invalid");

    const accepted = await post();
    expect(accepted.status).toBe(200);
    const result = await accepted.json();
    expect(result.control.genericOwnerLoss.schema).toBe("sophia.voice-lab.verified-service-owner-fence.v2");
    expect(result.control.genericOwnerLoss.executionEpochSha256).toBe(ownership.executionEpochSha256);
    // The full ownership identity must never leak through the boundary.
    expect(JSON.stringify(result)).not.toContain(f.owner);

    const terminations = events.filter(event => event.kind === PLATFORM_EXECUTION_TERMINATION_KIND);
    expect(terminations).toHaveLength(1);
    expect(terminations[0]!.source).toBe("canonical");
    expect(terminations[0]!.payload).toMatchObject({
      execution_epoch_sha256: ownership.executionEpochSha256,
      original_worker_id_sha256: ownership.workerIdSha256,
      owner_replacement_observed: true,
      browser_context_closed_fabricated: false,
      provider_cleanup_proven: false,
      live_resources_zero_proven: false,
      signed_receipt_sha256: canonicalRequestHash(f.inputV2.receipt),
    });

    // Owner loss alone is still not cleanup.
    const withoutRecovery = deriveExecutionEpochCleanupProof(run, structuredClone(events));
    expect(withoutRecovery.ready).toBe(false);
    expect(withoutRecovery.reason).toBe("provider_or_auth_cleanup_unconfirmed");

    // An exact retry replays one receipt; it never settles the epoch twice.
    expect((await post()).status).toBe(200);
    expect(events.filter(event => event.kind === PLATFORM_EXECUTION_TERMINATION_KIND)).toHaveLength(1);

    // Fresh authoritative downstream cleanup, after the termination.
    const settled = [...structuredClone(events), { ...recovery(run, events.length + 1), runId: run.id }];
    const proof = deriveExecutionEpochCleanupProof(run, settled as LabEvent[]);
    expect(proof.ready).toBe(true);
    expect(proof.reason).toBe("authoritative_platform_fence_after_owner_loss");
    expect(proof.executionEpochSha256).toBe(ownership.executionEpochSha256);
    expect(proof.eventSeqs.processClosed).toBeNull();
    expect(proof.eventSeqs.platformTerminated).toBe(terminations[0]!.seq);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
