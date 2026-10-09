import { describe, expect, it } from "vitest";

import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import { VoiceLabError } from "../src/domain.js";
import { StudioG7Driver } from "../src/studio-g7/studio-driver.js";
import { canonicalJson } from "../src/studio-g7/contract.js";
import { recoveryTransportBinding } from "../src/recovery-control.js";
import { testRun } from "./helpers.js";
import {
  API_SHA, DEFAULT_ORIGINS, EXCHANGE_UUID, FAKE_EMAIL, FAKE_PASSWORD, FAKE_PUBLISHABLE_KEY, GRANT_UUID, PRINCIPAL_UUID, PROJECT_UUID, STUDIO_SHA,
  bindingOf, evidenceEnvelope, guardReceipt, inputWindow, providerReceipt, sessionClosed, studioRun, studioTestConfig,
} from "./studio-g7-helpers.js";
import type { RunRecord } from "../src/domain.js";

const OTHER_EXCHANGE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_PRINCIPAL = "12345678-1234-4234-8234-123456789abc";

/** A deterministic stand-in for Supabase Auth and the Studio member API. */
class FakeStudioBackend {
  exchangeId: string | null = EXCHANGE_UUID;
  inputActorId: string | null = PRINCIPAL_UUID;
  readonly calls: Array<{ method: string; path: string; authorization: string | null }> = [];
  issued = 0;
  revoked = new Set<string>();
  password = FAKE_PASSWORD;
  apiCommit: string | null = API_SHA;
  studioMeta = `<meta name="sophia-build" content="${STUDIO_SHA}">`;
  apiDown = false;
  /** The evidence answer: built per request; null answers 404 (not the principal's, or the route is missing). */
  evidence: ((exchangeId: string) => Record<string, unknown> | null) | null = null;
  grantUser = PRINCIPAL_UUID;

  fetch = async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorization = headers.authorization ?? null;
    this.calls.push({ method, path: `${url.origin}${url.pathname}${url.search}`, authorization });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.origin === DEFAULT_ORIGINS.supabase) {
      if (headers.apikey !== FAKE_PUBLISHABLE_KEY) return json({ error: "no_api_key" }, 401);
      if (url.pathname === "/auth/v1/health") return json({ name: "GoTrue" });
      if (url.pathname === "/auth/v1/token") {
        const body = JSON.parse(String(init?.body)) as { email: string; password: string };
        if (body.email !== FAKE_EMAIL || body.password !== this.password) return json({ error: "invalid_grant", error_description: "Invalid login credentials" }, 400);
        this.issued += 1;
        return json({ access_token: `fake-access-token-${this.issued}-xxxxxxxx`, refresh_token: `fake-refresh-${this.issued}`, token_type: "bearer", expires_in: 3_600, expires_at: Math.floor(Date.now() / 1_000) + 3_600, user: { id: this.grantUser } });
      }
      if (url.pathname === "/auth/v1/logout") {
        const token = authorization?.replace(/^Bearer /, "") ?? "";
        if (!token.startsWith("fake-access-token-") || this.revoked.has(token)) return json({}, 401);
        this.revoked.add(token);
        return new Response(null, { status: 204 });
      }
    }
    if (url.origin === DEFAULT_ORIGINS.studio && url.pathname === "/") return new Response(`<!doctype html><html><head>${this.studioMeta}</head></html>`, { status: 200, headers: { "content-type": "text/html" } });
    if (url.origin === DEFAULT_ORIGINS.api) {
      if (url.pathname === "/health") return json({ ok: true, commit: this.apiCommit });
      if (url.pathname === "/ready") return this.apiDown ? json({ ready: false }, 503) : json({ ready: true });
      if (this.apiDown) return json({ error: "unavailable" }, 503);
      if (!authorization?.startsWith("Bearer fake-access-token-")) return json({ error: "unauthorized" }, 401);
      if (url.pathname === `/api/v1/projects/${PROJECT_UUID}/snapshot`) return json({ room: { id: "room-g7", sophia: { exchangeId: this.exchangeId, exchange: this.exchangeId ? "open" : "none", inputEpoch: 2, inputActorId: this.exchangeId ? this.inputActorId : null } }, work: [] });
      const evidence = /^\/api\/v1\/exchanges\/([0-9a-f-]{36})\/qualification-evidence$/.exec(url.pathname);
      if (evidence) {
        const body = this.evidence?.(evidence[1]!) ?? null;
        return body === null ? json({ code: "not_found", message: "Qualification evidence not found" }, 404) : json(body);
      }
      const end = /^\/api\/v1\/exchanges\/([0-9a-f-]{36})\/end$/.exec(url.pathname);
      if (method === "POST" && end) { if (this.exchangeId === end[1]) this.exchangeId = null; return new Response(null, { status: 204 }); }
    }
    return json({ error: "not_found" }, 404);
  };

  endCalls(): number { return this.calls.filter((call) => call.method === "POST" && call.path.endsWith("/end")).length; }
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

/** The durable write-ahead join a restarted worker hands the driver. */
function adopt(driver: StudioG7Driver, run: RunRecord, exchangeId: string | null = EXCHANGE_UUID, grantId: string | null = GRANT_UUID) {
  driver.adoptStudioJoin(run.id, { exchangeId, grantId, runBindingSha256: bindingOf(run), speakRequested: true, exchangeOpenedAtMs: Date.now() });
}

const binding = (run: RunRecord) => recoveryTransportBinding({ runId: run.id, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, gatewayOrigin: run.target.gatewayUrl });
const ofKind = (events: Array<{ kind: string; payload: Record<string, unknown> }>, kind: string) => events.filter((event) => event.kind === kind);

describe("Studio G7 cleanup never touches an exchange the run cannot prove is its own", () => {
  it("with no exchange join, a live exchange is never ended: the state is typed uncertain and the principal still signs out", async () => {
    const backend = new FakeStudioBackend();
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    const result = await driver.abort(run, "BROWSER_EXECUTION_EPOCH_LOST");
    expect(backend.exchangeId).toBe(EXCHANGE_UUID);
    expect(backend.endCalls()).toBe(0);
    expect(ofKind(result.events, "studio.cleanup.exchange_ended")[0]?.payload).toMatchObject({ confirmed: false, status: "uncertain", basis: "live_exchange_not_joined_to_run", exchange_id: null, join: "none" });
    expect(ofKind(result.events, "studio.cleanup.signed_out")[0]?.payload).toMatchObject({ confirmed: true, scope: "global", http_status: 204 });
    // Once nothing is live in the room, the run's exchange (whatever it was) is proven ended, read-only.
    backend.exchangeId = null;
    const later = await driver.recover(binding(run), "unused");
    expect(ofKind(later.events, "studio.cleanup.exchange_ended")[0]?.payload).toMatchObject({ confirmed: true, basis: "no_live_exchange_in_room" });
    expect(backend.endCalls()).toBe(0);
    const serialized = JSON.stringify([...result.events, ...later.events]);
    expect(serialized).not.toContain(FAKE_PASSWORD);
    expect(serialized).not.toContain("fake-access-token-");
    expect(serialized).not.toContain(FAKE_PUBLISHABLE_KEY);
  });

  it("ends a durably joined exchange only after its evidence proves the run's binding and grant", async () => {
    const backend = new FakeStudioBackend();
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    backend.evidence = (exchangeId) => exchangeId === EXCHANGE_UUID ? evidenceEnvelope(run, [["provider", providerReceipt(run, 0, "ready")]]) : null;
    adopt(driver, run);
    const result = await driver.abort(run, "WORKER_RESTARTED");
    expect(backend.exchangeId).toBeNull();
    expect(backend.endCalls()).toBe(1);
    expect(ofKind(result.events, "studio.exchange.ownership")[0]?.payload).toMatchObject({ status: "proven", exchange_id: EXCHANGE_UUID, grant_id: GRANT_UUID, run_binding_matches: true, join: "durable" });
    expect(ofKind(result.events, "studio.cleanup.exchange_ended").at(-1)?.payload).toMatchObject({ confirmed: true, status: "confirmed", basis: "api_end", exchange_id: EXCHANGE_UUID, ownership: "proven", join: "durable" });
    // The late receipts of the ended exchange are read with the same session.
    expect(ofKind(result.events, "studio.bridge_receipt").length).toBeGreaterThan(0);
  });

  it("an exchange whose evidence names another run, another grant, or is not answered is never ended", async () => {
    const run = studioRun(studioTestConfig());
    const grant = evidenceEnvelope(run, []).grant as Record<string, unknown>;
    const cases: Array<{ name: string; evidence: (exchangeId: string) => Record<string, unknown> | null; status: string; reason: string }> = [
      { name: "another run's binding", evidence: () => evidenceEnvelope(run, [], { grant: { ...grant, runBindingSha256: "e".repeat(64) } }), status: "mismatch", reason: "evidence_bound_to_another_run" },
      { name: "another grant", evidence: () => evidenceEnvelope(run, [], { grant: { ...grant, grantId: "22222222-3333-4444-8555-666666666666" } }), status: "mismatch", reason: "evidence_bound_to_another_grant" },
      { name: "not answered to the principal (or route missing)", evidence: () => null, status: "unavailable", reason: "evidence_not_answered_to_principal" },
      { name: "a receipt bound to another run inside the answer", evidence: () => evidenceEnvelope(run, [["provider", { ...providerReceipt(run, 0, "ready"), runBindingSha256: "d".repeat(64) }]]), status: "unavailable", reason: "evidence_rejected" },
    ];
    for (const item of cases) {
      const backend = new FakeStudioBackend();
      backend.evidence = item.evidence;
      const { driver } = driverFor(backend);
      adopt(driver, run);
      const result = await driver.abort(run, "WORKER_RESTARTED");
      expect(backend.exchangeId, item.name).toBe(EXCHANGE_UUID);
      expect(backend.endCalls(), item.name).toBe(0);
      expect(ofKind(result.events, "studio.exchange.ownership")[0]?.payload, item.name).toMatchObject({ status: item.status, reason: item.reason });
      expect(ofKind(result.events, "studio.cleanup.exchange_ended").at(-1)?.payload, item.name).toMatchObject({ confirmed: false, basis: "ownership_unproven_not_touched", ownership: item.status });
      expect(ofKind(result.events, "studio.cleanup.signed_out")[0]?.payload, item.name).toMatchObject({ confirmed: true });
    }
  });

  it("a joined exchange that is no longer live is proven ended read-only, even when another exchange is live", async () => {
    const backend = new FakeStudioBackend();
    backend.exchangeId = OTHER_EXCHANGE;
    backend.inputActorId = OTHER_PRINCIPAL;
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    adopt(driver, run);
    const result = await driver.abort(run, "RECOVER_OLD_RUN");
    expect(backend.exchangeId).toBe(OTHER_EXCHANGE);
    expect(backend.endCalls()).toBe(0);
    expect(ofKind(result.events, "studio.cleanup.exchange_ended")[0]?.payload).toMatchObject({ confirmed: true, basis: "run_exchange_not_live_other_exchange_live", exchange_id: EXCHANGE_UUID, ownership: "not_required" });
    expect(ofKind(result.events, "studio.exchange.ownership")).toHaveLength(0);
  });

  it("recover is idempotent and reports complete only with exchange end and sign-out proven", async () => {
    const backend = new FakeStudioBackend();
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    backend.evidence = () => evidenceEnvelope(run, []);
    adopt(driver, run);
    const first = await driver.recover(binding(run), "unused");
    expect(ofKind(first.events, "studio.cleanup.recovery")[0]?.payload).toMatchObject({ complete: true, exchange_ended: true, signed_out: true });
    const second = await driver.recover(binding(run), "unused");
    expect(ofKind(second.events, "studio.cleanup.exchange_ended")[0]?.payload).toMatchObject({ confirmed: true, basis: "run_exchange_not_live" });
    expect(backend.endCalls()).toBe(1);

    const down = new FakeStudioBackend();
    down.apiDown = true;
    const unavailable = await driverFor(down).driver.recover(binding(run), "unused");
    expect(ofKind(unavailable.events, "studio.cleanup.recovery")[0]?.payload).toMatchObject({ complete: false, exchange_ended: false, exchange_status: "unavailable" });
  });

  it("types a rejected password and a wrong principal during cleanup without leaking credentials", async () => {
    const backend = new FakeStudioBackend();
    backend.password = "a-different-fake-password-002";
    const { config, driver } = driverFor(backend);
    const result = await driver.abort(studioRun(config), "TEST");
    expect(ofKind(result.events, "studio.cleanup.exchange_ended")[0]?.payload).toMatchObject({ confirmed: false, status: "unavailable", basis: "member_api_unavailable", error_code: "STUDIO_AUTH_REJECTED" });
    expect(ofKind(result.events, "studio.cleanup.signed_out")[0]?.payload).toMatchObject({ confirmed: false, session_basis: "STUDIO_AUTH_REJECTED" });
    expect(JSON.stringify(result.events)).not.toContain(FAKE_PASSWORD);
    expect(backend.exchangeId).toBe(EXCHANGE_UUID);

    // The password grant answers for another `sub`: its session is revoked
    // locally, nothing is read or ended as that user.
    const wrong = new FakeStudioBackend();
    wrong.grantUser = OTHER_PRINCIPAL;
    const wrongDriver = driverFor(wrong).driver;
    const run = studioRun(config);
    adopt(wrongDriver, run);
    const mismatched = await wrongDriver.abort(run, "TEST");
    expect(ofKind(mismatched.events, "studio.cleanup.exchange_ended")[0]?.payload).toMatchObject({ confirmed: false, error_code: "STUDIO_AUTH_PRINCIPAL_MISMATCH" });
    expect(wrong.calls.some((call) => call.path.includes("/api/v1/"))).toBe(false);
    expect(wrong.endCalls()).toBe(0);
  });

  it("the run-deadline watchdog ends only an ownership-proven exchange, even with no page", async () => {
    const backend = new FakeStudioBackend();
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    const untouched = await driver.fireWatchdog(run.id);
    expect(untouched[0]).toMatchObject({ kind: "studio.watchdog.fired", payload: { exchange_end_confirmed: false } });
    expect(backend.exchangeId).toBe(EXCHANGE_UUID);

    const proven = new FakeStudioBackend();
    proven.evidence = () => evidenceEnvelope(run, []);
    const second = driverFor(proven).driver;
    adopt(second, run);
    const events = await second.fireWatchdog(run.id);
    expect(events[0]).toMatchObject({ kind: "studio.watchdog.fired", payload: { exchange_end_confirmed: true } });
    expect(proven.exchangeId).toBeNull();
    // Orphaned watchdog receipts are returned by the next cleanup call for durable persistence.
    const later = await second.abort(run, "RUN_EXPIRED");
    expect(later.events.map((event) => event.kind)).toContain("studio.watchdog.fired");
  });
});

describe("Studio G7 evidence completion and readiness", () => {
  it("re-reads late bridge receipts after End with a fresh session, then signs out again", async () => {
    const backend = new FakeStudioBackend();
    backend.exchangeId = null;
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    backend.evidence = () => evidenceEnvelope(run, [["input_window", inputWindow(run, 0, 1, 1_000)], ["session_closed", sessionClosed(run, 1, { windows: 1, turns: 0, replies: 0 })], ["guard", guardReceipt(run, "deadline")]], { state: "ended" });
    const events = await driver.refreshStudioEvidence(run, { exchangeId: EXCHANGE_UUID, grantId: GRANT_UUID, runBindingSha256: bindingOf(run), speakRequested: true, exchangeOpenedAtMs: null });
    expect(ofKind(events, "studio.bridge_grant")[0]?.payload).toMatchObject({ exchange_state: "ended" });
    expect(ofKind(events, "studio.bridge_receipt").map((event) => [event.payload.source, event.payload.seq, event.payload.kind])).toEqual([["bridge", 0, "input_window"], ["bridge", 1, "session_closed"], ["service", 0, "guard"]]);
    expect(ofKind(events, "studio.cleanup.signed_out")[0]?.payload).toMatchObject({ confirmed: true, scope: "global" });
    expect(backend.calls.filter((call) => call.path.includes("/api/v1/")).map((call) => call.path.replace(DEFAULT_ORIGINS.api, ""))).toEqual([`/api/v1/exchanges/${EXCHANGE_UUID}/qualification-evidence`]);
    expect(backend.endCalls()).toBe(0);
    // Without a durable exchange join there is nothing to refresh and no sign-in.
    const issued = backend.issued;
    expect(await driver.refreshStudioEvidence(run, { exchangeId: null, grantId: null, runBindingSha256: bindingOf(run), speakRequested: true, exchangeOpenedAtMs: null })).toEqual([]);
    expect(backend.issued).toBe(issued);
  });

  it("answers readiness for the Studio target without any credential", async () => {
    const backend = new FakeStudioBackend();
    const { driver } = driverFor(backend);
    const ready = await driver.studioReadiness();
    expect(ready).toMatchObject({ ok: true, status: "ready", target_kind: "studio-livekit-g7-v1", credentials_used: false, studio: { identity: { status: "verified" } }, api: { ready: true, identity: { status: "verified" } }, supabase_auth: { ok: true } });
    expect(backend.issued).toBe(0);
    expect(backend.calls.every((call) => call.authorization === null)).toBe(true);
    const mismatch = new FakeStudioBackend();
    mismatch.apiCommit = "4".repeat(40);
    expect(await driverFor(mismatch).driver.studioReadiness()).toMatchObject({ ok: false, status: "deployment_mismatch" });
    const down = new FakeStudioBackend();
    down.apiDown = true;
    expect(await driverFor(down).driver.studioReadiness()).toMatchObject({ ok: false, status: "not_ready", api: { ready: false, ready_http_status: 503 } });
  });
});

describe("Studio G7 driver replay safety", () => {
  it("never reuses a dedupe key for different evidence across repeated cleanup calls", async () => {
    const backend = new FakeStudioBackend();
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    backend.evidence = () => evidenceEnvelope(run, [["provider", providerReceipt(run, 0, "ready")]]);
    const batches = [
      (await driver.abort(run, "FIRST")).events,
      (await driver.recover(binding(run), "unused")).events,
    ];
    const second = driverFor(backend).driver;
    adopt(second, run);
    batches.push(
      (await second.abort(run, "SECOND")).events,
      (await second.fireWatchdog(run.id)),
      (await second.recover(binding(run), "unused")).events,
      await second.refreshStudioEvidence(run, { exchangeId: EXCHANGE_UUID, grantId: GRANT_UUID, runBindingSha256: bindingOf(run), speakRequested: true, exchangeOpenedAtMs: null }),
      await second.refreshStudioEvidence(run, { exchangeId: EXCHANGE_UUID, grantId: GRANT_UUID, runBindingSha256: bindingOf(run), speakRequested: true, exchangeOpenedAtMs: null }),
    );
    const byKey = new Map<string, string>();
    for (const event of batches.flat()) {
      expect(event.dedupeKey).toBeTruthy();
      const body = canonicalJson({ kind: event.kind, source: event.source, payload: event.payload });
      const prior = byKey.get(event.dedupeKey!);
      if (prior !== undefined) expect(body).toBe(prior);
      byKey.set(event.dedupeKey!, body);
    }
  });

  it("a retained join is never replaced by a later adoption", async () => {
    const backend = new FakeStudioBackend();
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    adopt(driver, run, OTHER_EXCHANGE);
    adopt(driver, run, EXCHANGE_UUID);
    expect(driver.exchangeJoin(run.id)).toMatchObject({ exchangeId: OTHER_EXCHANGE, join: "durable" });
    const result = await driver.abort(run, "RECOVER_OLD_RUN");
    expect(backend.exchangeId).toBe(EXCHANGE_UUID);
    expect(backend.endCalls()).toBe(0);
    expect(ofKind(result.events, "studio.cleanup.exchange_ended")[0]?.payload).toMatchObject({ confirmed: true, basis: "run_exchange_not_live_other_exchange_live", exchange_id: OTHER_EXCHANGE });
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
    const recovered = await driver.recover(binding(run), "unused");
    expect(backend.calls.length).toBe(callsBefore);
    expect(backend.issued).toBe(0);
    expect(ofKind(recovered.events, "studio.cleanup.exchange_ended")[0]?.payload).toMatchObject({ confirmed: true, basis: "no_exchange_opened_by_run", verified_by: "driver_never_requested_exchange" });
    expect(ofKind(recovered.events, "studio.cleanup.signed_out")[0]?.payload).toMatchObject({ confirmed: true, basis: "no_session_issued" });
    expect(ofKind(recovered.events, "cleanup.browser_context_absent")[0]?.payload).toMatchObject({ browser_never_allocated: true, basis: "driver_failed_before_browser_launch" });
    expect(ofKind(recovered.events, "studio.cleanup.recovery")[0]?.payload).toMatchObject({ complete: true });
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
