import { createHmac, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  D02GatewayClient,
  D02GatewayContinuityObservationRequestSchema,
  D02GatewayFreezeRequestSchema,
  D02GatewaySettlementRequestSchema,
  type D02GatewayContinuityObservationRequest,
} from "../src/d02-gateway.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";
import { testConfig } from "./helpers.js";

function freezeRequest() {
  return D02GatewayFreezeRequestSchema.parse({
    schema: "sophia_voice_lab_gateway_browser_worker_termination_freeze_request_v1",
    termination_request_id: randomUUID(),
    voice_lab_run_id_sha256: sha256("run-d02"),
    test_run_id: randomUUID(),
    cleanup_obligation_id: randomUUID(),
    provider_session_id: "provider-session-d02",
    provider_admission_id_sha256: sha256("provider-admission-d02"),
    provider_connection_epoch: 7,
    frozen_provider_connection_epochs: [7, 8],
    browser_worker_id_sha256: sha256("browser-worker-d02"),
    browser_lease_epoch: 4,
    browser_context_id_sha256: sha256("browser-context-d02"),
    render_action_request_sha256: sha256("render-request-d02"),
    requested_at: "2026-08-24T08:00:00.000Z",
  });
}

function continuityRequest(
  patch: Partial<D02GatewayContinuityObservationRequest> = {},
): D02GatewayContinuityObservationRequest {
  return D02GatewayContinuityObservationRequestSchema.parse({
    schema: "sophia_voice_lab_d02_product_continuity_observation_request_v1",
    restart_request_id: randomUUID(),
    cleanup_obligation_id: randomUUID(),
    phase: "before_api_restart",
    product_service_boot_id_sha256: sha256("product-service-boot-before"),
    render_action_request_sha256: sha256("render-api-restart-request"),
    prior_observation_receipt_sha256: null,
    observed_at: "2026-08-24T08:00:00.000Z",
    ...patch,
  });
}

function continuityProjection(request: D02GatewayContinuityObservationRequest) {
  return {
    session_id_sha256: sha256("canonical-session-d02"),
    thread_id_sha256: sha256("thread-d02"),
    principal_id_hmac: sha256("principal-hmac-d02"),
    test_run_id_sha256: sha256("test-run-d02"),
    cleanup_obligation_id_sha256: sha256(request.cleanup_obligation_id),
    provider_session_id_sha256: sha256("provider-session-d02"),
    provider_admission_id_sha256: sha256("provider-admission-d02"),
    voice_lab_run_id_sha256: sha256("voice-lab-run-d02"),
    browser_worker_id_sha256: sha256("browser-worker-d02"),
    browser_lease_epoch: 4,
    browser_context_id_sha256: sha256("browser-context-d02"),
    voice_runtime_instance_id_sha256: sha256("voice-runtime-instance-d02"),
    expected_deployment: { frontend: "a".repeat(40), backend: "b".repeat(40), voice: "c".repeat(40) },
    session_status: "active" as const,
    message_revision: 12,
    canonical_provider_state: "active" as const,
    provider_connection_epoch: 7,
    provider_pending_connection_epoch: 8,
  };
}

function signedContinuityReceipt(input: {
  request: D02GatewayContinuityObservationRequest;
  privateKey: KeyObject;
  keyId: string;
  issuedAt?: string;
  corePatch?: Record<string, unknown>;
  projectionPatch?: Record<string, unknown>;
}) {
  const receiptId = randomUUID();
  const issuedAt = input.issuedAt ?? "2026-08-24T08:00:01.000Z";
  const core = {
    schema: "sophia_voice_lab_d02_product_continuity_observation_v1",
    receipt_id: receiptId,
    restart_request_id_sha256: sha256(input.request.restart_request_id),
    phase: input.request.phase,
    request_sha256: canonicalRequestHash(input.request),
    product_service_boot_id_sha256: input.request.product_service_boot_id_sha256,
    render_action_request_sha256: input.request.render_action_request_sha256,
    prior_observation_receipt_sha256: input.request.prior_observation_receipt_sha256,
    continuity_projection: { ...continuityProjection(input.request), ...input.projectionPatch },
    cleanup_obligation_state: "open",
    cleanup_lifecycle_phase: "session_provisional",
    d02_freeze_absent: true,
    database_observed_at: issuedAt,
    issuer: "sophia-gateway",
    audience: "sophia-voice-lab-d02-product-continuity",
    authority_key_id: input.keyId,
    jti: receiptId,
    nonce: "continuity-receipt-nonce-0000000000000001",
    issued_at: issuedAt,
    expires_at: new Date(new Date(issuedAt).getTime() + 600_000).toISOString(),
    signature_algorithm: "ed25519-sha256-canonical-request-v1",
    ...input.corePatch,
  };
  const unsigned = { ...core, receipt_sha256: canonicalRequestHash(core) };
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), input.privateKey).toString("base64url"),
  };
}

function continuityAuthority() {
  const current = generateKeyPairSync("ed25519");
  const retained = generateKeyPairSync("ed25519");
  const foreign = generateKeyPairSync("ed25519");
  const currentKeyId = "test-gateway-d02-continuity-v1";
  const retainedKeyId = "test-gateway-d02-continuity-v0";
  const currentSpki = current.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const retainedSpki = retained.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const capabilitySecret = "d02-gateway-capability-secret-0000000000000001";
  const config = testConfig({
    SOPHIA_VOICE_LAB_D02_GATEWAY_CAPABILITY_SECRET: capabilitySecret,
    SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEY_SPKI_BASE64: currentSpki,
    SOPHIA_VOICE_LAB_D02_SETTLEMENT_AUTHORITY_KEY_ID: currentKeyId,
    SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEYRING_JSON: JSON.stringify({
      [currentKeyId]: currentSpki,
      [retainedKeyId]: retainedSpki,
    }),
  });
  return { capabilitySecret, config, current, retained, foreign, currentKeyId, retainedKeyId };
}

describe("product-owned D02 Gateway client", () => {
  it("binds the exact freeze request in a short-lived key-separated capability", async () => {
    const config = testConfig();
    const request = freezeRequest();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://gateway.test/internal/voice-lab/d02/browser-worker-termination-freezes");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual(request);
      const headers = new Headers(init?.headers);
      const token = headers.get("X-Sophia-Voice-Lab-D02-Gateway-Capability");
      expect(token).not.toBeNull();
      const [encoded, signature] = token!.split(".");
      const expectedSignature = createHmac("sha256", config.d02GatewayCapabilitySecret!).update(encoded!).digest("base64url");
      expect(signature).toBe(expectedSignature);
      const claims = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as Record<string, unknown>;
      expect(claims).toMatchObject({
        v: 1,
        iss: "sophia-voice-lab",
        aud: "sophia-gateway-d02-settlement",
        op: "freeze",
        request_sha256: canonicalRequestHash(request),
        cleanup_obligation_id: request.cleanup_obligation_id,
        termination_request_id_sha256: sha256(request.termination_request_id),
      });
      expect(Number(claims.exp) - Number(claims.iat)).toBe(120);
      return new Response(JSON.stringify({ frozen: true, idempotent_replay: false, freeze_request_sha256: canonicalRequestHash(request) }), { status: 202, headers: { "content-type": "application/json" } });
    });
    const client = new D02GatewayClient(config, fetchImpl, () => new Date("2026-08-24T08:00:01.000Z"));
    await expect(client.freeze("http://gateway.test", request)).resolves.toEqual({ frozen: true, idempotent_replay: false, freeze_request_sha256: canonicalRequestHash(request) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed before network on epoch, origin, or response-binding drift", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new D02GatewayClient(testConfig(), fetchImpl);
    const request = freezeRequest();
    await expect(client.freeze("http://gateway.test", { ...request, provider_connection_epoch: 0, frozen_provider_connection_epochs: [0] })).rejects.toThrow();
    await expect(client.freeze("http://gateway.test", { ...request, termination_request_id: request.termination_request_id.toUpperCase() })).rejects.toThrow();
    await expect(client.freeze("http://gateway.test", { ...request, cleanup_obligation_id: request.cleanup_obligation_id.toUpperCase() })).rejects.toThrow();
    await expect(client.freeze("https://foreign.invalid", request)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();

    const driftFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ frozen: true, idempotent_replay: true, freeze_request_sha256: sha256("foreign") }), { status: 202 }));
    await expect(new D02GatewayClient(testConfig(), driftFetch).freeze("http://gateway.test", request)).rejects.toMatchObject({ detail: { code: "D02_GATEWAY_FREEZE_CONFLICT" } });
  });

  it("uses a fresh request-bound JTI when an ambiguous freeze is retried", async () => {
    const request = freezeRequest();
    const tokens: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      tokens.push(new Headers(init?.headers).get("X-Sophia-Voice-Lab-D02-Gateway-Capability")!);
      if (tokens.length === 1) throw new TypeError("lost response");
      return new Response(JSON.stringify({ frozen: true, idempotent_replay: true, freeze_request_sha256: canonicalRequestHash(request) }), { status: 202 });
    });
    const client = new D02GatewayClient(testConfig(), fetchImpl, () => new Date("2026-08-24T08:00:01.000Z"));
    await expect(client.freeze("http://gateway.test", request)).rejects.toMatchObject({ detail: { code: "D02_GATEWAY_FREEZE_PENDING", retryable: true } });
    await expect(client.freeze("http://gateway.test", request)).resolves.toMatchObject({ idempotent_replay: true });
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    const first = JSON.parse(Buffer.from(tokens[0]!.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const second = JSON.parse(Buffer.from(tokens[1]!.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(first.request_sha256).toBe(second.request_sha256);
    expect(first.jti).not.toBe(second.jti);
  });

  it("treats an empty or malformed post-commit response as retryable pending", async () => {
    const request = freezeRequest();
    for (const body of ["", "<html>proxy truncated response</html>"]) {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, { status: 202 }));
      await expect(new D02GatewayClient(testConfig(), fetchImpl).freeze("http://gateway.test", request)).rejects.toMatchObject({
        detail: { code: "D02_GATEWAY_FREEZE_PENDING", retryable: true },
      });
    }
  });

  it("accepts only the exact configured Gateway Ed25519 settlement receipt", async () => {
    const now = new Date("2026-08-24T08:10:00.000Z");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { privateKey: retainedPrivateKey, publicKey: retainedPublicKey } = generateKeyPairSync("ed25519");
    const keyId = "test-gateway-d02-receipt-v1";
    const retainedKeyId = "test-gateway-d02-receipt-v0";
    const publicKeySpkiBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const retainedPublicKeySpkiBase64 = retainedPublicKey.export({ format: "der", type: "spki" }).toString("base64");
    const config = testConfig({
      SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEY_SPKI_BASE64: publicKeySpkiBase64,
      SOPHIA_VOICE_LAB_D02_SETTLEMENT_AUTHORITY_KEY_ID: keyId,
      SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEYRING_JSON: JSON.stringify({ [keyId]: publicKeySpkiBase64, [retainedKeyId]: retainedPublicKeySpkiBase64 }),
    });
    const frozen = freezeRequest();
    const request = D02GatewaySettlementRequestSchema.parse({
      ...Object.fromEntries(Object.entries(frozen).filter(([key]) => !["schema", "requested_at"].includes(key))),
      schema: "sophia_voice_lab_gateway_browser_worker_termination_settlement_request_v1",
      render_action_accepted_response_sha256: sha256("render-accepted-d02"),
      render_action_settled_snapshot_sha256: sha256("render-settled-d02"),
      loss_event_seq: 12,
      loss_observed_at: "2026-08-24T08:09:30.000Z",
    });
    const receiptId = randomUUID();
    const unsigned = {
      schema: "sophia_voice_lab_gateway_browser_worker_termination_settlement_v1",
      receipt_id: receiptId,
      termination_request_id_sha256: sha256(request.termination_request_id),
      voice_lab_run_id_sha256: request.voice_lab_run_id_sha256,
      test_run_id_sha256: sha256(request.test_run_id),
      cleanup_obligation_id_sha256: sha256(request.cleanup_obligation_id),
      principal_id_hmac: sha256("principal-hmac"),
      scenario_id: "V-D02",
      scenario_version: "vt00.scenarios.v1",
      environment: "production",
      expected_deployment: { frontend: "a".repeat(40), backend: "b".repeat(40), voice: "c".repeat(40) },
      provider_session_id_sha256: sha256(request.provider_session_id),
      provider_admission_id_sha256: request.provider_admission_id_sha256,
      provider_connection_epoch: request.provider_connection_epoch,
      frozen_provider_connection_epochs: request.frozen_provider_connection_epochs,
      browser_worker_id_sha256: request.browser_worker_id_sha256,
      browser_lease_epoch: request.browser_lease_epoch,
      browser_context_id_sha256: request.browser_context_id_sha256,
      render_action_request_sha256: request.render_action_request_sha256,
      render_action_accepted_response_sha256: request.render_action_accepted_response_sha256,
      render_action_settled_snapshot_sha256: request.render_action_settled_snapshot_sha256,
      loss_event_seq: request.loss_event_seq,
      loss_observed_at: request.loss_observed_at,
      voice_terminal_receipts_sha256: sha256("voice-terminal-receipts"),
      provider_settlement_sha256: sha256("provider-settlement"),
      cleanup_obligation_state: "closed",
      canonical_provider_state: "closed",
      canonical_pending_epoch: null,
      all_frozen_provider_epochs_terminal: true,
      provider_admission_absent: true,
      voice_provider_session_absent: true,
      gateway_browser_relay_absent: true,
      database_observed_at: now.toISOString(),
      issuer: "sophia-gateway",
      audience: "sophia-voice-lab-d02-gateway-settlement",
      authority_key_id: keyId,
      jti: receiptId,
      nonce: "n".repeat(32),
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 600_000).toISOString(),
      signature_algorithm: "ed25519-sha256-canonical-request-v1",
    } as const;
    const receipt = { ...unsigned, signature: sign(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), privateKey).toString("base64url") };
    const client = new D02GatewayClient(config, async () => new Response(JSON.stringify(receipt), { status: 202 }), () => now);
    await expect(client.settle("http://gateway.test", request)).resolves.toEqual(receipt);
    const delayedExactReplay = new D02GatewayClient(config, async () => new Response(JSON.stringify(receipt), { status: 202 }), () => new Date(now.getTime() + 3_600_000));
    await expect(delayedExactReplay.settle("http://gateway.test", request)).resolves.toEqual(receipt);
    const retainedUnsigned = { ...unsigned, authority_key_id: retainedKeyId };
    const retainedReceipt = { ...retainedUnsigned, signature: sign(null, Buffer.from(canonicalRequestHash(retainedUnsigned), "hex"), retainedPrivateKey).toString("base64url") };
    await expect(new D02GatewayClient(config, async () => new Response(JSON.stringify(retainedReceipt), { status: 202 }), () => new Date(now.getTime() + 3_600_000)).settle("http://gateway.test", request)).resolves.toEqual(retainedReceipt);

    const tampered = { ...receipt, provider_settlement_sha256: sha256("tampered") };
    await expect(new D02GatewayClient(config, async () => new Response(JSON.stringify(tampered), { status: 202 }), () => now).settle("http://gateway.test", request)).rejects.toMatchObject({ detail: { code: "D02_GATEWAY_RECEIPT_INVALID", retryable: false } });

    const foreignUnsigned = { ...unsigned, provider_session_id_sha256: sha256("foreign-provider-session") };
    const foreign = { ...foreignUnsigned, signature: sign(null, Buffer.from(canonicalRequestHash(foreignUnsigned), "hex"), privateKey).toString("base64url") };
    await expect(new D02GatewayClient(config, async () => new Response(JSON.stringify(foreign), { status: 202 }), () => now).settle("http://gateway.test", request)).rejects.toMatchObject({ detail: { code: "D02_GATEWAY_RECEIPT_BINDING_MISMATCH" } });
  });

  it("posts an exact BEFORE continuity observation with the restart-bound HMAC capability", async () => {
    const authority = continuityAuthority();
    const request = continuityRequest();
    const receipt = signedContinuityReceipt({
      request,
      privateKey: authority.current.privateKey,
      keyId: authority.currentKeyId,
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://gateway.test/internal/voice-lab/d02/product-continuity-observations");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual(request);
      const token = new Headers(init?.headers).get("X-Sophia-Voice-Lab-D02-Gateway-Capability");
      expect(token).not.toBeNull();
      const [encoded, signature] = token!.split(".");
      expect(signature).toBe(createHmac("sha256", authority.capabilitySecret).update(encoded!).digest("base64url"));
      const claims = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as Record<string, unknown>;
      expect(claims).toMatchObject({
        v: 1,
        iss: "sophia-voice-lab",
        aud: "sophia-gateway-d02-settlement",
        op: "observe_continuity",
        request_sha256: canonicalRequestHash(request),
        cleanup_obligation_id: request.cleanup_obligation_id,
        termination_request_id_sha256: sha256(request.restart_request_id),
      });
      expect(Number(claims.exp) - Number(claims.iat)).toBe(120);
      return new Response(JSON.stringify(receipt), { status: 202, headers: { "content-type": "application/json" } });
    });

    const client = new D02GatewayClient(authority.config, fetchImpl, () => new Date("2026-08-24T08:00:01.000Z"));
    await expect(client.observeContinuity("http://gateway.test", request)).resolves.toEqual(receipt);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts an exact AFTER observation signed by a retained Gateway key on delayed replay", async () => {
    const authority = continuityAuthority();
    const beforeRequest = continuityRequest();
    const beforeReceipt = signedContinuityReceipt({
      request: beforeRequest,
      privateKey: authority.current.privateKey,
      keyId: authority.currentKeyId,
    });
    const request = continuityRequest({
      restart_request_id: beforeRequest.restart_request_id,
      cleanup_obligation_id: beforeRequest.cleanup_obligation_id,
      phase: "after_api_restart",
      product_service_boot_id_sha256: sha256("product-service-boot-after"),
      prior_observation_receipt_sha256: beforeReceipt.receipt_sha256,
      observed_at: "2026-08-24T08:10:00.000Z",
    });
    const receipt = signedContinuityReceipt({
      request,
      privateKey: authority.retained.privateKey,
      keyId: authority.retainedKeyId,
      issuedAt: "2026-08-24T08:10:01.000Z",
    });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const token = new Headers(init?.headers).get("X-Sophia-Voice-Lab-D02-Gateway-Capability")!;
      const claims = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
      expect(claims.op).toBe("observe_continuity");
      expect(claims.termination_request_id_sha256).toBe(sha256(request.restart_request_id));
      expect(JSON.parse(String(init?.body))).toEqual(request);
      return new Response(JSON.stringify(receipt), { status: 200 });
    });

    const delayedReplay = new D02GatewayClient(authority.config, fetchImpl, () => new Date("2026-08-24T09:10:01.000Z"));
    await expect(delayedReplay.observeContinuity("http://gateway.test", request)).resolves.toEqual(receipt);
    expect(receipt.prior_observation_receipt_sha256).toBe(beforeReceipt.receipt_sha256);
  });

  it("rejects authentic continuity receipts bound to a foreign request or projection", async () => {
    const authority = continuityAuthority();
    const request = continuityRequest();
    const authenticForeignReceipts = [
      signedContinuityReceipt({ request, privateKey: authority.current.privateKey, keyId: authority.currentKeyId, corePatch: { restart_request_id_sha256: sha256("foreign-restart") } }),
      signedContinuityReceipt({ request, privateKey: authority.current.privateKey, keyId: authority.currentKeyId, corePatch: { request_sha256: sha256("foreign-request") } }),
      signedContinuityReceipt({ request, privateKey: authority.current.privateKey, keyId: authority.currentKeyId, corePatch: { product_service_boot_id_sha256: sha256("foreign-boot") } }),
      signedContinuityReceipt({ request, privateKey: authority.current.privateKey, keyId: authority.currentKeyId, corePatch: { render_action_request_sha256: sha256("foreign-render-action") } }),
      signedContinuityReceipt({ request, privateKey: authority.current.privateKey, keyId: authority.currentKeyId, projectionPatch: { cleanup_obligation_id_sha256: sha256("foreign-cleanup") } }),
    ];
    for (const receipt of authenticForeignReceipts) {
      const client = new D02GatewayClient(authority.config, async () => new Response(JSON.stringify(receipt), { status: 202 }), () => new Date("2026-08-24T08:00:01.000Z"));
      await expect(client.observeContinuity("http://gateway.test", request)).rejects.toMatchObject({
        detail: { code: "D02_GATEWAY_RECEIPT_BINDING_MISMATCH", retryable: false },
      });
    }

    const afterRequest = continuityRequest({
      restart_request_id: request.restart_request_id,
      cleanup_obligation_id: request.cleanup_obligation_id,
      phase: "after_api_restart",
      prior_observation_receipt_sha256: sha256("expected-before-receipt"),
    });
    const wrongPriorReceipt = signedContinuityReceipt({
      request: afterRequest,
      privateKey: authority.current.privateKey,
      keyId: authority.currentKeyId,
      corePatch: { prior_observation_receipt_sha256: sha256("foreign-before-receipt") },
    });
    const client = new D02GatewayClient(authority.config, async () => new Response(JSON.stringify(wrongPriorReceipt), { status: 202 }), () => new Date("2026-08-24T08:00:01.000Z"));
    await expect(client.observeContinuity("http://gateway.test", afterRequest)).rejects.toMatchObject({
      detail: { code: "D02_GATEWAY_RECEIPT_BINDING_MISMATCH", retryable: false },
    });
  });

  it("rejects tampered content hashes, signatures, and foreign receipt authorities", async () => {
    const authority = continuityAuthority();
    const request = continuityRequest();
    const receipt = signedContinuityReceipt({ request, privateKey: authority.current.privateKey, keyId: authority.currentKeyId });
    const tamperedProjection = {
      ...receipt,
      continuity_projection: { ...receipt.continuity_projection, provider_session_id_sha256: sha256("tampered-provider-session") },
    };
    const tamperedContentHash = { ...receipt, receipt_sha256: sha256("tampered-receipt-core") };
    const foreignSignature = signedContinuityReceipt({ request, privateKey: authority.foreign.privateKey, keyId: authority.currentKeyId });
    const unknownAuthority = signedContinuityReceipt({ request, privateKey: authority.foreign.privateKey, keyId: "foreign-gateway-continuity-v1" });
    for (const candidate of [tamperedProjection, tamperedContentHash, foreignSignature, unknownAuthority]) {
      const client = new D02GatewayClient(authority.config, async () => new Response(JSON.stringify(candidate), { status: 202 }), () => new Date("2026-08-24T08:00:01.000Z"));
      await expect(client.observeContinuity("http://gateway.test", request)).rejects.toMatchObject({
        detail: { code: "D02_GATEWAY_RECEIPT_INVALID", retryable: false },
      });
    }
  });

  it("fails closed before network on noncanonical continuity requests and foreign origins", async () => {
    const authority = continuityAuthority();
    const request = continuityRequest();
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new D02GatewayClient(authority.config, fetchImpl);
    const invalidRequests = [
      { ...request, restart_request_id: request.restart_request_id.toUpperCase() },
      { ...request, cleanup_obligation_id: request.cleanup_obligation_id.toUpperCase() },
      { ...request, cleanup_obligation_id: "continuité-obligation" },
      { ...request, product_service_boot_id_sha256: request.product_service_boot_id_sha256.toUpperCase() },
      { ...request, render_action_request_sha256: request.render_action_request_sha256.toUpperCase() },
      { ...request, prior_observation_receipt_sha256: sha256("unexpected-prior") },
      { ...request, observed_at: "2026-08-24T08:00:00Z" },
      { ...request, phase: "after_api_restart" as const, prior_observation_receipt_sha256: null },
    ];
    for (const invalid of invalidRequests) {
      await expect(client.observeContinuity("http://gateway.test", invalid)).rejects.toThrow();
    }
    await expect(client.observeContinuity("https://foreign.invalid", request)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats uppercase, Unicode, or extended continuity receipt shapes as ambiguous", async () => {
    const authority = continuityAuthority();
    const request = continuityRequest();
    const receipt = signedContinuityReceipt({ request, privateKey: authority.current.privateKey, keyId: authority.currentKeyId });
    const malformedReceipts = [
      { ...receipt, receipt_id: receipt.receipt_id.toUpperCase(), jti: receipt.jti.toUpperCase() },
      { ...receipt, authority_key_id: "gateway-continuity-é" },
      { ...receipt, request_sha256: receipt.request_sha256.toUpperCase() },
      { ...receipt, unexpected_projection_authority: "foreign" },
    ];
    for (const malformed of malformedReceipts) {
      const client = new D02GatewayClient(authority.config, async () => new Response(JSON.stringify(malformed), { status: 202 }), () => new Date("2026-08-24T08:00:01.000Z"));
      await expect(client.observeContinuity("http://gateway.test", request)).rejects.toMatchObject({
        detail: { code: "D02_GATEWAY_CONTINUITY_PENDING", retryable: true },
      });
    }
  });
});
