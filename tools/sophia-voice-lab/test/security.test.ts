import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CapabilityCodec, StaticAttestationAuthenticator, StaticBearerAuthenticator, assertNoSecret, projectPublicData, redact, sha256, validateAllowedOrigin } from "../src/security.js";
import { VoiceLabError } from "../src/domain.js";
import { SHA, SHA_B, SHA_C, testConfig } from "./helpers.js";

const DEPLOYMENT = { frontend: SHA, backend: SHA_B, voice: SHA_C };
const PROVIDER_EXPIRES_AT = "2026-08-23T12:30:00.000Z";
const INPUT = { aud: "sophia-voice-lab-frontend" as const, sub: "voice-lab-user-1", principal_id: "voice-lab-user-1", test_run_id: "00000000-0000-4000-8000-000000000001", cleanup_obligation_id: "00000000-0000-4000-8000-000000000002", scenario_id: "scenario-1", scenario_version: "vt00.scenarios.v1", synthetic: true as const, environment: "production", retention_hours: 24, provider_expires_at: PROVIDER_EXPIRES_AT, allowed_ops: ["auth:session"], expected_deployment: DEPLOYMENT };

describe("security contracts", () => {
  it("keeps fault authorization on a distinct stronger bearer", async () => {
    const auth = new StaticBearerAuthenticator("a".repeat(32), "desktop", "b".repeat(32));
    expect((await auth.authenticate(`Bearer ${"a".repeat(32)}`)).scopes.has("voice_lab:fault")).toBe(false);
    expect((await auth.authenticate(`Bearer ${"b".repeat(32)}`)).scopes.has("voice_lab:fault")).toBe(true);
    await expect(auth.authenticate(`Bearer ${"c".repeat(32)}`)).rejects.toMatchObject({ detail: { code: "UNAUTHORIZED" } });
    expect(() => new StaticBearerAuthenticator("short", "desktop")).toThrow(VoiceLabError);
    expect(() => new StaticBearerAuthenticator("a".repeat(32), "desktop", "a".repeat(32))).toThrow(VoiceLabError);
  });

  it("keeps external attestation authority on a separate direct-only credential", async () => {
    const attester = new StaticAttestationAuthenticator({
      external_mcp_client: { token: "c".repeat(32), subject: "attester.external-client" },
      deployment_control: { token: "d".repeat(32), subject: "attester.deployment-control" },
      platform_plugin: { token: "e".repeat(32), subject: "attester.platform-plugin" },
    });
    const caller = await attester.authenticate(`Bearer ${"c".repeat(32)}`);
    expect(caller).toEqual({ subject: "attester.external-client", scopes: new Set(["voice_lab:attest", "voice_lab:attest:external_mcp_client"]), authorizationKind: "attestation" });
    expect(caller.scopes.has("voice_lab:run")).toBe(false);
    await expect(attester.authenticate(`Bearer ${"a".repeat(32)}`)).rejects.toMatchObject({ detail: { code: "UNAUTHORIZED" } });
  });

  it("fails worker startup if any attestation transport secret is mounted", () => {
    expect(() => testConfig({}, "worker")).toThrowError(/must not be mounted/i);
    const worker = testConfig({ SOPHIA_VOICE_LAB_ATTESTATION_TRANSPORT_TOKENS_JSON: undefined }, "worker");
    expect(worker.attestationTransportTokens).toBeNull();
    expect(worker.provisionOperatorBearerToken).toBeNull();
    expect(worker.attestationAuthorities.external_mcp_client.publicKeySpkiBase64).toMatch(/^MCow/);
    expect(worker.d02GatewayCapabilitySecret).toBeNull();
    expect(worker.d02GatewayReceiptAuthority).toBeNull();

    expect(() => testConfig({
      SOPHIA_VOICE_LAB_ATTESTATION_TRANSPORT_TOKENS_JSON: undefined,
      SOPHIA_VOICE_LAB_D02_GATEWAY_CAPABILITY_SECRET: "d".repeat(32),
    }, "worker")).toThrowError(/must not be mounted/i);
    expect(() => testConfig({
      SOPHIA_VOICE_LAB_ATTESTATION_TRANSPORT_TOKENS_JSON: undefined,
      SOPHIA_VOICE_LAB_PROVISION_OPERATOR_BEARER_TOKEN: 'p'.repeat(32),
    }, 'worker')).toThrowError(/must not be mounted/i);
    const web = testConfig();
    expect(web.provisionOperatorBearerToken).not.toBeNull();
    expect(web.d02GatewayCapabilitySecret).not.toBeNull();
    expect(web.d02GatewayReceiptAuthority?.publicKeySpkiBase64).toMatch(/^MCow/);
    expect(web.d02GatewayReceiptAuthority?.publicKeysById[web.d02GatewayReceiptAuthority.keyId]).toBe(web.d02GatewayReceiptAuthority?.publicKeySpkiBase64);
    expect(() => testConfig({
      SOPHIA_VOICE_LAB_ATTESTATION_TRANSPORT_TOKENS_JSON: undefined,
      SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEY_SPKI_BASE64: web.d02GatewayReceiptAuthority!.publicKeySpkiBase64,
      SOPHIA_VOICE_LAB_D02_SETTLEMENT_AUTHORITY_KEY_ID: web.d02GatewayReceiptAuthority!.keyId,
    }, "worker")).toThrowError(/belongs only on the product web service/i);
    expect(() => testConfig({
      SOPHIA_VOICE_LAB_ATTESTATION_TRANSPORT_TOKENS_JSON: undefined,
      SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEYRING_JSON: JSON.stringify({ "retained-gateway-key-v1": web.d02GatewayReceiptAuthority!.publicKeySpkiBase64 }),
    }, "worker")).toThrowError(/belongs only on the product web service/i);
  });

  it("mints mandatory nonce/jti and enforces every run/deployment binding", () => {
    const codec = new CapabilityCodec("s".repeat(32), "sophia-voice-lab", 120);
    const minted = codec.mint(INPUT, new Date("2026-08-23T12:00:00Z"));
    const expected = { audience: INPUT.aud, operation: "auth:session", principalId: INPUT.principal_id, testRunId: INPUT.test_run_id, cleanupObligationId: INPUT.cleanup_obligation_id, environment: "production", retentionHours: 24, providerExpiresAt: PROVIDER_EXPIRES_AT, expectedDeployment: DEPLOYMENT, scenarioId: "scenario-1", scenarioVersion: "vt00.scenarios.v1" };
    expect(minted.claims.nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(codec.verify(minted.token, expected, new Date("2026-08-23T12:00:01Z"))).toMatchObject({ nonce: minted.claims.nonce, retention_hours: 24, provider_expires_at: PROVIDER_EXPIRES_AT, cleanup_obligation_id: INPUT.cleanup_obligation_id });
    expect(() => codec.verify(minted.token, { ...expected, environment: "staging" }, new Date("2026-08-23T12:00:01Z"))).toThrow(VoiceLabError);
    expect(() => codec.verify(minted.token, { ...expected, cleanupObligationId: "00000000-0000-4000-8000-000000000003" }, new Date("2026-08-23T12:00:01Z"))).toThrow(VoiceLabError);
    expect(() => codec.verify(minted.token, { ...expected, retentionHours: 1 }, new Date("2026-08-23T12:00:01Z"))).toThrow(VoiceLabError);
    expect(() => codec.verify(minted.token, { ...expected, providerExpiresAt: "2026-08-23T12:30:01.000Z" }, new Date("2026-08-23T12:00:01Z"))).toThrow(VoiceLabError);
    expect(() => codec.verify(minted.token, { ...expected, expectedDeployment: { ...DEPLOYMENT, voice: SHA } }, new Date("2026-08-23T12:00:01Z"))).toThrow(VoiceLabError);
    expect(() => codec.verify(`${minted.token}=`, expected, new Date("2026-08-23T12:00:01Z"))).toThrow(VoiceLabError);
    const noncanonical = codec.mint({ ...INPUT, provider_expires_at: "2026-08-23T12:30:00Z" }, new Date("2026-08-23T12:00:00Z"));
    expect(() => codec.verify(noncanonical.token, expected, new Date("2026-08-23T12:00:01Z"))).toThrow(VoiceLabError);
  });

  it("requires the complete positive-epoch browser ownership quartet only for V-D02", () => {
    const codec = new CapabilityCodec("s".repeat(32), "sophia-voice-lab", 120);
    const ownership = {
      voice_lab_run_id_sha256: sha256("voice-lab-run-d02"),
      browser_worker_id_sha256: sha256("browser-worker-d02"),
      browser_lease_epoch: 7,
      browser_context_id_sha256: sha256("browser-context-d02"),
    };
    const input = { ...INPUT, scenario_id: "V-D02", ...ownership };
    const expected = {
      audience: INPUT.aud,
      operation: "auth:session",
      principalId: INPUT.principal_id,
      testRunId: INPUT.test_run_id,
      cleanupObligationId: INPUT.cleanup_obligation_id,
      environment: INPUT.environment,
      retentionHours: INPUT.retention_hours,
      providerExpiresAt: INPUT.provider_expires_at,
      expectedDeployment: DEPLOYMENT,
      scenarioId: "V-D02",
      scenarioVersion: INPUT.scenario_version,
      voiceLabRunIdSha256: ownership.voice_lab_run_id_sha256,
      browserWorkerIdSha256: ownership.browser_worker_id_sha256,
      browserLeaseEpoch: ownership.browser_lease_epoch,
      browserContextIdSha256: ownership.browser_context_id_sha256,
    };
    const at = new Date("2026-08-23T12:00:00Z");
    const minted = codec.mint(input, at);
    expect(codec.verify(minted.token, expected, new Date(at.getTime() + 1_000))).toMatchObject(ownership);

    for (const malformed of [
      { ...input, browser_context_id_sha256: undefined },
      { ...input, browser_lease_epoch: 0 },
      { ...input, browser_worker_id_sha256: "A".repeat(64) },
      { ...input, scenario_id: "V-A01" },
    ]) {
      const token = codec.mint(malformed, at).token;
      expect(() => codec.verify(token, { ...expected, scenarioId: malformed.scenario_id }, new Date(at.getTime() + 1_000))).toThrow(VoiceLabError);
    }
    const missing = codec.mint({ ...INPUT, scenario_id: "V-D02" }, at);
    expect(() => codec.verify(missing.token, expected, new Date(at.getTime() + 1_000))).toThrow(VoiceLabError);
    expect(() => codec.verify(minted.token, { ...expected, browserContextIdSha256: sha256("foreign-context") }, new Date(at.getTime() + 1_000))).toThrow(VoiceLabError);
  });

  it("keeps the immutable provider deadline bound on recovery capabilities after provider expiry", () => {
    const codec = new CapabilityCodec("s".repeat(32), "sophia-voice-lab", 120);
    const minted = codec.mint({ ...INPUT, aud: "sophia-voice-lab-recovery", allowed_ops: ["session:recover"] }, new Date("2026-08-23T12:31:00Z"));
    expect(codec.verify(minted.token, { audience: "sophia-voice-lab-recovery", operation: "session:recover", principalId: INPUT.principal_id, testRunId: INPUT.test_run_id, cleanupObligationId: INPUT.cleanup_obligation_id, environment: "production", retentionHours: 24, providerExpiresAt: PROVIDER_EXPIRES_AT, expectedDeployment: DEPLOYMENT, scenarioId: "scenario-1", scenarioVersion: "vt00.scenarios.v1" }, new Date("2026-08-23T12:31:01Z"))).toMatchObject({ provider_expires_at: PROVIDER_EXPIRES_AT });
  });

  it("uses golden HMAC vectors accepted by the actual Python Gateway and Voice verifiers", () => {
    const repo = path.resolve(process.cwd(), "../..");
    const secret = "cross-language-capability-secret-000001";
    const now = Math.floor(Date.now() / 1_000);
    const gateway = new CapabilityCodec(secret, "sophia-frontend", 120).mint({ ...INPUT, aud: "sophia-voice-gateway", allowed_ops: ["voice:start"] }, new Date(now * 1_000));
    const gatewayCode = `from app.gateway.voice_lab_capability import verify_capability\nverify_capability(${JSON.stringify(gateway.token)}, secret=${JSON.stringify(secret)}, audience='sophia-voice-gateway', issuer='sophia-frontend', principal_id='voice-lab-user-1', environment='production', required_operation='voice:start', expected_build_key='backend', expected_build=${JSON.stringify(SHA_B)}, now_seconds=${now})`;
    const gatewayResult = spawnSync(path.join(repo, "backend/.venv/bin/python"), ["-c", gatewayCode], { cwd: path.join(repo, "backend"), env: { ...process.env, PYTHONPATH: ".", SOPHIA_VOICE_LAB_MAX_TTL_SECONDS: "300" }, encoding: "utf8" });
    expect(gatewayResult.status, gatewayResult.stderr).toBe(0);

    const runtime = new CapabilityCodec(secret, "sophia-gateway", 120).mint({ ...INPUT, aud: "sophia-voice-runtime", allowed_ops: ["voice:start"] }, new Date(now * 1_000));
    const voiceCode = `from internal_auth import _verify_runtime_capability\n_verify_runtime_capability(${JSON.stringify(runtime.token)}, principal_id='voice-lab-user-1', environment='production', required_operation='voice:start')`;
    const voiceResult = spawnSync(path.join(repo, "voice/.venv/bin/python"), ["-c", voiceCode], { cwd: path.join(repo, "voice"), env: { ...process.env, PYTHONPATH: ".", SOPHIA_VOICE_LAB_CAPABILITY_SECRET: secret, SOPHIA_VOICE_LAB_MAX_TTL_SECONDS: "300", SOPHIA_DEPLOYMENT_SHA: SHA_C }, encoding: "utf8" });
    expect(voiceResult.status, voiceResult.stderr).toBe(0);
  });

  it("redacts transcripts and hard-aborts native continuation/resumption secrets", () => {
    const projected = projectPublicData({ transcript: "private user words", nested: { message_text: "more private" } }) as any;
    expect(projected.transcript).toMatchObject({ redacted: true, character_length: 18 });
    expect(JSON.stringify(projected)).not.toContain("private user words");
    expect(redact({ url: "https://example.test/a?token=secret-secret-secret", apiKey: "AIza012345678901234567890123456789012345" })).toEqual({ url: "[REDACTED]", apiKey: "[REDACTED]" });
    const cleanup = "00000000-0000-4000-8000-000000000002";
    expect(redact({ cleanup_obligation_id: cleanup, nested: { cleanup_obligation_id: cleanup } })).toEqual({ cleanup_obligation_id_sha256: sha256(cleanup), nested: { cleanup_obligation_id_sha256: sha256(cleanup) } });
    expect(() => assertNoSecret({ nested: { resumption_handle: "[REDACTED]" } })).toThrowError(/secret material/i);
    expect(() => assertNoSecret({ continuationHandle: "opaque-native-handle" })).toThrowError(/secret material/i);
  });

  it("accepts only exact allowlisted bare origins", () => {
    const allowed = new Set(["https://example.test"]);
    expect(validateAllowedOrigin("https://example.test", allowed).origin).toBe("https://example.test");
    expect(() => validateAllowedOrigin("https://example.test/path", allowed)).toThrow(VoiceLabError);
    expect(() => validateAllowedOrigin("https://example.test?x=1", allowed)).toThrow(VoiceLabError);
    expect(() => validateAllowedOrigin("https://user@example.test", allowed)).toThrow(VoiceLabError);
  });
});
