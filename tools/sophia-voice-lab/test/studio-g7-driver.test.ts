import { describe, expect, it } from "vitest";

import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import { VoiceLabError } from "../src/domain.js";
import { StudioG7Driver } from "../src/studio-g7/studio-driver.js";
import { canonicalJson } from "../src/studio-g7/contract.js";
import { recoveryTransportBinding } from "../src/recovery-control.js";
import { testRun } from "./helpers.js";
import {
  API_SHA, DEFAULT_ORIGINS, EXCHANGE_UUID, FAKE_EMAIL, FAKE_PASSWORD, FAKE_PUBLISHABLE_KEY, PRINCIPAL_UUID, PROJECT_UUID, STUDIO_SHA,
  studioRun, studioTestConfig,
} from "./studio-g7-helpers.js";

/** A deterministic stand-in for Supabase Auth and the Studio member API. */
class FakeStudioBackend {
  exchangeId: string | null = EXCHANGE_UUID;
  readonly calls: Array<{ method: string; path: string; authorization: string | null }> = [];
  issued = 0;
  revoked = new Set<string>();
  password = FAKE_PASSWORD;
  apiCommit: string | null = API_SHA;
  studioMeta = `<meta name="sophia-build" content="${STUDIO_SHA}">`;
  apiDown = false;

  fetch = async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorization = headers.authorization ?? null;
    this.calls.push({ method, path: `${url.origin}${url.pathname}${url.search}`, authorization });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.origin === DEFAULT_ORIGINS.supabase) {
      if (headers.apikey !== FAKE_PUBLISHABLE_KEY) return json({ error: "no_api_key" }, 401);
      if (url.pathname === "/auth/v1/token") {
        const body = JSON.parse(String(init?.body)) as { email: string; password: string };
        if (body.email !== FAKE_EMAIL || body.password !== this.password) return json({ error: "invalid_grant", error_description: "Invalid login credentials" }, 400);
        this.issued += 1;
        return json({ access_token: `fake-access-token-${this.issued}-xxxxxxxx`, refresh_token: `fake-refresh-${this.issued}`, token_type: "bearer", expires_in: 3_600, expires_at: Math.floor(Date.now() / 1_000) + 3_600, user: { id: PRINCIPAL_UUID } });
      }
      if (url.pathname === "/auth/v1/logout" && url.searchParams.get("scope") === "global") {
        const token = authorization?.replace(/^Bearer /, "") ?? "";
        if (!token.startsWith("fake-access-token-") || this.revoked.has(token)) return json({}, 401);
        this.revoked.add(token);
        return new Response(null, { status: 204 });
      }
    }
    if (url.origin === DEFAULT_ORIGINS.studio && url.pathname === "/") return new Response(`<!doctype html><html><head>${this.studioMeta}</head></html>`, { status: 200, headers: { "content-type": "text/html" } });
    if (url.origin === DEFAULT_ORIGINS.api) {
      if (url.pathname === "/health") return json({ ok: true, commit: this.apiCommit });
      if (this.apiDown) return json({ error: "unavailable" }, 503);
      if (!authorization?.startsWith("Bearer fake-access-token-")) return json({ error: "unauthorized" }, 401);
      if (url.pathname === `/api/v1/projects/${PROJECT_UUID}/snapshot`) return json({ room: { id: "room-g7", sophia: { exchangeId: this.exchangeId, inputEpoch: 2 } }, work: [] });
      if (method === "POST" && url.pathname === `/api/v1/exchanges/${EXCHANGE_UUID}/end`) { this.exchangeId = null; return new Response(null, { status: 204 }); }
    }
    return json({ error: "not_found" }, 404);
  };
}

function driverFor(backend: FakeStudioBackend, timers: Array<{ callback: () => void; ms: number }> = []) {
  const config = studioTestConfig();
  let clock = Date.now();
  const readinessDriver: Pick<VoiceBrowserDriver, "readiness" | "close"> = { readiness: async () => ({ ok: true, detail: "fixture" }), close: async () => undefined };
  const driver = new StudioG7Driver(config, config.studioG7!, {
    fetchImpl: backend.fetch,
    readinessDriver,
    now: () => clock,
    wait: async (ms) => { clock += ms; },
    setTimer: (callback, ms) => { timers.push({ callback, ms }); return {}; },
    clearTimer: () => undefined,
    timeouts: { exchangeEndMs: 4_000 },
  });
  return { config, driver };
}

describe("Studio G7 driver cleanup without a browser", () => {
  it("abort ends the exchange through the API and signs out globally when the browser is gone", async () => {
    const backend = new FakeStudioBackend();
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    expect(driver.hasSession(run.id)).toBe(false);
    const result = await driver.abort(run, "BROWSER_EXECUTION_EPOCH_LOST");
    expect(backend.exchangeId).toBeNull();
    expect(backend.calls.filter((call) => call.method === "POST" && call.path.endsWith(`/api/v1/exchanges/${EXCHANGE_UUID}/end`))).toHaveLength(1);
    expect(backend.calls.some((call) => call.path.endsWith("/auth/v1/logout?scope=global"))).toBe(true);
    const ended = result.events.find((event) => event.kind === "studio.cleanup.exchange_ended");
    expect(ended?.payload).toMatchObject({ confirmed: true, basis: "api_end", exchange_id: EXCHANGE_UUID, verified_by: "member_snapshot", join: "member_snapshot_after_driver_loss" });
    expect(result.events.find((event) => event.kind === "studio.cleanup.signed_out")?.payload).toMatchObject({ confirmed: true, scope: "global", http_status: 204 });
    const serialized = JSON.stringify(result.events);
    expect(serialized).not.toContain(FAKE_PASSWORD);
    expect(serialized).not.toContain("fake-access-token-");
    expect(serialized).not.toContain(FAKE_PUBLISHABLE_KEY);
  });

  it("recover is idempotent and reports complete only with exchange end and sign-out proven", async () => {
    const backend = new FakeStudioBackend();
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    const binding = recoveryTransportBinding({ runId: run.id, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, gatewayOrigin: run.target.gatewayUrl });
    const first = await driver.recover(binding, "unused");
    expect(first.events.find((event) => event.kind === "studio.cleanup.recovery")?.payload).toMatchObject({ complete: true, exchange_ended: true, signed_out: true });
    const second = await driver.recover(binding, "unused");
    expect(second.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: true, basis: "no_exchange_opened_by_run" });
    expect(backend.calls.filter((call) => call.path.endsWith("/end"))).toHaveLength(1);

    const down = new FakeStudioBackend();
    down.apiDown = true;
    const unavailable = await driverFor(down).driver.recover(binding, "unused");
    expect(unavailable.events.find((event) => event.kind === "studio.cleanup.recovery")?.payload).toMatchObject({ complete: false, exchange_ended: false });
  });

  it("types a rejected password during cleanup without leaking credentials", async () => {
    const backend = new FakeStudioBackend();
    backend.password = "a-different-fake-password-002";
    const { config, driver } = driverFor(backend);
    const result = await driver.abort(studioRun(config), "TEST");
    const ended = result.events.find((event) => event.kind === "studio.cleanup.exchange_ended");
    expect(ended?.payload).toMatchObject({ confirmed: false, basis: "member_api_unavailable", error_code: "STUDIO_AUTH_REJECTED" });
    expect(result.events.find((event) => event.kind === "studio.cleanup.signed_out")?.payload).toMatchObject({ confirmed: false, session_basis: "STUDIO_AUTH_REJECTED" });
    expect(JSON.stringify(result.events)).not.toContain(FAKE_PASSWORD);
    expect(backend.exchangeId).toBe(EXCHANGE_UUID);
  });

  it("the run-deadline watchdog ends the exchange through the API even with no page", async () => {
    const backend = new FakeStudioBackend();
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    const events = await driver.fireWatchdog(run.id);
    expect(events[0]).toMatchObject({ kind: "studio.watchdog.fired", payload: { exchange_end_confirmed: true } });
    expect(backend.exchangeId).toBeNull();
    // Orphaned watchdog receipts are returned by the next cleanup call for durable persistence.
    const later = await driver.abort(run, "RUN_EXPIRED");
    expect(later.events.map((event) => event.kind)).toContain("studio.watchdog.fired");
  });
});

describe("Studio G7 driver replay safety", () => {
  it("never reuses a dedupe key for different evidence across repeated cleanup calls", async () => {
    const backend = new FakeStudioBackend();
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    const binding = recoveryTransportBinding({ runId: run.id, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, gatewayOrigin: run.target.gatewayUrl });
    const batches = [
      (await driver.abort(run, "FIRST")).events,
      (await driver.recover(binding, "unused")).events,
      (await driver.abort(run, "SECOND")).events,
      (await driver.fireWatchdog(run.id)),
      (await driver.recover(binding, "unused")).events,
    ];
    const byKey = new Map<string, string>();
    for (const event of batches.flat()) {
      expect(event.dedupeKey).toBeTruthy();
      const body = canonicalJson({ kind: event.kind, source: event.source, payload: event.payload });
      const prior = byKey.get(event.dedupeKey!);
      if (prior !== undefined) expect(body).toBe(prior);
      byKey.set(event.dedupeKey!, body);
    }
  });

  it("an adopted durable exchange join never ends a different open exchange", async () => {
    const backend = new FakeStudioBackend();
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    driver.adoptExchangeJoin(run.id, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    const result = await driver.abort(run, "RECOVER_OLD_RUN");
    expect(backend.exchangeId).toBe(EXCHANGE_UUID);
    expect(backend.calls.some((call) => call.path.endsWith("/end"))).toBe(false);
    expect(result.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: true, basis: "already_ended", exchange_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", join: "retained" });
  });
});

describe("Studio G7 driver target checks", () => {
  it("verifies deployed identities: missing is typed unavailable, mismatch fails", async () => {
    const backend = new FakeStudioBackend();
    backend.studioMeta = "";
    backend.apiCommit = null;
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    const verified = await driver.verifyTarget(run);
    expect(verified.observedDeployment).toEqual({});
    expect(verified.events[0]?.payload).toMatchObject({ phase: "pre_resource", api: { status: "unavailable", reason: "identity_not_published" }, studio: { status: "unavailable", reason: "identity_not_published" } });

    const mismatched = new FakeStudioBackend();
    mismatched.apiCommit = "4".repeat(40);
    await expect(driverFor(mismatched).driver.verifyTarget(run)).rejects.toMatchObject({ detail: { code: "DEPLOYMENT_MISMATCH", category: "deployment", details: { component: "api" } } });
    const ok = await driverFor(new FakeStudioBackend()).driver.verifyTarget(run);
    expect(ok.observedDeployment).toEqual({ frontend: STUDIO_SHA, backend: API_SHA });
  });

  it("types a start that failed before launch as allocation-free cleanup without any sign-in", async () => {
    const backend = new FakeStudioBackend();
    backend.apiCommit = "4".repeat(40);
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    await expect(driver.start(run, "unused")).rejects.toMatchObject({ detail: { code: "DEPLOYMENT_MISMATCH" } });
    expect(driver.hasSession(run.id)).toBe(false);
    const callsBefore = backend.calls.length;
    const recovered = await driver.recover(recoveryTransportBinding({ runId: run.id, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, gatewayOrigin: run.target.gatewayUrl }), "unused");
    expect(backend.calls.length).toBe(callsBefore);
    expect(backend.issued).toBe(0);
    expect(recovered.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: true, basis: "no_exchange_opened_by_run", verified_by: "driver_never_requested_exchange" });
    expect(recovered.events.find((event) => event.kind === "studio.cleanup.signed_out")?.payload).toMatchObject({ confirmed: true, basis: "no_session_issued" });
    expect(recovered.events.find((event) => event.kind === "cleanup.browser_context_absent")?.payload).toMatchObject({ browser_never_allocated: true, basis: "driver_failed_before_browser_launch" });
    expect(recovered.events.find((event) => event.kind === "studio.cleanup.recovery")?.payload).toMatchObject({ complete: true });
  });

  it("refuses legacy scenarios before allocating any resource and has no socket rotation", async () => {
    const backend = new FakeStudioBackend();
    const { driver } = driverFor(backend);
    const legacy = testRun({ scenarioId: "V-A01" });
    const error = await driver.start(legacy, "unused").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VoiceLabError);
    expect((error as VoiceLabError).detail).toMatchObject({ code: "SCENARIO_UNSUPPORTED_FOR_TARGET", details: { status: "unsupported_for_target" } });
    expect(backend.calls).toHaveLength(0);
    await expect(driver.rotate()).rejects.toMatchObject({ detail: { code: "STUDIO_OPERATION_UNSUPPORTED", details: { status: "unsupported" } } });
    await expect(driver.continueSession()).resolves.toEqual([]);
  });
});
