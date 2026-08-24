import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { VoiceLabError, labError } from "../src/domain.js";
import { createHttpApp, listen, probeTarget } from "../src/http-server.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { createVoiceLabMcpServer } from "../src/mcp-server.js";
import { buildBearerChallenge } from "../src/oauth.js";
import { canonicalRequestHash, sha256, StaticBearerAuthenticator } from "../src/security.js";
import { VoiceLabService } from "../src/service.js";
import { SHA, SHA_B, SHA_C, SHA_D, testConfig, testRun } from "./helpers.js";

const METADATA = "https://voice-lab.test/.well-known/oauth-protected-resource/mcp";
const target = {
  frontend_url: "http://frontend.test",
  gateway_url: "http://gateway.test",
  voice_url: "http://voice.test",
  langgraph_url: "http://langgraph.test",
  expected_deployment: { frontend: SHA, backend: SHA_B, voice: SHA_C },
  expected_dependencies: { langgraph: SHA_D },
};

describe("external MCP OAuth wire contract", () => {
  const servers: Array<{ close: (callback?: (error?: Error) => void) => void }> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    vi.unstubAllGlobals();
  });

  it("keeps closed product gates healthy, attests exact open gates, and rejects hostile gate projections", async () => {
    const config = testConfig({
      SOPHIA_VOICE_LAB_TARGET_FRONTEND_URL: "http://frontend.test",
      SOPHIA_VOICE_LAB_TARGET_GATEWAY_URL: "http://gateway.test",
      SOPHIA_VOICE_LAB_TARGET_VOICE_URL: "http://voice.test",
      SOPHIA_VOICE_LAB_TARGET_LANGGRAPH_URL: "http://langgraph.test",
      SOPHIA_VOICE_LAB_EXPECTED_FRONTEND_SHA: SHA,
      SOPHIA_VOICE_LAB_EXPECTED_BACKEND_SHA: SHA_B,
      SOPHIA_VOICE_LAB_EXPECTED_VOICE_SHA: SHA_C,
      SOPHIA_VOICE_LAB_EXPECTED_LANGGRAPH_SHA: SHA_D,
    });
    let gateState: "closed" | "open" | "hostile" = "closed";
    let langgraphBuild = SHA_D;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const open = gateState === "open";
      const payload = url.pathname === "/api/app-version" ? { build_id: SHA }
        : url.pathname === "/version" && url.origin === "http://gateway.test" ? { commit_sha: SHA_B }
          : url.pathname === "/version" && url.origin === "http://voice.test" ? { commit_sha: SHA_C }
            : url.pathname === "/version" ? { commit_sha: langgraphBuild }
            : url.pathname === "/ready" && url.origin === "http://gateway.test" ? {
              ok: true,
              voice_lab_enabled: open,
              voice_lab_kill_switch_engaged: !open,
              voice_lab_protected_plane_ready: true,
              voice_lab_admission_ready: true,
              voice_lab_mutation_ready: gateState === "hostile" ? true : open,
            }
              : url.pathname === "/ready" && url.origin === "http://voice.test" ? {
                ok: true,
                voice_lab_enabled: open,
                voice_lab_kill_switch_engaged: !open,
                voice_lab_mutation_ready: open,
              }
              : { ok: true };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await expect(probeTarget(config)).resolves.toMatchObject({
      ok: true,
      product_mutation_gates_open: false,
      builds: {
        backend: { config_status: "ready", product_mutation_gate: { valid: true, open: false } },
        voice: { config_status: "ready", product_mutation_gate: { valid: true, open: false } },
      },
    });
    gateState = "open";
    await expect(probeTarget(config)).resolves.toMatchObject({ ok: true, product_mutation_gates_open: true, builds: { backend: { config_status: "ready", product_mutation_gate: { open: true } }, voice: { product_mutation_gate: { open: true } }, langgraph: { ready: true, expected: SHA_D, observed: SHA_D } } });
    gateState = "hostile";
    await expect(probeTarget(config)).resolves.toMatchObject({ ok: false, product_mutation_gates_open: false, builds: { backend: { config_status: "voice_lab_gate_projection_invalid", product_mutation_gate: { valid: false, open: false } } } });
    gateState = "open";
    langgraphBuild = SHA;
    await expect(probeTarget(config)).resolves.toMatchObject({ ok: false, builds: { langgraph: { ready: false, identity_status: "deployment_mismatch", expected: SHA_D, observed: SHA } } });
  });

  it("keeps raw D02 run identity out of URLs and audits the bounded no-store continuity body exactly", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const config = testConfig();
    const service = new VoiceLabService(ledger, config, async () => []);
    const runId = randomUUID();
    const operationId = randomUUID();
    const body = { run_id: runId, restart_request_id_sha256: sha256("restart"), operation_id: operationId, after_boot_id_sha256: sha256("after-boot") };
    const core = {
      schema: "sophia_voice_lab_d02_browser_continuity_v1" as const, run_id_sha256: sha256(runId), restart_request_id_sha256: body.restart_request_id_sha256, operation_id_sha256: sha256(operationId), after_boot_id_sha256: body.after_boot_id_sha256,
      browser_worker_id_sha256: sha256("worker"), browser_lease_epoch: 1, browser_lease_updated_at: "2026-08-24T00:00:02.000Z", browser_lease_expires_at: "2026-08-24T00:01:00.000Z",
      replay_event_seq: 9, replay_observed_at: "2026-08-24T00:00:01.000Z", observed_at: "2026-08-24T00:00:03.000Z", runtime_acquisition_count: 1 as const, loss_or_replacement_count: 0 as const, continuity_proven: true as const,
    };
    const proof = { ...core, proof_sha256: canonicalRequestHash(core) };
    const caller = { subject: config.attestationAuthorities.deployment_control.subject, scopes: new Set(["voice_lab:attest", "voice_lab:attest:deployment_control"]), authorizationKind: "attestation" as const };
    const continuity = vi.spyOn(service, "getD02BrowserContinuity").mockResolvedValue(proof);
    const authenticator = { authenticate: vi.fn(async () => caller) };
    const app = createHttpApp(config, service, ledger, authenticator);
    const httpServer = await listen(app, 0);
    servers.push(httpServer);
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const endpoint = `http://127.0.0.1:${address.port}/internal/voice-lab/d02/browser-continuity`;
    expect(endpoint).not.toContain(runId);
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer deployment-control-test", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.json()).toEqual(proof);
    expect(continuity).toHaveBeenCalledWith(caller, body);
    const audits = await ledger.listAuthAuditByArgumentHashes(caller.subject, [canonicalRequestHash(body)], new Date(0));
    expect(audits).toContainEqual(expect.objectContaining({ action: "external_attestation.d02_browser_continuity", argumentHash: canonicalRequestHash(body), outcome: "allowed", detail: expect.objectContaining({ proof_sha256: proof.proof_sha256, run_id_sha256: sha256(runId) }) }));

    const oversized = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer deployment-control-test", "content-type": "application/json" }, body: JSON.stringify({ ...body, padding: "x".repeat(150_000) }) });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("cache-control")).toBe("no-store");
    expect(continuity).toHaveBeenCalledTimes(1);
  });

  it("keeps the D02 worker-loss query body-bound and exposes no Gateway settlement assertion", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const config = testConfig();
    const service = new VoiceLabService(ledger, config, async () => []);
    const runId = randomUUID();
    const body = { run_id: runId, termination_request_id_sha256: sha256("worker-termination-request") };
    const core = {
      schema: "sophia_voice_lab_d02_browser_worker_loss_observation_v1" as const,
      run_id_sha256: sha256(runId), test_run_id_sha256: sha256("worker-loss-test-run"), cleanup_obligation_id_sha256: sha256("worker-loss-cleanup"), termination_request_id_sha256: body.termination_request_id_sha256,
      provider_session_id_sha256: sha256("worker-loss-provider"), provider_admission_id_sha256: sha256("worker-loss-admission"), provider_connection_epoch: 3, frozen_provider_connection_epochs: [2, 3],
      product_provider_cleanup_settlement_sha256: sha256("worker-loss-provider-settlement"),
      browser_context_id_sha256: sha256("worker-loss-context"), lost_browser_worker_id_sha256: sha256("worker-loss-before"), replacement_browser_worker_id_sha256: sha256("worker-loss-after"), lost_browser_lease_epoch: 2,
      loss_event_seq: 12, loss_observed_at: "2026-08-24T00:00:02.000Z", observed_at: "2026-08-24T00:00:03.000Z", terminal_state: "aborted_driver_restart" as const, terminal_error_code: "BROWSER_SESSION_LOST" as const,
      browser_lease_absent: true as const, owning_gateway_settlement_included: false as const,
    };
    const proof = { ...core, proof_sha256: canonicalRequestHash(core) };
    const caller = { subject: config.attestationAuthorities.deployment_control.subject, scopes: new Set(["voice_lab:attest", "voice_lab:attest:deployment_control"]), authorizationKind: "attestation" as const };
    const observed = vi.spyOn(service, "getD02BrowserWorkerLossObservation").mockResolvedValue(proof);
    const app = createHttpApp(config, service, ledger, { authenticate: vi.fn(async () => caller) });
    const httpServer = await listen(app, 0);
    servers.push(httpServer);
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const endpoint = `http://127.0.0.1:${address.port}/internal/voice-lab/d02/browser-worker-loss-observation`;
    expect(endpoint).not.toContain(runId);
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer deployment-control-test", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(proof);
    expect(observed).toHaveBeenCalledWith(caller, body);
    expect(JSON.stringify(proof)).not.toMatch(/provider_session_absent|browser_context_absent|builder_tasks_zero/);
    const audits = await ledger.listAuthAuditByArgumentHashes(caller.subject, [canonicalRequestHash(body)], new Date(0));
    expect(audits).toContainEqual(expect.objectContaining({ action: "external_attestation.d02_browser_worker_loss_observation", outcome: "allowed", detail: expect.objectContaining({ termination_request_id_sha256: body.termination_request_id_sha256, loss_event_seq: 12 }) }));
  });

  it("exposes the global D02 Render dispatch claim only on the authenticated evidence plane", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const config = testConfig();
    const service = new VoiceLabService(ledger, config, async () => []);
    const runId = randomUUID();
    const terminationRequestId = randomUUID();
    const dispatchAttemptId = randomUUID();
    const body = {
      schema: "sophia_voice_lab_d02_render_worker_dispatch_claim_request_v1",
      run_id: runId,
      termination_request_id: terminationRequestId,
      command_attestation_id: randomUUID(),
      command_content_sha256: sha256("dispatch-command-content"),
      command_event_seq: 10,
      worker_service_id_sha256: sha256("dispatch-worker-service"),
      action_request_sha256: sha256("dispatch-action-request"),
      dispatch_attempt_id: dispatchAttemptId,
      requested_at: new Date().toISOString(),
    };
    const responseBody = {
      schema: "sophia_voice_lab_d02_render_worker_dispatch_claim_v1" as const,
      claimed: true as const,
      idempotent_replay: false,
      termination_request_id_sha256: sha256(terminationRequestId),
      dispatch_attempt_id_sha256: sha256(dispatchAttemptId),
      action_request_sha256: body.action_request_sha256,
      dispatch_claim_sha256: sha256("dispatch-global-claim"),
      event_seq: 11,
      claimed_at: body.requested_at,
    };
    const caller = { subject: config.attestationAuthorities.deployment_control.subject, scopes: new Set(["voice_lab:attest", "voice_lab:attest:deployment_control"]), authorizationKind: "attestation" as const };
    const claim = vi.spyOn(service, "claimD02RenderWorkerDispatch")
      .mockResolvedValueOnce(responseBody)
      .mockResolvedValueOnce({ ...responseBody, idempotent_replay: true });
    const app = createHttpApp(config, service, ledger, { authenticate: vi.fn(async () => caller) });
    const httpServer = await listen(app, 0);
    servers.push(httpServer);
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const endpoint = `http://127.0.0.1:${address.port}/internal/voice-lab/d02/render-worker-dispatch-claims`;
    expect(endpoint).not.toContain(runId);
    const first = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer deployment-control-test", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual(responseBody);
    const replay = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer deployment-control-test", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...responseBody, idempotent_replay: true });
    expect(claim).toHaveBeenNthCalledWith(1, caller, body);
    expect(claim).toHaveBeenNthCalledWith(2, caller, body);
    const audits = await ledger.listAuthAuditByArgumentHashes(caller.subject, [canonicalRequestHash(body)], new Date(0));
    expect(audits.filter((audit) => audit.action === "external_attestation.d02_render_worker_dispatch_claim" && audit.outcome === "allowed")).toHaveLength(2);
  });

  it("exposes OAuth security schemes at top-level and _meta and returns a complete insufficient-scope linking challenge", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const config = testConfig();
    const service = new VoiceLabService(ledger, config, async () => []);
    const challenge = (scopes: readonly string[], error: "invalid_token" | "insufficient_scope") => buildBearerChallenge(METADATA, scopes, error);
    const server = createVoiceLabMcpServer(service, ledger, { subject: "oauth-read-only", scopes: new Set(["voice_lab:read"]) }, challenge);
    const client = new Client({ name: "voice-lab-contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.request({ method: "tools/list", params: {} }, z.any()) as { tools: Array<Record<string, any>> };
      expect(listed.tools).toHaveLength(11);
      for (const tool of listed.tools) {
        expect(tool.securitySchemes).toEqual(expect.arrayContaining([expect.objectContaining({ type: "oauth2" })]));
        expect(tool._meta?.securitySchemes).toEqual(tool.securitySchemes);
      }
      const start = await client.callTool({ name: "start_voice_run", arguments: { environment: "production", target, scenario_id: "V-A01", scenario_version: "vt00.scenarios.v1", idempotency_key: "scope-contract" } });
      expect(start.isError).toBe(true);
      const linking = (start as any)._meta?.["mcp/www_authenticate"]?.[0] as string;
      expect(linking).toContain(`resource_metadata="${METADATA}"`);
      expect(linking).toContain('scope="voice_lab:run"');
      expect(linking).toContain('error="insufficient_scope"');
      expect(linking).toContain("error_description=");
      expect(linking).not.toMatch(/secret|token-pepper|bearer-credential/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns matching HTTP and MCP linking challenges before any unauthenticated MCP side effect", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const config = testConfig();
    const service = new VoiceLabService(ledger, config, async () => []);
    const oauth = {
      createRouter: () => express.Router(),
      readiness: async () => ({ ready: true, checks: { durable_store: true }, errors: [] }),
      challenge: (scopes: readonly string[], error: "invalid_token" | "insufficient_scope") => buildBearerChallenge(METADATA, scopes, error),
    } as any;
    const authenticator = { authenticate: async () => { throw new VoiceLabError(labError("UNAUTHORIZED", "OAuth bearer authorization is invalid.", "authorization")); } };
    const app = createHttpApp(config, service, ledger, authenticator, oauth);
    const httpServer = await listen(app, 0);
    servers.push(httpServer);
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "unauthenticated-contract", version: "1" } } }),
    });
    expect(response.status).toBe(401);
    const header = response.headers.get("www-authenticate");
    const body = await response.json() as any;
    const meta = body.error.data._meta["mcp/www_authenticate"][0];
    expect(meta).toBe(header);
    expect(header).toContain('error="invalid_token"');
    expect(header).toContain("error_description=");
    expect(header).toContain('scope="voice_lab:fault voice_lab:read voice_lab:run"');
    expect((await ledger.listAuthAudit(null)).some((audit) => audit.outcome === "denied")).toBe(true);
    expect(await ledger.countActiveRuns()).toBe(0);

    let deep: Record<string, unknown> = { terminal: true };
    for (let index = 0; index < 100; index += 1) deep = { nested: deep };
    const deepResponse = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(deep),
    });
    expect(deepResponse.status).toBe(401);
    expect((await deepResponse.json() as any).error.data._meta["mcp/www_authenticate"][0]).toContain("error_description=");
    expect((await ledger.listAuthAudit(null)).filter((audit) => audit.outcome === "denied")).toHaveLength(2);
    expect(await ledger.countActiveRuns()).toBe(0);
  });

  it("rejects authenticated malformed, oversized, deep, and schema-invalid requests at the real HTTP boundary", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const config = testConfig();
    const service = new VoiceLabService(ledger, config, async () => []);
    const authenticator = new StaticBearerAuthenticator(config.bearerToken, config.bearerSubject, config.faultBearerToken);
    const app = createHttpApp(config, service, ledger, authenticator);
    const httpServer = await listen(app, 0);
    servers.push(httpServer);
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;
    const headers = { authorization: `Bearer ${config.bearerToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const post = (raw: string, probeId?: string) => fetch(endpoint, { method: "POST", redirect: "manual", headers: { ...headers, ...(probeId ? { "x-sophia-voice-lab-probe-id": probeId } : {}) }, body: raw });

    const initialize = { jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "authenticated-boundary-test", version: "1" } } };
    const initialized = await post(JSON.stringify(initialize));
    expect(initialized.status).toBe(200);
    expect(initialized.url).toBe(endpoint);
    expect(await initialized.text()).toContain("sophia-voice-lab");

    const invalidCall = { jsonrpc: "2.0", id: "schema-invalid", method: "tools/call", params: { name: "start_voice_run", arguments: { environment: "production", target, scenario_id: "V-A01", scenario_version: "vt00.scenarios.v1", idempotency_key: "boundary-schema-invalid", unexpected: true } } };
    const invalid = await post(JSON.stringify(invalidCall));
    const invalidBody = await invalid.text();
    expect(invalid.status).toBe(200);
    expect(invalid.url).toBe(endpoint);
    expect(invalid.headers.get("location")).toBeNull();
    expect(invalidBody).toMatch(/Invalid arguments/i);

    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 70; index += 1) deep = { nested: deep };
    const deepRequest = { jsonrpc: "2.0", id: "deep", method: "tools/call", params: { name: "get_capabilities", arguments: deep } };
    const deepResponse = await post(JSON.stringify(deepRequest));
    expect(deepResponse.status).toBe(400);
    expect(await deepResponse.json()).toMatchObject({ error: { code: -32602, data: { error_code: "ARGUMENT_BOUNDS" } } });

    const malformedProbeId = randomUUID();
    const oversizedProbeId = randomUUID();
    const malformed = await post('{"jsonrpc":"2.0","id":"malformed",', malformedProbeId);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: -32700, data: { error_code: "MALFORMED_JSON" } } });

    const oversized = await post(JSON.stringify({ jsonrpc: "2.0", id: "oversized", method: "tools/call", params: { name: "get_capabilities", arguments: { padding: "x".repeat(150_000) } } }), oversizedProbeId);
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { data: { error_code: "BODY_TOO_LARGE" } } });

    const audits = await ledger.listAuthAuditByArgumentHashes(config.bearerSubject, [canonicalRequestHash(initialize), canonicalRequestHash(invalidCall), sha256("bounded-unparsed-request")], new Date(0));
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "mcp.authenticate", outcome: "allowed", argumentHash: canonicalRequestHash(initialize) }),
      expect.objectContaining({ action: "mcp.authenticate", outcome: "allowed", argumentHash: canonicalRequestHash(invalidCall) }),
      expect.objectContaining({ action: "mcp.request", outcome: "denied", argumentHash: sha256("bounded-unparsed-request") }),
      expect.objectContaining({ action: "mcp.body", outcome: "denied", argumentHash: sha256("bounded-unparsed-request") }),
    ]));
    const bodyAudits = audits.filter((audit) => audit.action === "mcp.body");
    expect(bodyAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({ detail: expect.objectContaining({ error_class: "MALFORMED_JSON", probe_id_sha256: sha256(malformedProbeId) }) }),
      expect.objectContaining({ detail: expect.objectContaining({ error_class: "BODY_TOO_LARGE", probe_id_sha256: sha256(oversizedProbeId) }) }),
    ]));
    expect(bodyAudits.filter((audit) => audit.detail.probe_id_sha256 === sha256(randomUUID()))).toHaveLength(0);
    expect(await ledger.countActiveRuns()).toBe(0);
  });

  it("rejects an unsupported fixture through authenticated public MCP before creating an input operation", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const config = testConfig();
    const service = new VoiceLabService(ledger, config, async () => []);
    const caller = { subject: config.bearerSubject, scopes: new Set(["voice_lab:read", "voice_lab:run"]) };
    const started = await service.startVoiceRun(caller, { environment: "production", target, scenario_id: "V-S02", scenario_version: "vt00.scenarios.v1", idempotency_key: "s02-http-fixture-owner" });
    const runId = started.run_id!;
    const before = await ledger.getRun(runId);
    const operationsBefore = await ledger.listOperations(runId);
    const authenticator = new StaticBearerAuthenticator(config.bearerToken, config.bearerSubject, config.faultBearerToken);
    const app = createHttpApp(config, service, ledger, authenticator);
    const httpServer = await listen(app, 0);
    servers.push(httpServer);
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const probeId = randomUUID();
    const request = { jsonrpc: "2.0", id: `s02-fixture-${randomUUID()}`, method: "tools/call", params: { name: "speak", arguments: { run_id: runId, fixture_id: "s02-governed-unknown-fixture", idempotency_key: "s02-http-fixture" } } };
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${config.bearerToken}`, "content-type": "application/json", accept: "application/json, text/event-stream", "x-sophia-voice-lab-probe-id": probeId }, body: JSON.stringify(request) });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("FIXTURE_NOT_FOUND");
    expect(await ledger.listOperations(runId)).toHaveLength(operationsBefore.length);
    expect((await ledger.getRun(runId))?.latestCursor).toBe(before?.latestCursor);
    const audits = await ledger.listAuthAuditByArgumentHashes(config.bearerSubject, [canonicalRequestHash(request)], new Date(0));
    expect(audits).toContainEqual(expect.objectContaining({ action: "mcp.authenticate", outcome: "allowed", argumentHash: canonicalRequestHash(request), detail: expect.objectContaining({ probe_id_sha256: sha256(probeId) }) }));
  });

  it("requires voice_lab:read before resolving any artifact identifier", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const run = testRun({ state: "failed_harness", cleanupComplete: true });
    await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: "resource-scope", requestHash: sha256("resource-scope"), input: {} }, { global: 1, caller: 1 });
    const artifactId = randomUUID();
    const bytes = Buffer.from("scoped evidence");
    await ledger.saveArtifact({ id: artifactId, runId: run.id, kind: "manifest_attachment", contentType: "application/json", sha256: sha256(bytes), bytes, createdAt: new Date() });
    const service = new VoiceLabService(ledger, testConfig(), async () => []);
    const server = createVoiceLabMcpServer(service, ledger, { subject: run.callerId, scopes: new Set(["voice_lab:fault"]) });
    const client = new Client({ name: "fault-only-resource-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await expect(client.readResource({ uri: `voice-lab://evidence/${artifactId}` })).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
