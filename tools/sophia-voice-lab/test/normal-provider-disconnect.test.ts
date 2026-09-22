import { describe, expect, it, vi } from "vitest";
import type { Response } from "playwright";
import { DriverEndFailure, PlaywrightVoiceDriver, SYNTHETIC_FINALIZATION_EXCLUSION_KEYS, readProviderActivationAcknowledgement, validateNormalProviderDisconnectResponse } from "../src/browser-driver.js";
import { sha256 } from "../src/security.js";
import { testConfig, testRun } from "./helpers.js";

const origin = "https://frontend.test";
const run = testRun({ providerSessionId: "gemini-prod-test", providerEpoch: 2 });
const close = (epoch: number) => ({
  schema: "sophia_gemini_browser_provider_close_v1",
  receipt_id: `00000000-0000-4000-8000-${String(epoch).padStart(12, "0")}`,
  session_id: run.providerSessionId, provider_connection_epoch: epoch,
  websocket_close_observed: true, websocket_close_code: 1000,
  websocket_closed_at: "2026-09-22T12:00:00.000Z",
});
function fixture() {
  const receipts = { browser_provider_close_receipts: [close(1), close(2)], browser_provider_activation_abort_receipts: [] as Record<string, unknown>[] };
  const body = { ok: true, closed: true, ...structuredClone(receipts) };
  const request = { session_id: run.providerSessionId, ...structuredClone(receipts) };
  const options = { url: `${origin}/api/sophia/voice/gemini/disconnect`, method: "POST", status: 202, contentType: "application/json" };
  const response = {
    url: () => options.url, status: () => options.status,
    headers: () => ({ "content-type": options.contentType }), json: async () => body,
    request: () => ({ method: () => options.method, postDataJSON: () => request,
      headers: () => { throw new Error("must never read or retain cleanup capability"); } }),
  } as unknown as Response;
  return { response, body, request, options };
}

describe("normal end authenticated receiving acknowledgement", () => {
  it("proves all owned epochs without any terminal UI callback or raw identifiers", async () => {
    const f = fixture();
    const result = await validateNormalProviderDisconnectResponse(f.response, origin, run);
    expect(result).toMatchObject({ receiving_http_status: 202, provider_connection_epochs: [1, 2], browser_provider_close_receipt_count: 2,
      voice_lab_run_id_sha256: sha256(run.id), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), provider_session_id_sha256: sha256(run.providerSessionId!) });
    expect(JSON.stringify(result)).not.toContain(run.providerSessionId);
    expect(JSON.stringify(result)).not.toContain(close(1).receipt_id);
  });
  it.each([
    "foreign-origin", "query", "wrong-path", "wrong-method", "unauthorized", "non-json", "missing-ack", "not-closed",
    "wrong-request-session", "wrong-receipt-session", "missing-old-epoch", "future-epoch", "false-websocket-close", "mutated-echo", "duplicate-epoch",
  ])("refuses %s even if session finalization succeeded", async (failure) => {
    const f = fixture();
    switch (failure) {
      case "foreign-origin": f.options.url = "https://evil.test/api/sophia/voice/gemini/disconnect"; break;
      case "query": f.options.url += "?other=1"; break;
      case "wrong-path": f.options.url = `${origin}/api/sophia/end-session`; break;
      case "wrong-method": f.options.method = "GET"; break;
      case "unauthorized": f.options.status = 401; break;
      case "non-json": f.options.contentType = "text/html"; break;
      case "missing-ack": f.body.ok = false; break;
      case "not-closed": f.body.closed = false; break;
      case "wrong-request-session": f.request.session_id = "foreign"; break;
      case "wrong-receipt-session": f.body.browser_provider_close_receipts[0]!.session_id = "foreign"; break;
      case "missing-old-epoch": f.body.browser_provider_close_receipts.shift(); f.request.browser_provider_close_receipts.shift(); break;
      case "future-epoch": f.body.browser_provider_close_receipts.push(close(3)); f.request.browser_provider_close_receipts.push(close(3)); break;
      case "false-websocket-close": f.body.browser_provider_close_receipts[1]!.websocket_close_observed = false; break;
      case "mutated-echo": f.body.browser_provider_close_receipts[1]!.websocket_close_code = 1001; break;
      case "duplicate-epoch": f.body.browser_provider_close_receipts.push(close(2)); break;
    }
    await expect(validateNormalProviderDisconnectResponse(f.response, origin, run)).rejects.toMatchObject({ detail: { code: "PROVIDER_CLEANUP_UNCONFIRMED" } });
  });
  it("does not substitute activation-aborted for an activated current socket", async () => {
    const f = fixture();
    for (const value of [f.request, f.body]) {
      value.browser_provider_close_receipts.pop();
      value.browser_provider_activation_abort_receipts.push({ schema: "sophia_gemini_browser_provider_activation_abort_v1", receipt_id: close(2).receipt_id,
        session_id: run.providerSessionId, previous_activated_epoch: 1, candidate_epoch: 2, websocket_created: false, aborted_at: close(2).websocket_closed_at });
    }
    await expect(validateNormalProviderDisconnectResponse(f.response, origin, run)).rejects.toMatchObject({ detail: { code: "PROVIDER_CLEANUP_UNCONFIRMED" } });
  });
  it("refuses missing network evidence", async () => {
    await expect(validateNormalProviderDisconnectResponse(null, origin, run)).rejects.toMatchObject({ detail: { code: "PROVIDER_CLEANUP_UNCONFIRMED" } });
  });
});

// Drive public start/end through the same response predicates and UI guards.
// The disposable browser transport is mocked; no provider.stage close callback
// exists, matching the fenced callbacks of the ordinary production hook.
it.each([[false, false], [true, false], [false, true], [true, true]])("real driver end consumes receiving ack; rejected=%s prior-activation=%s", async (rejected, priorActivation) => {
  const config = testConfig();
  const ownedRun = testRun({ scenarioId: "V-O01", providerSessionId: run.providerSessionId, providerEpoch: 2,
    capturePolicy: { rawAudio: false, screenshot: false, video: false, retentionHours: 24 } });
  const frontendOrigin = ownedRun.target.frontendUrl;
  let connected = true, contextOpen = true, pageUrl = `${frontendOrigin}/`;
  const child = { pid: 4173, exitCode: null as number | null, signalCode: null };
  const responseListeners: Array<(response: any) => void> = [];
  const waiting: Array<{ predicate: (response: any) => boolean; resolve: (response: any) => void }> = [];
  let push!: (source: unknown, envelope: unknown) => void;
  const networkResponse = (path: string, body: unknown, status = 200, requestBody?: unknown) => ({
    url: () => new URL(path, frontendOrigin).toString(), status: () => status, ok: () => status >= 200 && status < 300,
    headers: () => ({ "content-type": "application/json" }), json: async () => body,
    request: () => ({ method: () => "POST", postDataJSON: () => requestBody }),
  });
  const emit = (response: any) => { for (const listener of responseListeners) listener(response); for (const waiter of waiting) if (waiter.predicate(response)) waiter.resolve(response); };
  const expires = Math.floor(Date.now() / 1000) + 300;
  const authReceipt = { ok: true, test_run_id: ownedRun.testRunId, cleanup_obligation_id: ownedRun.cleanupObligationId,
    expires_at: expires, prior_session_cleanup_verified: true, expired_lab_sessions_revoked: 0, no_prior_conflicting_session: true,
    auth_session_state: "created", idempotent_replay: false };
  const finalized = new Date().toISOString();
  const retained = new Date(Date.parse(finalized) + 24 * 3_600_000).toISOString();
  const finalization = { test_run_id: ownedRun.testRunId, cleanup_obligation_id: ownedRun.cleanupObligationId, synthetic_isolated: true,
    exclusions: Object.fromEntries(SYNTHETIC_FINALIZATION_EXCLUSION_KEYS.map(key => [key, true])), finalized_at: finalized,
    retention_expires_at: retained, provider_expires_at: ownedRun.expiresAt.toISOString(), retention_anchor: "finalized_at", retention_hours: 24,
    canonical_transcript: { provider_expires_at: ownedRun.expiresAt.toISOString(), retention_expires_at: retained, retention_hours: 24, retention_anchor: "finalized_at" },
    evidence_receipt: { sha256: "a".repeat(64) } };
  const f = fixture();
  const activation = { schema: "sophia_gemini_browser_provider_activation_v1", activation_id: "00000000-0000-4000-8000-000000000099",
    session_id: ownedRun.providerSessionId, previous_activated_epoch: 1, candidate_epoch: 2, websocket_open_observed: true,
    close_observer_attached: true, websocket_opened_at: close(1).websocket_closed_at, previous_socket_close_receipt: close(1) };
  if (priorActivation) {
    f.body.browser_provider_close_receipts.shift();
    f.request.browser_provider_close_receipts.shift();
  }
  const locator = (leave: boolean) => ({ first() { return this; }, last() { return this; }, waitFor: async () => {},
    isVisible: async () => false, click: async () => {
      if (leave) return;
      emit(networkResponse("/api/sophia/voice/gemini/disconnect", f.body, rejected ? 401 : 202, f.request));
      emit(networkResponse("/api/sophia/end-session", finalization, 202));
    } });
  const binding = { synthetic: true, principal_id: ownedRun.principalId, test_run_id: ownedRun.testRunId,
    cleanup_obligation_id: ownedRun.cleanupObligationId, scenario_id: ownedRun.scenarioId, scenario_version: ownedRun.scenarioVersion,
    environment: ownedRun.environment, retention_hours: 24, provider_expires_at: ownedRun.expiresAt.toISOString() };
  const page = {
    on: (kind: string, listener: (response: any) => void) => { if (kind === "response") responseListeners.push(listener); },
    url: () => pageUrl,
    goto: async () => {
      for (const action of ["session-start", "voice-start"]) emit(networkResponse(`/api/voice-lab/control/${action}`, {
        ok: true, schema: "sophia_voice_lab_control_adapter_v1", action, test_run_id: ownedRun.testRunId,
        scenario_id: ownedRun.scenarioId, scenario_version: ownedRun.scenarioVersion, cleanup_obligation_id: ownedRun.cleanupObligationId,
        expected_deployment: ownedRun.target.expectedDeployment, control_epoch_sha256: "b".repeat(64), expires_at: expires, ordinary_user_access: false,
      }));
      const send = (channel: string, payload: unknown) => push({ page }, { schema: "sophia_voice_lab_page_push_v1", channel, payload });
      send("harness", { seq: 1, kind: "harness.initialized", payload: {} });
      send("harness", { seq: 2, kind: "harness.media_stream_issued", payload: { replacement_active: true, stream_id_sha256: sha256("stream"), track_id_sha256s: [sha256("track")] } });
      for (const [index, [name, payload]] of ([
        ["credentials-received", {}], ["microphone-stream-acquired", { streamId: "stream", trackIds: ["track"] }],
        ["gemini-provider-connection-epoch", { receipt: { providerConnectionEpoch: 2 } }], ["gemini-connection-observability", {}],
      ] as const).entries()) send("product", { generation: 1, seq: index + 1, name, category: "voice", payload, synthetic_test: binding });
    },
    waitForURL: async () => { pageUrl = `${frontendOrigin}/session`; },
    waitForResponse: (predicate: (response: any) => boolean) => new Promise(resolve => waiting.push({ predicate, resolve })),
    getByRole: (_role: string, options: { name: RegExp }) => locator(options.name.source.includes("Leave")),
    evaluate: async () => null,
  };
  const context = {
    exposeBinding: async (_name: string, callback: typeof push) => { push = callback; }, addInitScript: async () => {}, newPage: async () => page,
    close: async () => { contextOpen = false; },
    request: {
      post: async (url: string) => networkResponse(url, url.endsWith(config.authCleanupPath) ? { ...authReceipt, session_revoked: true, cookies_cleared: true } : authReceipt),
      get: async (url: string) => networkResponse(url, { user: { id: ownedRun.principalId } }),
    },
  };
  const browser = { version: () => "test-chromium", isConnected: () => connected, newContext: async () => context,
    contexts: () => contextOpen ? [context] : [], close: async () => { connected = false; } };
  const server = { process: () => child, wsEndpoint: () => "ws://owned.test", close: async () => { connected = false; child.exitCode = 0; } };
  const builds: Record<string, string> = { "frontend.test": ownedRun.target.expectedDeployment.frontend, "gateway.test": ownedRun.target.expectedDeployment.backend,
    "voice.test": ownedRun.target.expectedDeployment.voice, "langgraph.test": ownedRun.target.expectedDependencies.langgraph };
  const driver = new PlaywrightVoiceDriver(config, async url => new globalThis.Response(JSON.stringify({ build_id: builds[new URL(String(url)).hostname] }), { status: 200 }),
    undefined, undefined, (async () => server) as any, (async () => browser) as any);
  await driver.start(ownedRun, "grant");
  if (priorActivation) emit(networkResponse("/api/sophia/voice/gemini/activate", {
    activated: true, session_id: ownedRun.providerSessionId, provider_connection_epoch: 2, provider_activation_receipt: activation,
  }, 202, activation));
  vi.spyOn(driver, "drain").mockResolvedValue([]);
  if (rejected) {
    const error = await driver.end(ownedRun, "finalize", "cleanup").catch(error => error);
    expect(error).toBeInstanceOf(DriverEndFailure);
    expect(error.detail.code).toBe("PROVIDER_CLEANUP_UNCONFIRMED");
    expect(error.events).toContainEqual(expect.objectContaining({ kind: "session.finalized" }));
    expect(error.events.some((event: any) => event.kind === "cleanup.provider_transport_closed")).toBe(false);
    expect(driver.hasSession(ownedRun.id)).toBe(true); // Recovery still owns the browser.
  } else {
    const ended = await driver.end(ownedRun, "finalize", "cleanup");
    expect(ended.events).toContainEqual(expect.objectContaining({ kind: "cleanup.provider_transport_closed",
      payload: expect.objectContaining({ proof_basis: "authenticated_receiving_disconnect_acknowledgement" }) }));
    expect(ended.events.some(event => event.kind === "provider.stage")).toBe(false);
    expect(driver.hasSession(ownedRun.id)).toBe(false);
    expect(child.exitCode).toBe(0);
  }
});

it.each(["valid", "unauthorized", "foreign-origin", "mutated-echo", "wrong-session", "missing-close", "wrong-epoch", "false-close", "missing-ack"])("prior receiving activation evidence: %s", async failure => {
  const activation: Record<string, unknown> = { schema: "sophia_gemini_browser_provider_activation_v1",
    activation_id: "00000000-0000-4000-8000-000000000099", session_id: run.providerSessionId,
    previous_activated_epoch: 1, candidate_epoch: 2, websocket_open_observed: true, close_observer_attached: true,
    websocket_opened_at: close(1).websocket_closed_at, previous_socket_close_receipt: close(1) };
  if (failure === "wrong-session") activation.session_id = "foreign";
  if (failure === "missing-close") activation.previous_socket_close_receipt = null;
  if (failure === "wrong-epoch") activation.previous_socket_close_receipt = close(2);
  if (failure === "false-close") activation.previous_socket_close_receipt = { ...close(1), websocket_close_observed: false };
  const request = structuredClone(activation);
  if (failure === "mutated-echo") activation.activation_id = "00000000-0000-4000-8000-000000000098";
  const response = {
    url: () => `${failure === "foreign-origin" ? "https://other.test" : origin}/api/sophia/voice/gemini/activate`,
    status: () => failure === "unauthorized" ? 401 : 202, headers: () => ({ "content-type": "application/json" }),
    json: async () => ({ activated: failure !== "missing-ack", session_id: activation.session_id, provider_connection_epoch: 2, provider_activation_receipt: activation }),
    request: () => ({ method: () => "POST", postDataJSON: () => request }),
  } as unknown as Response;
  const accepted = await readProviderActivationAcknowledgement(response, origin);
  const f = fixture();
  f.request.browser_provider_close_receipts.shift(); f.body.browser_provider_close_receipts.shift();
  const result = validateNormalProviderDisconnectResponse(f.response, origin, run, accepted ? [accepted] : []);
  if (failure === "valid") await expect(result).resolves.toMatchObject({ provider_connection_epochs: [1, 2], prior_activation_acknowledgement_sha256s: [expect.stringMatching(/^[a-f0-9]{64}$/)] });
  else await expect(result).rejects.toMatchObject({ detail: { code: "PROVIDER_CLEANUP_UNCONFIRMED" } });
});
