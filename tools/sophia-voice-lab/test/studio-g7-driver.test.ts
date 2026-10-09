import { describe, expect, it } from "vitest";

import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import { VoiceLabError } from "../src/domain.js";
import { StudioApiClient, classifyRoomPresence } from "../src/studio-g7/studio-api.js";
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
const ROOM_UUID = "70000000-0000-4000-8000-0000000000a7";
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
  /** The evidence answer: built per request; null answers as the product does when it is not the principal's (422 `not_found`). */
  evidence: ((exchangeId: string) => Record<string, unknown> | null) | null = null;
  /** Whether the API runs with SOPHIA_VOICE_QUALIFICATION=on; off, the evidence route is absent (Fastify 404). */
  voiceQualificationOn = true;
  /** A raw refusal of the evidence read (negative controls: other 422 codes, 401, 403). */
  evidenceRefusal: { status: number; body: unknown } | null = null;
  /** The exchange's calls (A15 ExchangeCalls body, without exchangeId); null: not an exchange of the caller's (422 not_found). */
  callsBody: Record<string, unknown> | null = { calls: [] };
  /** The room as the bridge last saw it (A15 RoomLivePresence); the default is no report. */
  presence: Record<string, unknown> = { observed: false, reportedAt: null, fresh: false, voice: null, exchangeId: null, selfPresent: false, participants: 0, guests: 0, emptySince: null };
  grantUser = PRINCIPAL_UUID;
  /** A raw 200 snapshot body that replaces the well-formed one (malformed-answer tests). */
  snapshotBody: unknown = undefined;
  /** Local (scope=local) logouts that answer 503 before the next one succeeds. */
  failLocalLogouts = 0;
  /** The `expires_in` the password grant answers with. */
  expiresIn = 3_600;

  fetch = async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorization = headers.authorization ?? null;
    this.calls.push({ method, path: `${url.origin}${url.pathname}${url.search}`, authorization });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    // Exactly as the product answers: a domain error is `{code, message, retry, requestId}`
    // (`not_found` is HTTP 422), and Fastify answers an absent route with its own 404.
    const productError = (status: number, code: string, message: string) => json({ code, message, retry: "never", requestId: "req-fake-0001" }, status);
    const routeNotFound = () => json({ message: `Route ${method}:${url.pathname} not found`, error: "Not Found", statusCode: 404 }, 404);
    if (url.origin === DEFAULT_ORIGINS.supabase) {
      if (headers.apikey !== FAKE_PUBLISHABLE_KEY) return json({ error: "no_api_key" }, 401);
      if (url.pathname === "/auth/v1/health") return json({ name: "GoTrue" });
      if (url.pathname === "/auth/v1/token") {
        const body = JSON.parse(String(init?.body)) as { email: string; password: string };
        if (body.email !== FAKE_EMAIL || body.password !== this.password) return json({ error: "invalid_grant", error_description: "Invalid login credentials" }, 400);
        this.issued += 1;
        return json({ access_token: `fake-access-token-${this.issued}-xxxxxxxx`, refresh_token: `fake-refresh-${this.issued}`, token_type: "bearer", expires_in: this.expiresIn, expires_at: Math.floor(Date.now() / 1_000) + this.expiresIn, user: { id: this.grantUser } });
      }
      if (url.pathname === "/auth/v1/logout") {
        if (url.searchParams.get("scope") === "local" && this.failLocalLogouts > 0) { this.failLocalLogouts -= 1; return json({}, 503); }
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
      if (url.pathname === `/api/v1/projects/${PROJECT_UUID}/snapshot` && this.snapshotBody !== undefined) return typeof this.snapshotBody === "string" ? new Response(this.snapshotBody, { status: 200, headers: { "content-type": "application/json" } }) : json(this.snapshotBody);
      if (url.pathname === `/api/v1/projects/${PROJECT_UUID}/snapshot`) return json({ room: { id: ROOM_UUID, sophia: { exchangeId: this.exchangeId, exchange: this.exchangeId ? "open" : "none", inputEpoch: 2, inputActorId: this.exchangeId ? this.inputActorId : null } }, work: [] });
      const evidence = /^\/api\/v1\/exchanges\/([0-9a-f-]{36})\/qualification-evidence$/.exec(url.pathname);
      if (evidence) {
        if (!this.voiceQualificationOn) return routeNotFound();
        if (this.evidenceRefusal) return json(this.evidenceRefusal.body, this.evidenceRefusal.status);
        const body = this.evidence?.(evidence[1]!) ?? null;
        return body === null ? productError(422, "not_found", "Qualification evidence not found") : json(body);
      }
      const calls = /^\/api\/v1\/exchanges\/([0-9a-f-]{36})\/calls$/.exec(url.pathname);
      if (calls) {
        if (!this.voiceQualificationOn) return routeNotFound();
        if (this.callsBody === null || calls[1] !== EXCHANGE_UUID) return productError(422, "not_found", "Exchange not found");
        return json({ exchangeId: EXCHANGE_UUID, ...this.callsBody });
      }
      const presence = /^\/api\/v1\/rooms\/([0-9a-f-]{36})\/live-presence$/.exec(url.pathname);
      if (presence) {
        if (!this.voiceQualificationOn) return routeNotFound();
        if (presence[1] !== ROOM_UUID) return productError(422, "not_found", "Room not found");
        return json({ roomId: ROOM_UUID, ...this.presence });
      }
      const end = /^\/api\/v1\/exchanges\/([0-9a-f-]{36})\/end$/.exec(url.pathname);
      if (method === "POST" && end) { if (this.exchangeId === end[1]) this.exchangeId = null; return new Response(null, { status: 204 }); }
    }
    return routeNotFound();
  };

  endCalls(): number { return this.calls.filter((call) => call.method === "POST" && call.path.endsWith("/end")).length; }
  logoutScopes(): Array<string | null> { return this.calls.filter((call) => call.path.includes("/auth/v1/logout")).map((call) => new URL(call.path).searchParams.get("scope")); }
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
    const cases: Array<{ name: string; evidence: (exchangeId: string) => Record<string, unknown> | null; status: string; reason: string; configure?: (backend: FakeStudioBackend) => void }> = [
      { name: "another run's binding", evidence: () => evidenceEnvelope(run, [], { grant: { ...grant, runBindingSha256: "e".repeat(64) } }), status: "mismatch", reason: "evidence_bound_to_another_run" },
      { name: "another grant", evidence: () => evidenceEnvelope(run, [], { grant: { ...grant, grantId: "22222222-3333-4444-8555-666666666666" } }), status: "mismatch", reason: "evidence_bound_to_another_grant" },
      { name: "not answered to the principal (product 422 not_found)", evidence: () => null, status: "unavailable", reason: "evidence_not_answered_to_principal" },
      { name: "route absent (voice qualification off: 404)", evidence: () => evidenceEnvelope(run, []), status: "unavailable", reason: "evidence_endpoint_not_served", configure: (backend) => { backend.voiceQualificationOn = false; } },
      { name: "a 422 with another code (invalid_request)", evidence: () => evidenceEnvelope(run, []), status: "unavailable", reason: "evidence_endpoint_unavailable", configure: (backend) => { backend.evidenceRefusal = { status: 422, body: { code: "invalid_request", message: "body/exchangeId must match format \"uuid\"", retry: "never", requestId: "req-fake-0002" } }; } },
      { name: "401", evidence: () => evidenceEnvelope(run, []), status: "unavailable", reason: "evidence_auth_rejected", configure: (backend) => { backend.evidenceRefusal = { status: 401, body: { code: "unauthorized", message: "Unauthorized", retry: "never", requestId: "req-fake-0003" } }; } },
      { name: "403", evidence: () => evidenceEnvelope(run, []), status: "unavailable", reason: "evidence_auth_rejected", configure: (backend) => { backend.evidenceRefusal = { status: 403, body: { code: "forbidden", message: "Forbidden", retry: "never", requestId: "req-fake-0004" } }; } },
      { name: "a receipt bound to another run inside the answer", evidence: () => evidenceEnvelope(run, [["provider", { ...providerReceipt(run, 0, "ready"), runBindingSha256: "d".repeat(64) }]]), status: "unavailable", reason: "evidence_rejected" },
    ];
    for (const item of cases) {
      const backend = new FakeStudioBackend();
      backend.evidence = item.evidence;
      item.configure?.(backend);
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
  it("re-reads late bridge receipts after End with a fresh session, then revokes only that session", async () => {
    const backend = new FakeStudioBackend();
    backend.exchangeId = null;
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    backend.evidence = () => evidenceEnvelope(run, [["input_window", inputWindow(run, 0, 1, 1_000)], ["session_closed", sessionClosed(run, 1, { windows: 1, turns: 0, replies: 0 })], ["guard", guardReceipt(run, "deadline")]], { state: "ended" });
    const events = await driver.refreshStudioEvidence(run, { exchangeId: EXCHANGE_UUID, grantId: GRANT_UUID, runBindingSha256: bindingOf(run), speakRequested: true, exchangeOpenedAtMs: null });
    expect(ofKind(events, "studio.bridge_grant")[0]?.payload).toMatchObject({ exchange_state: "ended" });
    expect(ofKind(events, "studio.bridge_receipt").map((event) => [event.payload.source, event.payload.seq, event.payload.kind])).toEqual([["bridge", 0, "input_window"], ["bridge", 1, "session_closed"], ["service", 0, "guard"]]);
    expect(ofKind(events, "studio.evidence.session_revoked")[0]?.payload).toMatchObject({ confirmed: true, scope: "local" });
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

describe("Studio G7 adversarial review fixes (driver)", () => {
  it("evidence completion revokes only its own fresh session, never the principal's other sessions", async () => {
    const backend = new FakeStudioBackend();
    backend.exchangeId = null;
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    backend.evidence = () => evidenceEnvelope(run, [["session_closed", sessionClosed(run, 1, { windows: 1, turns: 0, replies: 0 })]], { state: "ended" });
    const events = await driver.refreshStudioEvidence(run, { exchangeId: EXCHANGE_UUID, grantId: GRANT_UUID, runBindingSha256: bindingOf(run), speakRequested: true, exchangeOpenedAtMs: null });
    expect(ofKind(events, "studio.bridge_receipt")).toHaveLength(1);
    // A later run of the same principal may be live: a global sign-out would revoke its tokens.
    expect(backend.logoutScopes()).toEqual(["local"]);
    expect(ofKind(events, "studio.cleanup.signed_out")).toHaveLength(0);
    expect(ofKind(events, "studio.evidence.session_revoked")[0]?.payload).toMatchObject({ scope: "local", confirmed: true, http_status: 204 });
    expect(JSON.stringify(events)).not.toContain("fake-access-token-");
  });

  it("treats a 200 snapshot whose room is missing or malformed as unknown, never as 'no live exchange'", async () => {
    const malformed: unknown[] = [{}, { room: null }, { room: { id: "room-g7" } }, { room: { id: "room-g7", sophia: {} } }, { room: { id: "room-g7", sophia: { exchange: "open", exchangeId: "not-a-uuid" } } }, { room: { id: "room-g7", sophia: { exchange: "closing", exchangeId: EXCHANGE_UUID } } }, "not json"];
    for (const body of malformed) {
      const backend = new FakeStudioBackend();
      backend.snapshotBody = body;
      const { config, driver } = driverFor(backend);
      const run = studioRun(config);
      backend.evidence = () => evidenceEnvelope(run, []);
      adopt(driver, run);
      const result = await driver.abort(run, "TEST");
      const label = JSON.stringify(body);
      expect(ofKind(result.events, "studio.cleanup.exchange_ended").at(-1)?.payload, label).toMatchObject({ confirmed: false, status: "unavailable" });
      expect(backend.endCalls(), label).toBe(0);
      // The exchange the run joined is still recorded unsettled for recovery; sign-out still happens.
      expect(ofKind(result.events, "studio.cleanup.signed_out")[0]?.payload, label).toMatchObject({ confirmed: true });
    }
  });
});

describe("Studio G7 adversarial re-review fixes (driver)", () => {
  it("retries a failed local revoke with backoff, never falls back to a global sign-out, and records the refresh session unrevoked", async () => {
    const run = studioRun(studioTestConfig());
    const join = { exchangeId: EXCHANGE_UUID, grantId: GRANT_UUID, runBindingSha256: bindingOf(run), speakRequested: true, exchangeOpenedAtMs: null };
    const failing = new FakeStudioBackend();
    failing.exchangeId = null;
    failing.failLocalLogouts = 5;
    failing.evidence = () => evidenceEnvelope(run, [], { state: "ended" });
    const unrevoked = await driverFor(failing).driver.refreshStudioEvidence(run, join);
    expect(failing.logoutScopes()).toEqual(["local", "local", "local"]);
    expect(ofKind(unrevoked, "studio.evidence.session_revoked")[0]?.payload).toMatchObject({ scope: "local", confirmed: false, status: "unrevoked", attempts: 3, http_status: 503 });
    const recovering = new FakeStudioBackend();
    recovering.exchangeId = null;
    recovering.failLocalLogouts = 1;
    recovering.evidence = () => evidenceEnvelope(run, [], { state: "ended" });
    const revoked = await driverFor(recovering).driver.refreshStudioEvidence(run, join);
    expect(recovering.logoutScopes()).toEqual(["local", "local"]);
    expect(ofKind(revoked, "studio.evidence.session_revoked")[0]?.payload).toMatchObject({ confirmed: true, status: "revoked", attempts: 2 });
  });

  it("refuses an access-JWT lifetime above the 24 h bound during cleanup too, revoking only the issued session", async () => {
    const backend = new FakeStudioBackend();
    backend.expiresIn = 1_000_000_000_000;
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    adopt(driver, run);
    const result = await driver.abort(run, "TEST");
    expect(ofKind(result.events, "studio.cleanup.exchange_ended")[0]?.payload).toMatchObject({ confirmed: false, status: "unavailable", error_code: "STUDIO_AUTH_TOKEN_LIFETIME_UNBOUNDED" });
    expect(backend.calls.some((call) => call.path.includes("/api/v1/"))).toBe(false);
    expect(backend.logoutScopes().every((scope) => scope === "local")).toBe(true);
    expect(backend.endCalls()).toBe(0);
  });
});

describe("Studio G7 third review: a no-join end needs the principal gone, never a clock (driver)", () => {
  it("never confirms a no-join end on a clock comparison: a skewed recovering worker stays uncertain until the principal has left", async () => {
    const backend = new FakeStudioBackend();
    backend.exchangeId = null;
    const run = studioRun(studioTestConfig());
    const join = { exchangeId: null, grantId: GRANT_UUID, runBindingSha256: bindingOf(run), speakRequested: true, exchangeOpenedAtMs: null };
    // Worker B adopts A's durable Speak intent with no join; B's clock reads ten hours after A's.
    const skewed = driverFor(backend).driver;
    skewed.adoptStudioJoin(run.id, { ...join, speakRequestedAtMs: Date.now() - 10 * 3_600_000 });
    const early = await skewed.recover(binding(run), "unused");
    expect(ofKind(early.events, "studio.cleanup.exchange_ended")[0]?.payload).toMatchObject({ confirmed: false, status: "uncertain" });
    expect(backend.endCalls()).toBe(0);
    // Once A's browser close and a global sign-out are durable, a read with nothing live confirms.
    const later = driverFor(backend).driver;
    later.adoptStudioJoin(run.id, { ...join, speakRequestedAtMs: Date.now() + 10 * 3_600_000, browserClosed: true, globalSignOutConfirmed: true } as never);
    const settled = await later.recover(binding(run), "unused");
    expect(ofKind(settled.events, "studio.cleanup.exchange_ended")[0]?.payload).toMatchObject({ confirmed: true, basis: "no_live_exchange_after_principal_left", browser_closed_before_observation: true, signed_out_before_observation: true, verified_by: "member_snapshot" });
  });
});

describe("member-read refusals follow the product's convention (A15)", () => {
  const TASK = "c0000000-0000-4000-8000-0000000000c9";
  /** One programmed answer per request, exactly as the product (or Fastify, for an absent route) sends it. */
  function client(status: number, body: unknown) {
    const config = studioTestConfig();
    const studio = config.studioG7!;
    const fetchImpl = async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    return new StudioApiClient(studio.apiOrigin, studio.studioOrigin, config.allowedOrigins, fetchImpl as never, 5_000, []);
  }
  const productError = (code: string) => ({ code, message: "Refused", retry: "never", requestId: "req-fake-0100" });
  const fastify404 = { message: "Route GET:/api/v1/exchanges/x/qualification-evidence not found", error: "Not Found", statusCode: 404 };
  const cases: Array<{ name: string; status: number; body: unknown; evidence: string; member: string }> = [
    { name: "422 not_found (not the principal's, or no grant covers it)", status: 422, body: productError("not_found"), evidence: "not_answered_to_principal", member: "not_found_for_principal" },
    { name: "404 route not found (voice qualification off)", status: 404, body: fastify404, evidence: "endpoint_not_served", member: "endpoint_not_served" },
    { name: "a 404 is never 'not yours', whatever its body", status: 404, body: productError("not_found"), evidence: "endpoint_not_served", member: "endpoint_not_served" },
    { name: "422 invalid_request", status: 422, body: productError("invalid_request"), evidence: "endpoint_unavailable", member: "endpoint_unavailable" },
    { name: "422 without a code", status: 422, body: { message: "Refused" }, evidence: "endpoint_unavailable", member: "endpoint_unavailable" },
    { name: "401", status: 401, body: productError("unauthorized"), evidence: "auth_rejected", member: "auth_rejected" },
    { name: "403", status: 403, body: productError("forbidden"), evidence: "auth_rejected", member: "auth_rejected" },
    { name: "409", status: 409, body: productError("conflict"), evidence: "endpoint_unavailable", member: "endpoint_unavailable" },
    { name: "503", status: 503, body: productError("unavailable"), evidence: "endpoint_unavailable", member: "endpoint_unavailable" },
  ];
  it.each(cases)("$name", async ({ status, body, evidence, member }) => {
    expect(await client(status, body).qualificationEvidence(EXCHANGE_UUID, "fake-access-token-1-xxxxxxxx")).toEqual({ status: "unavailable", reason: evidence, http_status: status });
    expect(await client(status, body).nativeTask(PROJECT_UUID, TASK, "fake-access-token-1-xxxxxxxx")).toEqual({ status: "unavailable", reason: member, http_status: status });
    expect(await client(status, body).sourceContent(TASK, "fake-access-token-1-xxxxxxxx")).toEqual({ status: "unavailable", reason: member, http_status: status });
    expect(await client(status, body).artifactVersions(TASK, "fake-access-token-1-xxxxxxxx")).toEqual({ status: "unavailable", reason: member, http_status: status });
    if (status === 401 || status === 403) return;
    const snapshot = await client(status, body).snapshot(PROJECT_UUID, "fake-access-token-1-xxxxxxxx").catch((error: unknown) => error) as VoiceLabError;
    expect(snapshot.detail).toMatchObject({ code: "STUDIO_SNAPSHOT_UNAVAILABLE", details: { http_status: status, reason: member } });
  });
});

describe("a recovery reads the room as the bridge last saw it (A15 live presence)", () => {
  const fresh = (selfPresent: boolean) => ({ observed: true, reportedAt: new Date().toISOString(), fresh: true, voice: "ready", exchangeId: null, selfPresent, participants: selfPresent ? 1 : 0, guests: 0, emptySince: null });
  async function presenceAfterRecover(configure: (backend: FakeStudioBackend) => void) {
    const backend = new FakeStudioBackend();
    backend.exchangeId = null;
    configure(backend);
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    adopt(driver, run);
    const recovered = await driver.recover(binding(run), "unused");
    const events = ofKind(recovered.events, "studio.room.live_presence");
    expect(events).toHaveLength(1);
    // Read with the recovery's own session, before its global sign-out.
    const order = recovered.events.map((event) => event.kind);
    expect(order.indexOf("studio.room.live_presence")).toBeLessThan(order.indexOf("studio.cleanup.signed_out"));
    expect(backend.issued).toBe(1);
    return { payload: events[0]!.payload, serialized: JSON.stringify(recovered.events) };
  }

  it("a fresh report is evidence either way: the principal present, or gone", async () => {
    const present = await presenceAfterRecover((backend) => { backend.presence = fresh(true); });
    expect(present.payload).toMatchObject({ schema: "sophia_voice_lab_studio_room_presence_v1", status: "present", reason: null, http_status: 200, observed: true, fresh: true, self_present: true, participants: 1, guests: 0, identities_excluded: true });
    const absent = await presenceAfterRecover((backend) => { backend.presence = fresh(false); });
    expect(absent.payload).toMatchObject({ status: "absent", reason: null, self_present: false });
    // Only the principal's own presence and counts are kept: no room id, no identities.
    expect(absent.serialized).not.toContain(ROOM_UUID);
  });

  it("a stale or missing report, a refusal or an absent route proves nothing and is never typed gone", async () => {
    const cases: Array<{ name: string; configure: (backend: FakeStudioBackend) => void; reason: string; http: number | null }> = [
      { name: "stale (selfPresent false)", configure: (backend) => { backend.presence = { ...fresh(false), fresh: false }; }, reason: "report_stale", http: 200 },
      { name: "stale (selfPresent true)", configure: (backend) => { backend.presence = { ...fresh(true), fresh: false }; }, reason: "report_stale", http: 200 },
      { name: "no report", configure: () => undefined, reason: "not_observed", http: 200 },
      { name: "route absent (404)", configure: (backend) => { backend.voiceQualificationOn = false; }, reason: "endpoint_not_served", http: 404 },
      { name: "malformed answer", configure: (backend) => { backend.presence = { observed: "yes" }; }, reason: "answer_malformed", http: 200 },
    ];
    for (const item of cases) {
      const { payload } = await presenceAfterRecover(item.configure);
      expect(payload, item.name).toMatchObject({ status: "unobservable", reason: item.reason, http_status: item.http });
    }
  });

  it("types a 422 not_found room as not found for the principal, never as gone", async () => {
    const api = new StudioApiClient(studioTestConfig().studioG7!.apiOrigin, studioTestConfig().studioG7!.studioOrigin, studioTestConfig().allowedOrigins, (async () => new Response(JSON.stringify({ code: "not_found", message: "Room not found", retry: "never", requestId: "req-fake-0200" }), { status: 422, headers: { "content-type": "application/json" } })) as never, 5_000, []);
    const read = await api.livePresence(ROOM_UUID, "fake-access-token-1-xxxxxxxx");
    expect(read).toEqual({ status: "unavailable", reason: "not_found_for_principal", http_status: 422 });
    expect(classifyRoomPresence(read, ROOM_UUID)).toEqual({ status: "unobservable", reason: "not_found_for_principal" });
    expect(classifyRoomPresence({ status: "available", value: { roomId: OTHER_EXCHANGE, observed: true, fresh: true, selfPresent: false, participants: 0, guests: 0, voice: null, exchangeId: null, reportedAt: null }, http_status: 200 }, ROOM_UUID)).toEqual({ status: "unobservable", reason: "room_mismatch" });
  });
});

describe("the exchange's calls are read as the principal and typed by the product's convention (A15 getExchangeCalls)", () => {
  const productCall = (seq: number, command: Record<string, unknown> | null, taskId: string | null = null) => ({ seq, recordedAt: new Date(1_800_000_000_000 + seq).toISOString(), inputEpoch: 1, tool: command ? "control_work" : "project_status", command, taskId });
  const hold = (seq: number) => ({ commandId: `f0000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, kind: "hold", goalId: "e0000000-0000-4000-8000-0000000000a1", authorityEpoch: seq, goalRevision: 1, state: "checked", createdAt: new Date(1_800_000_000_000).toISOString() });
  async function read(configure: (backend: FakeStudioBackend) => void) {
    const backend = new FakeStudioBackend();
    configure(backend);
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    adopt(driver, run);
    const event = await driver.readStudioCalls(run, "baseline", "op-1", "g7.hold");
    expect(event).toMatchObject({ kind: "studio.exchange.calls_read", source: "canonical", dedupeKey: `studio-calls-baseline:${run.id}:op-1` });
    return event.payload;
  }

  it("records each call's seq, tool, command and task, and the highest seq as the baseline", async () => {
    const payload = await read((backend) => { backend.callsBody = { calls: [productCall(3, null), productCall(7, hold(7))] }; });
    expect(payload).toMatchObject({ schema: "sophia_voice_lab_studio_exchange_calls_v1", status: "available", exchange_id: EXCHANGE_UUID, max_seq: 7, operation_id: "op-1", step_id: "g7.hold" });
    expect(payload.calls).toEqual([
      expect.objectContaining({ seq: 3, tool: "project_status", command: null, task_id: null }),
      expect.objectContaining({ seq: 7, command: expect.objectContaining({ kind: "hold", authority_epoch: 7, state: "checked", goal_id: "e0000000-0000-4000-8000-0000000000a1" }) }),
    ]);
    expect((await read(() => undefined)).max_seq).toBe(0);
  });

  it("never takes a refused, absent or malformed answer as a baseline", async () => {
    expect(await read((backend) => { backend.voiceQualificationOn = false; })).toMatchObject({ status: "unavailable", reason: "endpoint_not_served", http_status: 404, max_seq: null });
    expect(await read((backend) => { backend.callsBody = null; })).toMatchObject({ status: "unavailable", reason: "not_found_for_principal", http_status: 422, max_seq: null });
    // seq not strictly increasing (the recording order), or an unknown command state: the whole answer is refused.
    expect(await read((backend) => { backend.callsBody = { calls: [productCall(5, null), productCall(5, hold(5))] }; })).toMatchObject({ status: "unavailable", reason: "answer_malformed" });
    expect(await read((backend) => { backend.callsBody = { calls: [productCall(5, { ...hold(5), state: "done" })] }; })).toMatchObject({ status: "unavailable", reason: "answer_malformed" });
    // An answer about another exchange.
    expect(await read((backend) => { backend.callsBody = { exchangeId: OTHER_EXCHANGE, calls: [] }; })).toMatchObject({ status: "unavailable", reason: "exchange_mismatch" });
  });
});

describe("(h) presence is only the principal's own fresh selfPresent", () => {
  it("never takes counts, a stale report or another member's presence as the principal's", async () => {
    const backend = new FakeStudioBackend();
    backend.exchangeId = null;
    const { config, driver } = driverFor(backend);
    const run = studioRun(config);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      // Another member is in the room: the counts say so, the principal's own read does not.
      ["counts > 0 with selfPresent false", { observed: true, fresh: true, selfPresent: false, participants: 2, guests: 1 }, "absent"],
      ["selfPresent true but stale", { observed: true, fresh: false, selfPresent: true, participants: 1, guests: 0 }, "unobservable"],
      ["participants without a report", { observed: false, fresh: false, selfPresent: false, participants: 3, guests: 0 }, "unobservable"],
    ];
    for (const [name, report, status] of cases) {
      backend.presence = { reportedAt: new Date().toISOString(), voice: "ready", exchangeId: null, emptySince: null, ...report };
      adopt(driver, run);
      const recovered = await driver.recover(binding(run), "unused");
      const presence = ofKind(recovered.events, "studio.room.live_presence")[0]!.payload;
      expect(presence.status, name).toBe(status);
      expect(presence.status, name).not.toBe("present");
    }
    // Every presence read was the principal's own (its own session's bearer token).
    const reads = backend.calls.filter((item) => item.path.endsWith("/live-presence"));
    expect(reads.length).toBe(cases.length);
    expect(reads.every((item) => item.authorization?.startsWith("Bearer fake-access-token-"))).toBe(true);
  });
});
