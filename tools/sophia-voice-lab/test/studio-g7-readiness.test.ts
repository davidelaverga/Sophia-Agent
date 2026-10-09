import type { Server as HttpServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpApp, createWebBootIdentity, listen } from "../src/http-server.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { VoiceLabService } from "../src/service.js";
import { testWorkerHeartbeat } from "./helpers.js";
import { API_SHA, DEFAULT_ORIGINS, FAKE_PUBLISHABLE_KEY, STUDIO_SHA, studioTestConfig } from "./studio-g7-helpers.js";

const nativeFetch = globalThis.fetch;

async function start(config: ReturnType<typeof studioTestConfig>, ledger: MemoryVoiceLabLedger): Promise<{ server: HttpServer; url: string }> {
  const service = new VoiceLabService(ledger, config, async () => []);
  const webBoot = createWebBootIdentity(config, "studio-readiness-test-web-boot", "studio-readiness-test-web-instance", new Date(0));
  const app = createHttpApp(config, service, ledger, { authenticate: vi.fn(async () => ({ subject: "ordinary", scopes: new Set(["voice_lab:read"]) })) }, undefined, undefined, webBoot);
  const server = await listen(app, 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

/** Studio, API and Supabase Auth stand-ins; records every outbound request. */
function studioFetch(calls: Array<{ url: string; authorization: string | null }>, options: { apiCommit?: string; apiReady?: boolean } = {}) {
  return async (input: URL | string | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "127.0.0.1") return nativeFetch(input, init);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: `${url.origin}${url.pathname}`, authorization: headers.authorization ?? null });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.origin === DEFAULT_ORIGINS.studio && url.pathname === "/") return new Response(`<meta name="sophia-build" content="${STUDIO_SHA}">`, { status: 200, headers: { "content-type": "text/html" } });
    if (url.origin === DEFAULT_ORIGINS.api && url.pathname === "/health") return json({ ok: true, commit: options.apiCommit ?? API_SHA });
    if (url.origin === DEFAULT_ORIGINS.api && url.pathname === "/ready") return json({ ready: options.apiReady ?? true }, options.apiReady === false ? 503 : 200);
    if (url.origin === DEFAULT_ORIGINS.supabase && url.pathname === "/auth/v1/health" && headers.apikey === FAKE_PUBLISHABLE_KEY) return json({ name: "GoTrue" });
    return json({ error: "not_found" }, 404);
  };
}

describe("target-aware /readyz for the Studio G7 kind", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("answers for the Studio, its API and Supabase Auth, without credentials and without the legacy probes", async () => {
    const config = studioTestConfig(undefined, { SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
    const ledger = new MemoryVoiceLabLedger("test");
    await ledger.heartbeatWorker(testWorkerHeartbeat(config));
    const calls: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal("fetch", studioFetch(calls));
    const harness = await start(config, ledger);
    const response = await nativeFetch(`${harness.url}/readyz`);
    const payload = await response.json() as Record<string, unknown>;
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: "ready", target_kind: "studio-livekit-g7-v1", execution: "kill_switch_engaged", mutation_ready: false,
      components: {
        target_environment: { ok: true, target_kind: "studio-livekit-g7-v1", credentials_used: false, studio: { identity: { status: "verified" } }, api: { ready: true, identity: { status: "verified" } }, supabase_auth: { ok: true } },
        test_auth: { ok: true, status: "not_applicable_for_studio_target" },
        browser_worker: { ready: true },
      },
    });
    expect(calls.map((call) => call.url)).toEqual(expect.arrayContaining([`${DEFAULT_ORIGINS.studio}/`, `${DEFAULT_ORIGINS.api}/health`, `${DEFAULT_ORIGINS.api}/ready`, `${DEFAULT_ORIGINS.supabase}/auth/v1/health`]));
    expect(calls.every((call) => call.authorization === null)).toBe(true);
    expect(calls.some((call) => call.url.startsWith("http://frontend.test") || call.url.startsWith("http://gateway.test"))).toBe(false);
  });

  it("is not ready on a deployment mismatch, an unready API, or a missing worker", async () => {
    for (const [label, options, heartbeat] of [["api mismatch", { apiCommit: "4".repeat(40) }, true], ["api not ready", { apiReady: false }, true], ["no worker", {}, false]] as const) {
      const config = studioTestConfig(undefined, { SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
      const ledger = new MemoryVoiceLabLedger("test");
      if (heartbeat) await ledger.heartbeatWorker(testWorkerHeartbeat(config));
      vi.stubGlobal("fetch", studioFetch([], options));
      const harness = await start(config, ledger);
      const response = await nativeFetch(`${harness.url}/readyz`);
      const payload = await response.json() as Record<string, unknown>;
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
      expect(response.status, label).toBe(503);
      expect(payload.status, label).toBe("not_ready");
      vi.unstubAllGlobals();
    }
  });
});
