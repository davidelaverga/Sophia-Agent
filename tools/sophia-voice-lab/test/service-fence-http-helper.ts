import { expect } from "vitest";
import type { VoiceLabLedger } from "../src/ledger.js";
import { VoiceLabService } from "../src/service.js";
import { createHttpApp, listen } from "../src/http-server.js";
import { CompositeRequestAuthenticator, StaticAttestationAuthenticator, StaticBearerAuthenticator, canonicalRequestHash } from "../src/security.js";
import { testConfig, testRun } from "./helpers.js";
import type { serviceOwnerFenceFixture } from "./service-owner-fence-fixture.js";
import { publishServiceOwnerFence } from "../scripts/external-attestations/service-owner-fence-publisher.js";

export async function verifyServiceFenceHttp(ledger: VoiceLabLedger, f: ReturnType<typeof serviceOwnerFenceFixture>) {
  const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true",
    SOPHIA_VOICE_LAB_GENERIC_RECOVERY_WORKER_SERVICE_ID: "srv-0123456789abcdefghij" });
  config.serviceVersion = f.unsigned.expectedLabSha;
  config.readinessTarget = { ...testRun().target, expectedDeployment: f.unsigned.expectedRecoveryDeployment,
    expectedDependencies: { langgraph: f.unsigned.expectedLangGraphSha } };
  const authority = f.input.authority;
  Object.assign(config.attestationAuthorities.deployment_control, { issuer: authority.issuer, subject: authority.subject,
    keyId: authority.key_id, publicKeySpkiBase64: authority.public_key_spki_base64 });
  const names = ["external_mcp_client", "deployment_control", "platform_plugin"] as const;
  const entries = Object.fromEntries(names.map(name => [name, { token: config.attestationTransportTokens![name],
    subject: config.attestationAuthorities[name].subject }])) as ConstructorParameters<typeof StaticAttestationAuthenticator>[0];
  const auth = new CompositeRequestAuthenticator([new StaticAttestationAuthenticator(entries), new StaticBearerAuthenticator(config.bearerToken, "ordinary-caller", config.faultBearerToken)]);
  const server = await listen(createHttpApp(config, new VoiceLabService(ledger, config, async () => []), ledger, auth), 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  const token = entries.deployment_control.token;
  const body = { action: "ingest_service_fence", runId: f.input.control.binding.runId,
    expectedVersion: f.input.control.version, receipt: f.input.receipt };
  const post = (value: unknown, bearer: string | null = token) => fetch(`http://127.0.0.1:${address.port}/internal/voice-lab/recovery/owner-dispatch`, {
    method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(value),
  });
  try {
    for (const [bearer, status] of [[null, 401], ["invalid", 401], [config.bearerToken, 403],
      [config.faultBearerToken, 403], [entries.external_mcp_client.token, 403], [entries.platform_plugin.token, 403]] as const) {
      expect((await post(body, bearer)).status).toBe(status);
    }
    const currentTarget = config.readinessTarget;
    config.killSwitch = false;
    expect((await post(body)).status).toBe(409);
    config.killSwitch = true;
    config.readinessTarget = null;
    expect((await post(body)).status).toBe(409);
    config.readinessTarget = { ...currentTarget, expectedDeployment: f.input.control.binding.expectedDeployment };
    expect((await post(body)).status).toBe(409);
    config.readinessTarget = currentTarget;
    expect((await post({ ...body, expectedVersion: body.expectedVersion + 1 })).status).toBe(409);
    expect((await post({ ...body, receipt: { ...body.receipt, signature: "a".repeat(86) } })).status).toBe(409);
    expect((await ledger.getRecoveryControl(body.runId))!.genericOwnerLoss).toBeUndefined();
    const accepted = await post(body);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    const result = await accepted.json();
    expect(result.control).toMatchObject({ liveCleanupComplete: false, binding: f.input.control.binding,
      genericOwnerLoss: { schema: "sophia.voice-lab.verified-service-owner-fence.v1", signedReceiptSha256: canonicalRequestHash(body.receipt) } });
    expect(JSON.stringify(result)).not.toContain(f.unsigned.allocatedWorkerId);
    expect(await (await post(body)).json()).toEqual(result);
    expect(await publishServiceOwnerFence({ runId: body.runId, workerServiceId: config.genericRecoveryWorkerServiceId!,
      voiceLabOrigin: `http://127.0.0.1:${address.port}`, receipt: body.receipt,
      expectedLabSha: config.serviceVersion, expectedLangGraphSha: f.unsigned.expectedLangGraphSha,
      expectedRecoveryDeployment: f.unsigned.expectedRecoveryDeployment,
      publicConfig: { deployment_control: authority }, deploymentBearer: token, allowHttpForTest: true }))
      .toEqual({ status: "ingested", proofSha256: result.control.genericOwnerLoss.proofSha256, replay: true, cleanupProven: false });
    const audits = await ledger.listAuthAuditByArgumentHashes(authority.subject, [canonicalRequestHash(body)], new Date(0));
    expect(audits.some(audit => audit.detail?.owner_loss_proof_sha256 === result.control.genericOwnerLoss.proofSha256)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(body.receipt.signature);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
