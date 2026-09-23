import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Response } from "playwright";
import { DriverEndFailure, END_POST_DISCONNECT_RESERVE_MS, PlaywrightVoiceDriver, SYNTHETIC_FINALIZATION_EXCLUSION_KEYS, observeProviderDisconnect, PRODUCT_ERROR_CODES, productErrorCode, providerDisconnectDeadlineAt, providerDisconnectWaitMs, readProviderActivationAcknowledgement, validateNormalProviderDisconnectResponse } from "../src/browser-driver.js";
import { projectPublicData, redact, sha256 } from "../src/security.js";
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
it.each([
  [false, false, "first"], [true, false, "first"], [false, true, "first"], [true, true, "first"],
  // The product retries a rejected disconnect; the later exact 202 is the acknowledgement.
  [false, false, "retried"],
  // The worker's run record predates an automatic reconnect to epoch 2.
  [false, false, "stale-epoch"],
  // Finalization fails before the disconnect is awaited: the listener must still go.
  [false, false, "finalization-fails"],
  // C043/C044: the product's 409 names its machine code; only that code is kept.
  [false, false, "finalization-409-coded"],
  // A rejected attempt observed while end drains after the 202 still counts (C011).
  [false, false, "late-rejection"],
  // A failed continuation left candidate 3 aborted after activated epoch 2 (C021).
  [false, false, "aborted-candidate"],
  // C042: the worker already spent 30 s of its end budget (grant minting,
  // fencing) before driver entry; the 202 wait must honour the real deadline.
  [false, false, "delayed-entry"],
] as const)("real driver end consumes receiving ack; rejected=%s prior-activation=%s mode=%s", async (rejected, priorActivation, mode) => {
  const config = testConfig();
  const ownedRun = testRun({ scenarioId: "V-O01", providerSessionId: run.providerSessionId, providerEpoch: mode === "stale-epoch" ? 1 : 2,
    capturePolicy: { rawAudio: false, screenshot: false, video: false, retentionHours: 24 } });
  const frontendOrigin = ownedRun.target.frontendUrl;
  let connected = true, contextOpen = true, pageUrl = `${frontendOrigin}/`;
  const child = { pid: 4173, exitCode: null as number | null, signalCode: null };
  const responseListeners: Array<(response: any) => void> = [];
  const waiting: Array<{ predicate: (response: any) => boolean; resolve: (response: any) => void; timeout?: number }> = [];
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
  if (mode === "aborted-candidate") withAbortedCandidate(f, abort(3));
  const locator = (leave: boolean) => ({ first() { return this; }, last() { return this; }, waitFor: async () => {},
    isVisible: async () => false, click: async () => {
      if (leave) return;
      if (mode === "retried") {
        emit(networkResponse("/api/sophia/voice/gemini/disconnect", { ok: false }, 503, f.request));
        setTimeout(() => emit(networkResponse("/api/sophia/voice/gemini/disconnect", f.body, 202, f.request)), 5);
      } else emit(networkResponse("/api/sophia/voice/gemini/disconnect", f.body, rejected ? 401 : 202, f.request));
      if (mode === "finalization-409-coded") emit(networkResponse("/api/sophia/end-session", { error: "voice_lab_run_binding_mismatch", note: "PRIVATE free text" }, 409));
      else emit(networkResponse("/api/sophia/end-session", finalization, mode === "finalization-fails" ? 500 : 202));
    } });
  const binding = { synthetic: true, principal_id: ownedRun.principalId, test_run_id: ownedRun.testRunId,
    cleanup_obligation_id: ownedRun.cleanupObligationId, scenario_id: ownedRun.scenarioId, scenario_version: ownedRun.scenarioVersion,
    environment: ownedRun.environment, retention_hours: 24, provider_expires_at: ownedRun.expiresAt.toISOString() };
  const page = {
    on: (kind: string, listener: (response: any) => void) => { if (kind === "response") responseListeners.push(listener); },
    off: (kind: string, listener: (response: any) => void) => {
      const index = kind === "response" ? responseListeners.indexOf(listener) : -1;
      if (index >= 0) responseListeners.splice(index, 1);
    },
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
    // Playwright times a waiter out; compressed here because this mock emits
    // every response during the click (plus one 5 ms retry).
    waitForResponse: (predicate: (response: any) => boolean, options?: { timeout?: number }) => new Promise((resolve, reject) => {
      waiting.push({ predicate, resolve, ...(options?.timeout === undefined ? {} : { timeout: options.timeout }) });
      if (options?.timeout) setTimeout(() => reject(new Error("synthetic waitForResponse timeout")), 50);
    }),
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
  vi.spyOn(driver, "drain").mockImplementation(async () => {
    if (mode === "late-rejection") emit(networkResponse("/api/sophia/voice/gemini/disconnect", { ok: false }, 503, f.request));
    return [];
  });
  const listenersBeforeEnd = responseListeners.length;
  const endEnteredAt = Date.now();
  const disconnectWaitTimeout = () => {
    const accepted = networkResponse("/api/sophia/voice/gemini/disconnect", {}, 202);
    return waiting.filter(waiter => waiter.predicate(accepted)).at(-1)?.timeout;
  };
  // C036: the 202 waiter is bounded by the end budget, not a fixed 20 s.
  const operationDeadlineAt = mode === "delayed-entry" ? endEnteredAt + config.endOperationSeconds * 1_000 - 30_000 : undefined;
  const expectBudgetedDisconnectWait = () => {
    // Literal contract, independent of the helper: the entry-relative window
    // (budget less a 45 s reserve), capped by the worker's absolute deadline
    // less the same reserve.
    const window = Math.max(20_000, config.endOperationSeconds * 1_000 - 45_000);
    const allowedUntil = Math.min(endEnteredAt + window, operationDeadlineAt === undefined ? Infinity : operationDeadlineAt - 45_000);
    expect(disconnectWaitTimeout()).toBeGreaterThan(allowedUntil - Date.now() - 1);
    expect(disconnectWaitTimeout()).toBeLessThanOrEqual(allowedUntil - endEnteredAt);
  };
  if (mode === "finalization-409-coded") {
    const error = await driver.end(ownedRun, "finalize", "cleanup", operationDeadlineAt).catch(error => error);
    expect(error).toBeInstanceOf(DriverEndFailure);
    expect(error.detail).toMatchObject({ code: "PRODUCT_FINALIZATION_UNCONFIRMED", details: { status: 409, product_error_code: "voice_lab_run_binding_mismatch" } });
    expect(JSON.stringify(error.detail)).not.toContain("PRIVATE");
    expect(responseListeners.length).toBe(listenersBeforeEnd);
    return;
  }
  if (mode === "finalization-fails") {
    const error = await driver.end(ownedRun, "finalize", "cleanup", operationDeadlineAt).catch(error => error);
    expect(error).toBeInstanceOf(DriverEndFailure);
    expect(error.detail.code).toBe("PRODUCT_FINALIZATION_UNCONFIRMED");
    expect(responseListeners.length).toBe(listenersBeforeEnd);
    return;
  }
  if (rejected) {
    const error = await driver.end(ownedRun, "finalize", "cleanup", operationDeadlineAt).catch(error => error);
    expect(error).toBeInstanceOf(DriverEndFailure);
    expect(error.detail.code).toBe("PROVIDER_CLEANUP_UNCONFIRMED");
    expect(error.detail.details).toMatchObject({ receiving_http_status: 401 });
    expect(error.detail.details.rejected_attempt_count).toBeGreaterThanOrEqual(1);
    expect(error.events).toContainEqual(expect.objectContaining({ kind: "session.finalized" }));
    expect(error.events.some((event: any) => event.kind === "cleanup.provider_transport_closed")).toBe(false);
    expect(driver.hasSession(ownedRun.id)).toBe(true); // Recovery still owns the browser.
    expect(responseListeners.length).toBe(listenersBeforeEnd);
    expectBudgetedDisconnectWait();
  } else {
    const ended = await driver.end(ownedRun, "finalize", "cleanup", operationDeadlineAt);
    expectBudgetedDisconnectWait();
    const acknowledged = ended.events.find(event => event.kind === "provider.disconnect_acknowledged")!;
    expect(acknowledged.payload).toMatchObject({ provider_connection_epochs: [1, 2] });
    if (mode === "aborted-candidate") expect(acknowledged.payload).toMatchObject({ aborted_candidate_epochs: [3], browser_provider_activation_abort_receipt_count: 1 });
    else expect(acknowledged.payload).not.toHaveProperty("aborted_candidate_epochs");
    if (mode === "retried" || mode === "late-rejection") expect(acknowledged.payload.rejected_receiving_attempt_count).toBeGreaterThanOrEqual(1);
    else expect(acknowledged.payload.rejected_receiving_attempt_count).toBe(0);
    expect(ended.events).toContainEqual(expect.objectContaining({ kind: "cleanup.provider_transport_closed",
      payload: expect.objectContaining({ proof_basis: "authenticated_receiving_disconnect_acknowledgement" }) }));
    expect(ended.events.some(event => event.kind === "provider.stage")).toBe(false);
    expect(driver.hasSession(ownedRun.id)).toBe(false);
    expect(child.exitCode).toBe(0);
    expect(responseListeners.length).toBe(listenersBeforeEnd);
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

// C010 E/F moved these predicates into helpers (one clause inverted at a
// time), so every clause is pinned individually against the public boundary.
function activationReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: "sophia_gemini_browser_provider_activation_v1", activation_id: "00000000-0000-4000-8000-000000000099",
    session_id: run.providerSessionId, previous_activated_epoch: 1, candidate_epoch: 2, websocket_open_observed: true,
    close_observer_attached: true, websocket_opened_at: close(1).websocket_closed_at, previous_socket_close_receipt: close(1), ...overrides };
}
function activationResponse(receipt: Record<string, unknown>, request: unknown = structuredClone(receipt)): Response {
  return {
    url: () => `${origin}/api/sophia/voice/gemini/activate`, status: () => 202, headers: () => ({ "content-type": "application/json" }),
    json: async () => ({ activated: true, session_id: receipt.session_id, provider_connection_epoch: receipt.candidate_epoch, provider_activation_receipt: receipt }),
    request: () => ({ method: () => "POST", postDataJSON: () => request }),
  } as unknown as Response;
}

it("accepts the exact activation receipt shape", async () => {
  await expect(readProviderActivationAcknowledgement(activationResponse(activationReceipt()), origin)).resolves.toMatchObject({ candidate_epoch: 2 });
});

it.each([
  ["extra key", { extra: true }],
  ["wrong schema", { schema: "sophia_gemini_browser_provider_activation_v0" }],
  ["non-string activation id", { activation_id: 99 }],
  ["non-v4 activation id", { activation_id: "00000000-0000-1000-8000-000000000099" }],
  ["non-string session id", { session_id: 7 }],
  ["unsafe session id", { session_id: "bad session" }],
  ["non-integer previous epoch", { previous_activated_epoch: 1.5, candidate_epoch: 2.5 }],
  ["negative previous epoch", { previous_activated_epoch: -1, candidate_epoch: 0 }],
  ["non-consecutive candidate", { candidate_epoch: 3 }],
  ["candidate beyond 64", { previous_activated_epoch: 64, candidate_epoch: 65 }],
  ["open not observed", { websocket_open_observed: false }],
  ["close observer missing", { close_observer_attached: false }],
  ["non-canonical opened_at", { websocket_opened_at: "yesterday" }],
] as const)("refuses an activation receipt with %s", async (_label, overrides) => {
  await expect(readProviderActivationAcknowledgement(activationResponse(activationReceipt(overrides)), origin)).resolves.toBeNull();
});

it.each([
  ["a candidate beyond the owned epoch", [activationReceipt({ previous_activated_epoch: 2, candidate_epoch: 3, previous_socket_close_receipt: close(2) })]],
  ["two different receipts for one epoch", [activationReceipt(), activationReceipt({ activation_id: "00000000-0000-4000-8000-000000000098",
    previous_socket_close_receipt: { ...close(1), websocket_close_code: 1001 } })]],
] as const)("refuses normal end when prior activation evidence has %s", async (_label, activations) => {
  const f = fixture();
  f.request.browser_provider_close_receipts.shift(); f.body.browser_provider_close_receipts.shift();
  await expect(validateNormalProviderDisconnectResponse(f.response, origin, run, activations as unknown as Record<string, unknown>[]))
    .rejects.toMatchObject({ detail: { code: "PROVIDER_CLEANUP_UNCONFIRMED", details: { validation_stage: "prior_activation_binding" } } });
});

// C021: a continuation reserves N+1 and fails before activating it. The product
// keeps N+1 unsettled and submits an exact activation-abort receipt for it; the
// run (and every bound epoch receipt) still says N. The receiving 202 must be
// accepted, while the latest ACTIVATED epoch still needs its close receipt.
function abort(candidate: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: "sophia_gemini_browser_provider_activation_abort_v1", receipt_id: `00000000-0000-4000-8000-${String(900 + candidate).padStart(12, "0")}`,
    session_id: run.providerSessionId, previous_activated_epoch: candidate - 1, candidate_epoch: candidate, websocket_created: false,
    aborted_at: "2026-09-22T12:00:01.000Z", ...overrides };
}
function withAbortedCandidate(f: ReturnType<typeof fixture>, receipt: Record<string, unknown>, into: "both" | "body" = "both") {
  f.body.browser_provider_activation_abort_receipts.push(structuredClone(receipt));
  if (into === "both") f.request.browser_provider_activation_abort_receipts.push(structuredClone(receipt));
}

describe("normal end with an aborted continuation candidate", () => {
  it("accepts N activated plus the bound aborted candidate N+1", async () => {
    const f = fixture();
    withAbortedCandidate(f, abort(3));
    const result = await validateNormalProviderDisconnectResponse(f.response, origin, run);
    expect(result).toMatchObject({ provider_connection_epochs: [1, 2], aborted_candidate_epochs: [3],
      browser_provider_close_receipt_count: 2, browser_provider_activation_abort_receipt_count: 1 });
  });

  it("keeps the acknowledgement shape unchanged when no candidate was aborted", async () => {
    const result = await validateNormalProviderDisconnectResponse(fixture().response, origin, run);
    expect(result).not.toHaveProperty("aborted_candidate_epochs");
  });

  it.each([
    ["a candidate beyond N+1", () => abort(4), "both"],
    ["an aborted candidate from another session", () => abort(3, { session_id: "foreign" }), "both"],
    ["a candidate that did create a websocket", () => abort(3, { websocket_created: true }), "both"],
    ["a non-consecutive candidate", () => abort(3, { previous_activated_epoch: 1 }), "both"],
    ["an abort the product never submitted", () => abort(3), "body"],
  ] as const)("refuses %s", async (_label, build, into) => {
    const f = fixture();
    withAbortedCandidate(f, build(), into);
    await expect(validateNormalProviderDisconnectResponse(f.response, origin, run)).rejects.toMatchObject({ detail: { code: "PROVIDER_CLEANUP_UNCONFIRMED" } });
  });

  it("still requires the close receipt of the latest activated epoch", async () => {
    const f = fixture();
    for (const value of [f.request, f.body]) value.browser_provider_close_receipts.pop();
    withAbortedCandidate(f, abort(3));
    await expect(validateNormalProviderDisconnectResponse(f.response, origin, run)).rejects.toMatchObject({ detail: { code: "PROVIDER_CLEANUP_UNCONFIRMED" } });
  });
});

// C036: the product retries a rejected disconnect at 1 s x 2^n (capped at 30 s)
// from its first attempt: 0, 1, 3, 7, 15, 31, 61 s. The receiving 202 waiter
// must span that schedule within the bounded end operation.
describe("receiving disconnect deadline versus the product retry schedule", () => {
  const PRODUCT_RETRY_AT_S = [0, 1, 3, 7, 15, 31, 61];
  function scheduledPage(statusAt: (attempt: number) => number) {
    const listeners: Array<(response: any) => void> = [];
    const waiters: Array<{ predicate: (response: any) => boolean; resolve: (response: any) => void }> = [];
    const page = {
      on: (_kind: string, listener: (response: any) => void) => { listeners.push(listener); },
      off: (_kind: string, listener: (response: any) => void) => { listeners.splice(listeners.indexOf(listener), 1); },
      // Honours the requested timeout on the (fake) clock, as Playwright does.
      waitForResponse: (predicate: (response: any) => boolean, options: { timeout: number }) => new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error("Timeout exceeded")); }, options.timeout);
      }),
    };
    PRODUCT_RETRY_AT_S.forEach((at, attempt) => setTimeout(() => {
      const status = statusAt(attempt);
      const response = { url: () => `${origin}/api/sophia/voice/gemini/disconnect`, status: () => status, request: () => ({ method: () => "POST" }) };
      for (const listener of [...listeners]) listener(response);
      for (const waiter of [...waiters]) if (waiter.predicate(response)) waiter.resolve(response);
    }, at * 1_000));
    return page as any;
  }
  const settled = (promise: Promise<unknown>) => { const state = { done: false, value: undefined as unknown }; void promise.then(value => { state.done = true; state.value = value; }); return state; };

  it("takes the authenticated 202 from the product's 31 s retry under the production end budget", async () => {
    vi.useFakeTimers();
    try {
      // Five transient failures (0..15 s), then the exact 202 on the 31 s attempt.
      const statusAt = (attempt: number) => attempt < 5 ? 503 : 202;
      const fixed = observeProviderDisconnect(scheduledPage(statusAt), origin, 20_000);
      const budgeted = observeProviderDisconnect(scheduledPage(statusAt), origin, providerDisconnectWaitMs(120));
      const [missed, accepted] = [settled(fixed.acknowledgement), settled(budgeted.acknowledgement)];
      await vi.advanceTimersByTimeAsync(31_000);
      // The previous fixed 20 s waiter (the reported race) had already given up.
      expect(missed).toEqual({ done: true, value: null });
      expect(fixed.rejected()).toEqual({ count: 5, lastStatus: 503 });
      expect(accepted.done).toBe(true);
      expect((accepted.value as any).status()).toBe(202);
      expect(budgeted.rejected()).toEqual({ count: 5, lastStatus: 503 });
      fixed.dispose(); budgeted.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("terminates boundedly at the budget-derived deadline when no 202 ever arrives", async () => {
    vi.useFakeTimers();
    try {
      const deadline = providerDisconnectWaitMs(120);
      const observer = observeProviderDisconnect(scheduledPage(() => 503), origin, deadline);
      const state = settled(observer.acknowledgement);
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(state.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(state).toEqual({ done: true, value: null });
      expect(observer.rejected()).toEqual({ count: 7, lastStatus: 503 });
      observer.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("derives the wait from the end operation budget less a fixed reserve, never below 20 s", () => {
    expect(END_POST_DISCONNECT_RESERVE_MS).toBe(45_000);
    expect(providerDisconnectWaitMs(120)).toBe(75_000); // production: covers the 31 s and 61 s retries
    expect(providerDisconnectWaitMs(75)).toBe(30_000); // configured minimum
    expect(providerDisconnectWaitMs(300)).toBe(255_000); // configured maximum still leaves the reserve
    expect(providerDisconnectWaitMs(50)).toBe(20_000);
    for (const seconds of [75, 120, 300]) expect(providerDisconnectWaitMs(seconds)).toBeLessThanOrEqual(seconds * 1_000 - END_POST_DISCONNECT_RESERVE_MS);
  });
});

// C042: the wait is bounded by the worker's absolute end-operation deadline.
describe("receiving disconnect wait under the worker's absolute end deadline", () => {
  it("still accepts the authenticated 202 on the 31 s retry after a delayed driver entry", async () => {
    vi.useFakeTimers();
    try {
      const operationStartedAt = Date.now();
      const deadlineAt = operationStartedAt + 120_000;
      const enteredAt = operationStartedAt + 10_000; // minting/fencing before driver entry
      const allowedUntil = providerDisconnectDeadlineAt(enteredAt, 120, deadlineAt);
      expect(allowedUntil).toBe(deadlineAt - END_POST_DISCONNECT_RESERVE_MS);
      await vi.advanceTimersByTimeAsync(12_000); // UI click lands 12 s into the operation
      const responses: Array<(response: any) => void> = [];
      const page = {
        on: (_kind: string, listener: (response: any) => void) => { responses.push(listener); },
        off: () => undefined,
        waitForResponse: (predicate: (response: any) => boolean, options: { timeout: number }) => new Promise((resolve, reject) => {
          responses.push((response) => { if (predicate(response)) resolve(response); });
          setTimeout(() => reject(new Error("Timeout exceeded")), options.timeout);
        }),
      };
      [0, 1, 3, 7, 15, 31].forEach((at, attempt) => setTimeout(() => {
        const response = { url: () => `${origin}/api/sophia/voice/gemini/disconnect`, status: () => attempt < 5 ? 503 : 202, request: () => ({ method: () => "POST" }) };
        for (const listener of [...responses]) listener(response);
      }, at * 1_000));
      const observer = observeProviderDisconnect(page as any, origin, allowedUntil - Date.now());
      let acknowledged: any;
      void observer.acknowledgement.then(value => { acknowledged = value; });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(acknowledged?.status()).toBe(202);
      expect(Date.now()).toBeLessThan(deadlineAt - END_POST_DISCONNECT_RESERVE_MS); // reserve intact
      observer.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("never waits past the operation deadline less the reserve, however late the entry", () => {
    const deadlineAt = 1_000_000;
    // Late entry: the absolute deadline wins over the fresh entry window.
    expect(providerDisconnectDeadlineAt(deadlineAt - 60_000, 120, deadlineAt)).toBe(deadlineAt - 45_000);
    expect(providerDisconnectDeadlineAt(deadlineAt - 40_000, 120, deadlineAt)).toBe(deadlineAt - 45_000); // already past: fails fast, bounded
    // Early entry: the entry window can only shorten it.
    expect(providerDisconnectDeadlineAt(deadlineAt - 120_000, 120, deadlineAt)).toBe(deadlineAt - 45_000);
    expect(providerDisconnectDeadlineAt(deadlineAt - 300_000, 120, deadlineAt)).toBe(deadlineAt - 300_000 + 75_000);
    // Direct driver use without a worker deadline keeps the entry window.
    expect(providerDisconnectDeadlineAt(500, 120)).toBe(500 + 75_000);
    expect(providerDisconnectDeadlineAt(500, 120, Number.NaN)).toBe(500 + 75_000);
  });
});

it("extracts only a catalogued product failure code, never free text, other fields or uncatalogued strings", () => {
  expect(productErrorCode({ error: "voice_lab_auth_run_not_found" })).toBe("voice_lab_auth_run_not_found");
  expect(productErrorCode({ detail: { code: "voice_lab_session_thread_mismatch", message: "PRIVATE" } })).toBe("voice_lab_session_thread_mismatch");
  expect(productErrorCode({ code: "voice_lab_cleanup_obligation_closed" })).toBe("voice_lab_cleanup_obligation_closed");
  // Code-shaped but uncatalogued: could be an identifier or credential, so omitted (C046).
  for (const body of [{ error: "voice_lab_secret_abcdef0123456789" }, { error: "session_token_abc123" }, { detail: { code: "abcdef0123456789abcdef" } },
    { error: "Failed to end Sophia session" }, { error: "PRIVATE user text" }, { detail: "voice_lab_auth_run_not_found" }, { error: 409 },
    { error: "Voice_Lab_Auth_Run_Not_Found" }, null, "voice_lab_auth_run_not_found", ["voice_lab_auth_run_not_found"], {}]) {
    expect(productErrorCode(body)).toBeNull();
  }
  expect(productErrorCode({ error: "voice_lab_not_catalogued_x", detail: { code: "voice_lab_session_record_not_found" } })).toBe("voice_lab_session_record_not_found");
  // The evidence projector and redaction retain a catalogued code unchanged.
  const detail = { code: "PRODUCT_FINALIZATION_UNCONFIRMED", details: { status: 409, product_error_code: productErrorCode({ error: "voice_lab_run_binding_mismatch" }) } };
  expect(projectPublicData(detail)).toEqual(detail);
  expect(redact(detail)).toEqual(detail);
});

it("catalogues every Voice Lab error code the frontend auth/capability routes and gateway end-session paths can return", async () => {
  const root = path.resolve(process.cwd(), "../..");
  const sources = ["frontend/src/server/voice-lab/capability.ts", "frontend/src/server/voice-lab/session-ledger.ts", "frontend/src/app/api/sophia/end-session/route.ts",
    ...["cleanup", "continue", "grant", "provision", "readiness", "refresh"].map(name => `frontend/src/app/api/voice-lab/auth/${name}/route.ts`),
    "backend/app/gateway/routers/sophia.py", "backend/app/gateway/voice_lab_capability.py", "backend/app/gateway/voice_lab_historical_acceptance.py", "backend/app/gateway/voice_lab_process_termination.py"];
  const found = new Set<string>();
  for (const file of sources) for (const match of (await readFile(path.join(root, file), "utf8")).matchAll(/["'](voice_lab_[a-z_]+)["']/g)) found.add(match[1]!);
  expect(found.size).toBeGreaterThan(50);
  expect([...found].filter(code => !PRODUCT_ERROR_CODES.has(code))).toEqual([]);
});

