import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { chromium, type BrowserServer } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ResolvedAudio } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import type { LabEvent } from "../src/domain.js";
import { sha256 } from "../src/security.js";
import { evaluateStudioG7Run } from "../src/studio-g7/evaluate.js";
import { StudioG7Driver } from "../src/studio-g7/studio-driver.js";
import {
  API_SHA, BRIDGE_SHA, EXCHANGE_UUID, FAKE_EMAIL, FAKE_PASSWORD, FAKE_PUBLISHABLE_KEY, PRINCIPAL_UUID, PROJECT_UUID, STUDIO_SHA,
  bindingOf, evidenceGrant, inputTurn, inputWindow, outputReply, providerReceipt, sessionClosed, speakOperation, studioRun, studioTestConfig,
} from "./studio-g7-helpers.js";

/**
 * A tiny local stand-in for the Studio room page. It uses the real Chromium
 * media stack: getUserMedia (the Lab's injected replacement), a loopback
 * RTCPeerConnection standing in for LiveKit's publish, and the product's
 * `sophia:voice-qualification` CustomEvent receipts.
 */
function resolveChromium(): string | null {
  const candidates = [process.env.SOPHIA_VOICE_LAB_TEST_CHROMIUM, chromium.executablePath(), "/opt/pw-browsers/chromium"].filter((value): value is string => typeof value === "string" && value.length > 0);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const executablePath = resolveChromium();

function sineWav(durationMs = 800, sampleRate = 16_000): Buffer {
  const samples = Math.floor(sampleRate * durationMs / 1_000);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 12_000), 44 + index * 2);
  return bytes;
}

function listen(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => handler(request, response, body));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no TCP address");
    resolve({ server, origin: `http://127.0.0.1:${address.port}` });
  }));
}

describe.skipIf(executablePath === null)("Studio G7 driver against a local fake Studio in real Chromium", () => {
  const servers: Server[] = [];
  const browserServers: BrowserServer[] = [];
  const page = { grantId: evidenceGrant(studioRun(studioTestConfig())).grantId, runBindingSha256: "" };
  const api = { exchangeId: null as string | null, receipts: [] as Array<{ seq: number; kind: string; receivedAt: string; receipt: Record<string, unknown> }>, calls: [] as string[], grant: null as Record<string, unknown> | null, onEnd: null as (() => void) | null };
  const tokens = { issued: new Set<string>(), revoked: new Set<string>() };
  let origins = { studio: "", api: "", supabase: "" };

  beforeAll(async () => {
    const supabase = await listen((request, response, body) => {
      const url = new URL(request.url ?? "/", "http://local");
      if (request.headers.apikey !== FAKE_PUBLISHABLE_KEY) { response.writeHead(401).end(); return; }
      if (request.method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
        const credentials = JSON.parse(body) as { email: string; password: string };
        if (credentials.email !== FAKE_EMAIL || credentials.password !== FAKE_PASSWORD) { response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" })); return; }
        const token = `fake-access-token-${randomUUID()}`;
        tokens.issued.add(token);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: token, refresh_token: `fake-refresh-${randomUUID()}`, token_type: "bearer", expires_in: 3_600, expires_at: Math.floor(Date.now() / 1_000) + 3_600, user: { id: PRINCIPAL_UUID, aud: "authenticated" } }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/auth/v1/logout" && url.searchParams.get("scope") === "global") {
        const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
        if (!tokens.issued.has(token) || tokens.revoked.has(token)) { response.writeHead(401).end(); return; }
        for (const issued of tokens.issued) tokens.revoked.add(issued);
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    });
    const apiServer = await listen((request, response) => {
      const url = new URL(request.url ?? "/", "http://local");
      const cors = { "access-control-allow-origin": origins.studio, "access-control-allow-headers": "authorization", "access-control-allow-methods": "GET, POST" };
      const json = (status: number, value: unknown) => response.writeHead(status, { ...cors, "content-type": "application/json" }).end(JSON.stringify(value));
      if (request.method === "OPTIONS") { response.writeHead(204, cors).end(); return; }
      if (url.pathname === "/health") { json(200, { ok: true, commit: API_SHA }); return; }
      const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!tokens.issued.has(token) || tokens.revoked.has(token)) { json(401, { error: "unauthorized" }); return; }
      api.calls.push(`${request.method} ${url.pathname}`);
      if (request.method === "POST" && url.pathname === `/test/projects/${PROJECT_UUID}/exchanges`) {
        api.exchangeId = EXCHANGE_UUID;
        json(200, { exchangeId: EXCHANGE_UUID });
        return;
      }
      if (request.method === "GET" && url.pathname === `/api/v1/projects/${PROJECT_UUID}/snapshot`) { json(200, { room: { id: "room-g7-test", sophia: { exchangeId: api.exchangeId, inputEpoch: 1 } }, work: [] }); return; }
      if (request.method === "GET" && url.pathname === `/api/v1/exchanges/${EXCHANGE_UUID}/qualification-evidence`) { json(200, { exchangeId: EXCHANGE_UUID, grants: api.grant ? [api.grant] : [], receipts: api.receipts }); return; }
      if (request.method === "POST" && url.pathname === `/api/v1/exchanges/${EXCHANGE_UUID}/end`) { api.exchangeId = null; api.onEnd?.(); api.onEnd = null; response.writeHead(204, cors).end(); return; }
      json(404, { error: "not_found" });
    });
    const studio = await listen((request, response) => {
      const url = new URL(request.url ?? "/", "http://local");
      if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><head><meta charset="utf-8"><meta name="sophia-build" content="${STUDIO_SHA}"><title>Studio</title></head><body></body></html>`); return; }
      if (url.pathname !== `/p/${PROJECT_UUID}/studio`) { response.writeHead(404).end(); return; }
      const cfg = JSON.stringify({ api: origins.api, storageKey: "sb-127-auth-token", projectId: PROJECT_UUID, grantId: page.grantId, runBindingSha256: page.runBindingSha256 });
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(`<!doctype html><html><head><meta charset="utf-8"><title>Room</title></head><body><main id="app"></main><audio data-sophia-room-audio="sophia"></audio><script>
const cfg = ${cfg};
const app = document.getElementById('app');
let session = null;
try { session = JSON.parse(localStorage.getItem(cfg.storageKey) || 'null'); } catch {}
const emit = (event, extra) => dispatchEvent(new CustomEvent('sophia:voice-qualification', { detail: { schema: 'sophia.studio.voice_qualification.v1', grantId: cfg.grantId, runBindingSha256: cfg.runBindingSha256, atMs: Date.now(), event, ...extra } }));
const button = (label, attributes) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, value); app.appendChild(node); return node; };
let pc1 = null, pc2 = null, track = null, trackSid = null, exchangeId = null, mic = null;
const sophiaSid = 'TR_SOPHIAtrack01';
async function publish() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  track = stream.getAudioTracks()[0];
  pc1 = new RTCPeerConnection(); pc2 = new RTCPeerConnection();
  pc1.onicecandidate = (event) => event.candidate && pc2.addIceCandidate(event.candidate);
  pc2.onicecandidate = (event) => event.candidate && pc1.addIceCandidate(event.candidate);
  pc1.addTrack(track, stream);
  const offer = await pc1.createOffer(); await pc1.setLocalDescription(offer); await pc2.setRemoteDescription(offer);
  const answer = await pc2.createAnswer(); await pc2.setLocalDescription(answer); await pc1.setRemoteDescription(answer);
  trackSid = 'TR_' + Math.random().toString(36).slice(2, 10) + 'Mic';
  mic.setAttribute('aria-pressed', 'true');
  emit('mic_published', { trackSid, trackId: track.id });
}
function unpublish() { if (!track) return; emit('mic_unpublished', { trackSid }); track.stop(); pc1.close(); pc2.close(); track = null; mic.setAttribute('aria-pressed', 'false'); }
if (!session || typeof session.access_token !== 'string') { app.textContent = 'Signed out'; }
else {
  const join = button('Join the room', { 'data-call-anchor': '' });
  mic = button('Microphone', { 'aria-pressed': 'false', hidden: '' });
  const speak = button('Speak with Sophia', { hidden: '' });
  const end = button('End', { hidden: '' });
  const leave = button('Leave the room', { hidden: '' });
  const show = (joined) => { join.hidden = joined; for (const node of [mic, speak, end, leave]) node.hidden = !joined; };
  join.onclick = async () => { show(true); if (localStorage.getItem('sophia.mic.v1') !== 'off') await publish(); };
  mic.onclick = async () => { if (mic.getAttribute('aria-pressed') === 'true') unpublish(); else await publish(); };
  leave.onclick = () => { unpublish(); show(false); };
  speak.onclick = async () => {
    const response = await fetch(cfg.api + '/test/projects/' + cfg.projectId + '/exchanges', { method: 'POST', headers: { authorization: 'Bearer ' + session.access_token } });
    exchangeId = (await response.json()).exchangeId;
    emit('sophia_playback', { phase: 'play', trackSid: sophiaSid, mediaTimeMs: 0 });
    emit('sophia_playback', { phase: 'playing', trackSid: sophiaSid, mediaTimeMs: 0 });
  };
  end.onclick = async () => {
    if (exchangeId) await fetch(cfg.api + '/api/v1/exchanges/' + exchangeId + '/end', { method: 'POST', headers: { authorization: 'Bearer ' + session.access_token } });
    emit('sophia_playback', { phase: 'pause', trackSid: sophiaSid, mediaTimeMs: 1200 });
  };
}
</script></body></html>`);
    });
    servers.push(supabase.server, apiServer.server, studio.server);
    origins = { studio: studio.origin, api: apiServer.origin, supabase: supabase.origin };
  }, 30_000);

  afterAll(async () => {
    for (const browserServer of browserServers) await browserServer.close().catch(() => undefined);
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }, 30_000);

  function harness() {
    const config = studioTestConfig(origins);
    const readinessDriver: Pick<VoiceBrowserDriver, "readiness" | "close"> = { readiness: async () => ({ ok: true, detail: "fixture" }), close: async () => undefined };
    const driver = new StudioG7Driver(config, config.studioG7!, {
      readinessDriver,
      launchBrowserServer: async (options) => {
        const server = await chromium.launchServer({ ...options, executablePath: executablePath! });
        browserServers.push(server);
        return server;
      },
      timeouts: { micArrivalGraceMs: 3_000, exchangeEndMs: 8_000, sessionClosedMs: 5_000, uiActionMs: 3_000 },
    });
    const run = studioRun(config);
    page.runBindingSha256 = bindingOf(run);
    api.grant = evidenceGrant(run);
    api.exchangeId = null;
    api.calls.length = 0;
    api.receipts = [];
    return { config, driver, run };
  }

  it("publishes the Lab-issued track, injects speech, reads receipts and cleans up through the product", async () => {
    const { driver, run } = harness();
    const pushReceipt = (kind: string, receipt: Record<string, unknown>) => api.receipts.push({ seq: Number(receipt.seq), kind, receivedAt: new Date().toISOString(), receipt });
    const collected: Array<Omit<LabEvent, "runId" | "seq" | "at">> = [];
    const started = await driver.start(run, "capability-not-used-by-studio");
    collected.push(...started.events);
    expect(driver.hasSession(run.id)).toBe(true);
    expect(started.observedDeployment).toEqual({ frontend: STUDIO_SHA, backend: API_SHA });
    expect(started.events.find((event) => event.kind === "studio.grant_gate.passed")?.payload).toMatchObject({ run_binding_sha256: bindingOf(run), lab_issued_track: true });
    expect(started.events.find((event) => event.kind === "studio.exchange.opened")?.payload).toMatchObject({ exchange_id: EXCHANGE_UUID, verified_by: "member_snapshot" });
    const micPublished = started.events.find((event) => event.kind === "studio.page_receipt" && event.payload.event === "mic_published");
    const trackId = JSON.parse(String(micPublished!.payload.receipt_json)).trackId as string;
    const issued = started.events.filter((event) => event.kind === "harness.media_stream_issued").flatMap((event) => event.payload.track_id_sha256s as string[]);
    // The page's published microphone is exactly a track the Lab issued.
    expect(issued).toContain(sha256(trackId));
    expect(started.events.find((event) => event.kind === "harness.media_stream_issued")?.payload).toMatchObject({ issuance: "fresh_clone_per_request", replacement_active: true });

    // Bridge receipts for the opened exchange.
    pushReceipt("provider", providerReceipt(run, 1, "setup"));
    pushReceipt("provider", providerReceipt(run, 2, "ready"));
    const wav = sineWav(800);
    const audio: ResolvedAudio = { id: "sine", sha256: createHash("sha256").update(wav).digest("hex"), sampleRate: 16_000, channels: 1, durationMs: 800, bytes: wav, source: "fixture", synthesis: { engine: "fixture", engine_version: "1", voice: "none", rate: "none" } };
    const operation = speakOperation(run, new Date());
    const scheduled = await driver.schedule(run, operation.id, randomUUID(), audio, 0);
    collected.push(...scheduled.events);
    const deadline = Date.now() + 15_000;
    while (!collected.some((event) => event.kind === "audio.input.completed") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      collected.push(...await driver.drain(run.id));
    }
    expect(collected.some((event) => event.kind === "audio.input.completed" && event.payload.operation_id === operation.id)).toBe(true);
    pushReceipt("input_window", inputWindow(run, 3, 1, 800));
    pushReceipt("input_turn", inputTurn(run, 4, 1));
    pushReceipt("output_reply", outputReply(run, 5, 1, Date.now()));
    api.onEnd = () => {
      pushReceipt("provider", providerReceipt(run, 6, "closed"));
      pushReceipt("session_closed", sessionClosed(run, 7, { windows: 1, turns: 1, replies: 1 }));
    };
    collected.push(...await driver.drain(run.id, true));
    const stats = collected.filter((event) => event.kind === "studio.webrtc.sender_stats");
    expect(stats.length).toBeGreaterThan(0);
    expect(stats.flatMap((event) => event.payload.rows as Array<Record<string, unknown>>).some((row) => row.lab_issued_track === true)).toBe(true);

    // Leave and return: LiveKit-style unpublish stops the local track, so the
    // returning participant must acquire a fresh, live, Lab-issued track.
    const returned = await driver.leaveAndReturn(run);
    collected.push(...returned);
    expect(returned.map((event) => event.kind)).toEqual(expect.arrayContaining(["studio.room.left", "studio.room.joined", "studio.room.rejoined"]));
    const republished = returned.filter((event) => event.kind === "studio.page_receipt" && event.payload.event === "mic_published").map((event) => JSON.parse(String(event.payload.receipt_json)).trackId as string);
    expect(republished).toHaveLength(1);
    expect(republished[0]).not.toBe(trackId);
    const reissued = collected.filter((event) => event.kind === "harness.media_stream_issued").flatMap((event) => event.payload.track_id_sha256s as string[]);
    expect(reissued).toContain(sha256(republished[0]!));
    // Corroboration only: the published RTP sender now carries the new
    // Lab-issued track. (Packet counts are not asserted: the loopback ICE
    // pair does not connect in every sandbox, and stats never satisfy a receipt.)
    const batch = await driver.drain(run.id, true);
    collected.push(...batch);
    const senderRow = batch.filter((event) => event.kind === "studio.webrtc.sender_stats").flatMap((event) => event.payload.rows as Array<Record<string, unknown>>)
      .find((row) => row.track_id_sha256 === sha256(republished[0]!));
    expect(senderRow).toMatchObject({ lab_issued_track: true });

    const ended = await driver.end(run, "unused", "unused");
    collected.push(...ended.events);
    expect(driver.hasSession(run.id)).toBe(false);
    expect(api.exchangeId).toBeNull();
    expect(ended.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: true, basis: "ui_end", verified_by: "member_snapshot" });
    expect(ended.events.find((event) => event.kind === "studio.cleanup.signed_out")?.payload).toMatchObject({ confirmed: true, scope: "global" });
    expect(ended.events.find((event) => event.kind === "cleanup.browser_context_closed")?.payload).toMatchObject({ close_resolved: true, browser_process_close_resolved: true, process_exited_before_close: false });
    expect(collected.some((event) => event.kind === "studio.bridge_receipt" && event.payload.kind === "session_closed")).toBe(true);
    // No credential appears in any durable event.
    const serialized = JSON.stringify(collected);
    expect(serialized).not.toContain(FAKE_PASSWORD);
    expect(serialized).not.toContain("fake-access-token-");
    expect(serialized).not.toContain("fake-refresh-");

    const events: LabEvent[] = [
      { kind: "utterance.resolved", source: "worker" as const, payload: { operation_id: operation.id, wav: { sha256: audio.sha256, duration_ms: audio.durationMs } }, dedupeKey: null },
      ...collected,
      { kind: "cleanup.browser_lease_released", source: "worker" as const, payload: { cas_deleted: true }, dedupeKey: null },
    ].map((event, index) => ({ ...event, runId: run.id, seq: index + 1, at: new Date(), dedupeKey: event.dedupeKey ?? null }));
    const evaluation = evaluateStudioG7Run(run, events, [operation], { expected: { studio: STUDIO_SHA, api: API_SHA, bridge: BRIDGE_SHA } });
    const status = (id: string) => [...evaluation.harness, ...evaluation.product].find((assertion) => assertion.id === id)?.status;
    for (const id of ["binding.run_binding", "input.published_track_is_lab_issued", "input.1.r1_scheduling_chain", "input.1.r2_published_track_identity", "input.1.r3_playout_chain", "input.window_join", "input.1.window_envelope", "input.1.turn_accepted", "provider.lifecycle", "output.audible_reply", "output.page_playback_join", "session.closed_receipt", "cleanup.exchange_ended", "cleanup.principal_signed_out", "cleanup.browser_closed", "identity.api", "identity.studio", "identity.bridge"]) {
      expect(status(id), id).toBe("pass");
    }
    expect(evaluation.steps.find((step) => step.step_id === "g7.leave_return")).toMatchObject({ status: "pass" });
  }, 90_000);

  it("types a rejected password as an auth failure and still proves the browser closed", async () => {
    const config = studioTestConfig(origins, { SOPHIA_VOICE_LAB_STUDIO_PRINCIPAL_PASSWORD: "wrong-fake-password-0002" });
    const driver = new StudioG7Driver(config, config.studioG7!, {
      readinessDriver: { readiness: async () => ({ ok: true, detail: "fixture" }), close: async () => undefined },
      launchBrowserServer: async (options) => { const server = await chromium.launchServer({ ...options, executablePath: executablePath! }); browserServers.push(server); return server; },
    });
    const run = studioRun(config);
    const error = await driver.start(run, "unused").catch((caught: unknown) => caught) as { detail?: Record<string, unknown>; message?: string };
    expect(error.detail).toMatchObject({ code: "STUDIO_AUTH_REJECTED", category: "authorization", details: { http_status: 400, supabase_error_code: "invalid_grant" } });
    expect(JSON.stringify({ detail: error.detail, message: error.message })).not.toContain("wrong-fake-password-0002");
    expect(driver.hasSession(run.id)).toBe(true);
    const aborted = await driver.abort(run, "STUDIO_AUTH_REJECTED");
    expect(driver.hasSession(run.id)).toBe(false);
    expect(aborted.events.find((event) => event.kind === "studio.cleanup.signed_out")?.payload).toMatchObject({ confirmed: true, basis: "no_session_issued" });
    expect(aborted.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: true, basis: "no_exchange_opened_by_run" });
    expect(aborted.events.find((event) => event.kind === "cleanup.browser_context_closed")?.payload).toMatchObject({ close_resolved: true, process_exited_before_close: false });
    expect(JSON.stringify(aborted.events)).not.toContain("wrong-fake-password-0002");
  }, 60_000);

  it("abort ends the exchange through the API and signs out when the browser process is dead", async () => {
    const { driver, run } = harness();
    await driver.start(run, "capability-not-used-by-studio");
    expect(api.exchangeId).toBe(EXCHANGE_UUID);
    const owned = browserServers.at(-1)!;
    const exited = new Promise<void>((resolve) => owned.process().once("exit", () => resolve()));
    owned.process().kill("SIGKILL");
    await exited;
    await expect(driver.drain(run.id)).rejects.toMatchObject({ detail: { code: "BROWSER_EXECUTION_EPOCH_LOST" } });
    const aborted = await driver.abort(run, "BROWSER_EXECUTION_EPOCH_LOST");
    expect(api.exchangeId).toBeNull();
    expect(api.calls).toContain(`POST /api/v1/exchanges/${EXCHANGE_UUID}/end`);
    expect(aborted.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: true, basis: "api_end", exchange_id: EXCHANGE_UUID });
    expect(aborted.events.find((event) => event.kind === "studio.cleanup.signed_out")?.payload).toMatchObject({ confirmed: true, scope: "global" });
    expect(aborted.events.find((event) => event.kind === "cleanup.browser_context_closed")?.payload).toMatchObject({ close_resolved: true, process_exited_before_close: true });
    expect(aborted.events.some((event) => event.kind === "cleanup.capture_unavailable")).toBe(true);
    expect(driver.hasSession(run.id)).toBe(false);
  }, 90_000);
});
