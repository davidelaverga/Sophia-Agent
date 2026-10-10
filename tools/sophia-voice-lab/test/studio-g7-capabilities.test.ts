import { readFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpApp, createWebBootIdentity, listen, webTargetProbes } from "../src/http-server.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import type { AuthenticatedCaller } from "../src/security.js";
import { VoiceLabService, assertFreshProductAdmissionProof } from "../src/service.js";
import { SHA, SHA_B, SHA_C, SHA_D, testConfig } from "./helpers.js";
import { API_SHA, BRIDGE_SHA, DEFAULT_ORIGINS, FAKE_EMAIL, FAKE_PASSWORD, FAKE_PUBLISHABLE_KEY, PROJECT_UUID, STUDIO_SHA, studioTestConfig } from "./studio-g7-helpers.js";

/**
 * Codex P2 r4235503631 (root's reply r4235517395): on a Studio G7 deployment
 * (no legacy readiness target, a valid studioG7 config), /readyz answered for
 * the Studio while get_capabilities reported `target_environment` as
 * `unconfigured`. get_capabilities now reports the Studio's safe origins and
 * pins with the very probe /readyz runs (webTargetProbes), and the legacy
 * target keeps its shape, probe and admission proof.
 */
const nativeFetch = globalThis.fetch;
const caller: AuthenticatedCaller = { subject: "capabilities-reader", scopes: new Set(["voice_lab:read"]) };

interface StudioStub { apiCommit?: string | null; studioUnreachable?: boolean }

/** Studio, API and Supabase Auth stand-ins (as studio-g7-readiness.test.ts); records every outbound request. */
function studioFetch(calls: Array<{ url: string; method: string; authorization: string | null }>, stub: StudioStub = {}) {
  return async (input: URL | string | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "127.0.0.1") return nativeFetch(input, init);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: `${url.origin}${url.pathname}`, method: init?.method ?? "GET", authorization: headers.authorization ?? null });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.origin === DEFAULT_ORIGINS.studio && url.pathname === "/") {
      if (stub.studioUnreachable) throw new TypeError("fetch failed");
      return new Response(`<meta name="sophia-build" content="${STUDIO_SHA}">`, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url.origin === DEFAULT_ORIGINS.api && url.pathname === "/health") return json(stub.apiCommit === null ? { ok: true } : { ok: true, commit: stub.apiCommit ?? API_SHA });
    if (url.origin === DEFAULT_ORIGINS.api && url.pathname === "/ready") return json({ ready: true });
    if (url.origin === DEFAULT_ORIGINS.supabase && url.pathname === "/auth/v1/health" && headers.apikey === FAKE_PUBLISHABLE_KEY) return json({ name: "GoTrue" });
    return json({ message: "not found", statusCode: 404 }, 404);
  };
}

/** get_capabilities' target_environment and /readyz's target_environment, over the same stand-ins, as the web process wires them. */
async function bothViews(config: ReturnType<typeof testConfig>, stub: StudioStub = {}) {
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  vi.stubGlobal("fetch", studioFetch(calls, stub));
  const ledger = new MemoryVoiceLabLedger("test");
  const probes = webTargetProbes(config);
  const service = new VoiceLabService(ledger, config, async () => [], undefined, probes.legacy, undefined, probes.studio);
  const capabilities = await service.getCapabilities(caller, {});
  const webBoot = createWebBootIdentity(config, "capabilities-test-web-boot", "capabilities-test-web-instance", new Date(0));
  const app = createHttpApp(config, service, ledger, { authenticate: vi.fn(async () => caller) }, undefined, undefined, webBoot);
  const server: HttpServer = await listen(app, 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  const readyz = await (await nativeFetch(`http://127.0.0.1:${address.port}/readyz`)).json() as { components: { target_environment: Record<string, unknown> } };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { target: capabilities.data.target_environment as Record<string, unknown>, readyzTarget: readyz.components.target_environment, calls };
}

describe("get_capabilities target_environment on a Studio G7 deployment (Codex P2 r4235503631)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("Studio-only: configured, with the Studio's safe origins and pins, and the identity /readyz reports for the same adapters", async () => {
    const config = studioTestConfig();
    expect(config.readinessTarget).toBeNull();
    const { target, readyzTarget, calls } = await bothViews(config);
    expect(target).toEqual({
      environment: "production",
      target_kind: "studio-livekit-g7-v1",
      studio_origin: DEFAULT_ORIGINS.studio,
      api_origin: DEFAULT_ORIGINS.api,
      supabase_origin: DEFAULT_ORIGINS.supabase,
      expected_deployment: { studio: STUDIO_SHA, api: API_SHA, bridge: BRIDGE_SHA },
      current_identity: readyzTarget,
    });
    expect(target.current_identity).toMatchObject({ ok: true, status: "ready", credentials_used: false,
      studio: { identity: { status: "verified", commit: STUDIO_SHA, expected: STUDIO_SHA } }, api: { ready: true, identity: { status: "verified", commit: API_SHA, expected: API_SHA } } });
    // Safe values only: never the publishable key, the project, or the principal's credentials.
    const projected = JSON.stringify(target);
    for (const [label, value] of [["publishable key", FAKE_PUBLISHABLE_KEY], ["project id", PROJECT_UUID], ["principal email", FAKE_EMAIL], ["principal password", FAKE_PASSWORD]] as const) {
      expect(projected.includes(value), `the ${label} is never projected`).toBe(false);
    }
    // Read-only: unauthenticated GETs only (no sign-in, no mutation), the same four endpoints as /readyz.
    expect(calls.every((call) => call.method === "GET" && call.authorization === null)).toBe(true);
    expect(new Set(calls.map((call) => call.url))).toEqual(new Set([`${DEFAULT_ORIGINS.studio}/`, `${DEFAULT_ORIGINS.api}/health`, `${DEFAULT_ORIGINS.api}/ready`, `${DEFAULT_ORIGINS.supabase}/auth/v1/health`]));
  });

  it("an unpublished identity is reported `unavailable`, as /readyz reports it, never verified and with no invented commit", async () => {
    const { target, readyzTarget } = await bothViews(studioTestConfig(), { apiCommit: null });
    expect(target.current_identity).toEqual(readyzTarget);
    const api = (target.current_identity as { api: { identity: Record<string, unknown> } }).api.identity;
    expect(api).toMatchObject({ status: "unavailable", reason: "identity_not_published", expected: API_SHA });
    expect(api).not.toHaveProperty("commit");
  });

  it("an unreachable Studio is reported `unavailable` and not ready, as /readyz reports it", async () => {
    const { target, readyzTarget } = await bothViews(studioTestConfig(), { studioUnreachable: true });
    expect(target.current_identity).toEqual(readyzTarget);
    expect(target.current_identity).toMatchObject({ ok: false, status: "not_ready", studio: { reachable: false, identity: { status: "unavailable", reason: "identity_endpoint_unavailable" } } });
    expect((target.current_identity as { studio: { identity: Record<string, unknown> } }).studio.identity).not.toHaveProperty("commit");
  });

  it("a proven mismatch (the observed commit differs from the pin) is reported as a mismatch, not ok, as /readyz reports it", async () => {
    const observed = "9".repeat(40);
    const { target, readyzTarget } = await bothViews(studioTestConfig(), { apiCommit: observed });
    expect(target.current_identity).toEqual(readyzTarget);
    expect(target.current_identity).toMatchObject({ ok: false, status: "deployment_mismatch", api: { identity: { status: "mismatch", commit: observed, expected: API_SHA } } });
  });

  it("legacy-positive control: the legacy target keeps its exact shape and its own probe; the Studio probe is never consulted", async () => {
    const config = testConfig({
      SOPHIA_VOICE_LAB_TARGET_FRONTEND_URL: "http://frontend.test", SOPHIA_VOICE_LAB_TARGET_GATEWAY_URL: "http://gateway.test",
      SOPHIA_VOICE_LAB_TARGET_VOICE_URL: "http://voice.test", SOPHIA_VOICE_LAB_TARGET_LANGGRAPH_URL: "http://langgraph.test",
      SOPHIA_VOICE_LAB_EXPECTED_FRONTEND_SHA: SHA, SOPHIA_VOICE_LAB_EXPECTED_BACKEND_SHA: SHA_B, SOPHIA_VOICE_LAB_EXPECTED_VOICE_SHA: SHA_C, SOPHIA_VOICE_LAB_EXPECTED_LANGGRAPH_SHA: SHA_D,
    });
    const legacyProof = { ok: true, status: "verified", builds: { frontend: { ready: true, expected: SHA, observed: SHA } } };
    const studioProbe = vi.fn(async () => ({ ok: true, status: "ready" }));
    const service = new VoiceLabService(new MemoryVoiceLabLedger("test"), config, async () => [], undefined, async () => legacyProof, undefined, studioProbe);
    const capabilities = await service.getCapabilities(caller, {});
    expect(capabilities.data.target_environment).toEqual({
      environment: "production", frontend_url: "http://frontend.test", gateway_url: "http://gateway.test", voice_url: "http://voice.test", langgraph_url: "http://langgraph.test",
      expected_deployment: { frontend: SHA, backend: SHA_B, voice: SHA_C }, expected_dependencies: { langgraph: SHA_D }, current_identity: legacyProof,
    });
    expect(studioProbe).not.toHaveBeenCalled();
    // A legacy deployment without a readiness target keeps its unconfigured shape.
    const bare = new VoiceLabService(new MemoryVoiceLabLedger("test"), testConfig(), async () => [], undefined, async () => ({ ok: false, status: "unconfigured", reason: "target_configuration_missing" }), undefined, studioProbe);
    expect((await bare.getCapabilities(caller, {})).data.target_environment).toEqual({ environment: "production", status: "unconfigured", current_identity: { ok: false, status: "unconfigured", reason: "target_configuration_missing" } });
    expect(studioProbe).not.toHaveBeenCalled();
  });

  it("the web process wires exactly these probes: the legacy one as the admission proof, the Studio one apart from it", () => {
    // bin/web.ts boots the process when imported, so its one wiring line is pinned by its source.
    const web = readFileSync(new URL("../src/bin/web.ts", import.meta.url), "utf8");
    expect(web).toContain("const targetProbes = webTargetProbes(config);");
    expect(web).toMatch(/new VoiceLabService\(ledger, config, async \(\) => audio\.summaries\(\), async \(\) => audio\.ttsInfo\(\), targetProbes\.legacy, undefined, targetProbes\.studio\);/);
    expect(web).not.toContain("probeEffectiveTarget");
  });

  it("a Studio probe result can never stand as the legacy admission proof", async () => {
    const config = testConfig({
      SOPHIA_VOICE_LAB_TARGET_FRONTEND_URL: "http://frontend.test", SOPHIA_VOICE_LAB_TARGET_GATEWAY_URL: "http://gateway.test",
      SOPHIA_VOICE_LAB_TARGET_VOICE_URL: "http://voice.test", SOPHIA_VOICE_LAB_TARGET_LANGGRAPH_URL: "http://langgraph.test",
      SOPHIA_VOICE_LAB_EXPECTED_FRONTEND_SHA: SHA, SOPHIA_VOICE_LAB_EXPECTED_BACKEND_SHA: SHA_B, SOPHIA_VOICE_LAB_EXPECTED_VOICE_SHA: SHA_C, SOPHIA_VOICE_LAB_EXPECTED_LANGGRAPH_SHA: SHA_D,
    });
    const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
    vi.stubGlobal("fetch", studioFetch(calls));
    const studioReady = await webTargetProbes(studioTestConfig()).studio();
    expect(studioReady).toMatchObject({ ok: true, status: "ready" });
    // Even a ready Studio result fails the legacy proof closed (not "verified", no probe id, no legacy builds).
    expect(() => assertFreshProductAdmissionProof(config, config.readinessTarget!, studioReady)).toThrow();
    // The web process injects the two probes separately: the legacy callback never runs the Studio probe.
    const legacyOnStudio = await webTargetProbes(studioTestConfig()).legacy();
    expect(legacyOnStudio).toEqual({ ok: false, status: "unconfigured", builds: null, reason: "target_configuration_missing" });
  });
});
