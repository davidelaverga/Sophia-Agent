import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { chromium, type BrowserServer } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ResolvedAudio } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import type { LabEvent, OperationRecord } from "../src/domain.js";
import { sha256 } from "../src/security.js";
import { deriveStudioG7Verdicts, evaluateStudioG7Run, studioG7CleanupProof } from "../src/studio-g7/evaluate.js";
import { ownerCleanupForLease } from "../src/studio-g7/lease-release.js";
import { passwordGrant } from "../src/studio-g7/supabase-session.js";
import { StudioG7Driver } from "../src/studio-g7/studio-driver.js";
import {
  API_SHA, BRIDGE_SHA, EXCHANGE_UUID, FAKE_EMAIL, FAKE_PASSWORD, FAKE_PUBLISHABLE_KEY, PRINCIPAL_UUID, PROJECT_UUID, STUDIO_SHA,
  bindingOf, evidenceGrant, inputTurn, inputWindow, outputReply, providerReceipt, sessionClosed, speakOperation, studioRun, studioTestConfig,
} from "./studio-g7-helpers.js";

/**
 * A local stand-in for the Studio room page, its member API, Supabase Auth
 * and the object store, driven by the real Chromium media stack:
 * getUserMedia (the Lab's injected replacement), a loopback
 * RTCPeerConnection standing in for LiveKit's publish (it proves no packet
 * flow to any SFU: a named limitation), and the product's
 * `sophia:voice-qualification` receipts. The fake API answers in the exact
 * migration-0046 evidence shape and returns free text (instructions,
 * Markdown, note words, titles) that the Lab must drop at its boundary.
 */
function resolveChromium(): string | null {
  const candidates = [process.env.SOPHIA_VOICE_LAB_TEST_CHROMIUM, chromium.executablePath(), "/opt/pw-browsers/chromium"].filter((value): value is string => typeof value === "string" && value.length > 0);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const executablePath = resolveChromium();
const OTHER_PRINCIPAL = "12345678-1234-4234-8234-123456789abc";
const OTHER_EXCHANGE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const FREE_TEXT = ["Build me a page about river otters", "secret research markdown body", "the user's dog is called Rex", "Make the introduction shorter please", "A newer version of this report exists"];
const PREVIEW_PROOF = `v1.1791500000.${"c".repeat(64)}`;
const SIGNATURE = "X-Amz-Signature=fakesignature0123456789";

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

type Row = { source: string; seq: number; kind: string; receivedAt: string; receipt: Record<string, unknown> };
type DriverEvent = Omit<LabEvent, "runId" | "seq" | "at">;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const OWNER = { workerId: "chromium-probe-owner", leaseEpoch: 1, expiresAt: new Date(Date.now() - 600_000) };

/**
 * The ledger order the worker gives driver events: each batch is persisted in
 * turn and an event already persisted under its dedupe key keeps its first
 * seq (so a confirmation drained late lands after the write-ahead anchors).
 */
function ledgerOrder(runId: string, batches: DriverEvent[][]): LabEvent[] {
  const events: LabEvent[] = [];
  const seen = new Set<string>();
  for (const batch of batches) for (const event of batch) {
    if (event.dedupeKey && seen.has(event.dedupeKey)) continue;
    if (event.dedupeKey) seen.add(event.dedupeKey);
    events.push({ ...event, runId, seq: events.length + 1, at: new Date(), dedupeKey: event.dedupeKey ?? null });
  }
  return events;
}

/** The worker's acquisition batch: the process acquisition and the runtime bound to (owner, lease epoch). */
function acquisitionRecorder(batches: DriverEvent[][]) {
  return async (acquisition: DriverEvent): Promise<void> => {
    batches.push([acquisition, { kind: "harness.browser_runtime_acquired", source: "canonical", payload: { worker_id_sha256: sha256(OWNER.workerId), browser_lease_epoch: OWNER.leaseEpoch }, dedupeKey: "runtime" }]);
  };
}

describe.skipIf(executablePath === null)("Studio G7 driver against a local fake Studio in real Chromium", () => {
  const servers: Server[] = [];
  const browserServers: BrowserServer[] = [];
  const page = { grantId: evidenceGrant(studioRun(studioTestConfig())).grantId as string, runBindingSha256: "", micDelayMs: 0, serves: 0 };
  const api = {
    exchangeId: null as string | null, inputActorId: PRINCIPAL_UUID, evidenceMode: "ok" as "ok" | "missing" | "foreign",
    receipts: [] as Row[], calls: [] as string[], grant: null as Record<string, unknown> | null, onEnd: null as (() => void) | null,
    onEvidence: null as (() => void) | null, openDelayMs: 0, ended: [] as string[], openTimer: null as ReturnType<typeof setTimeout> | null,
    work: [] as Array<Record<string, unknown>>, tasks: new Map<string, Record<string, unknown>>(), versions: new Map<string, Array<Record<string, unknown>>>(),
    contents: new Map<string, Buffer>(), mission: [] as Array<Record<string, unknown>>, edits: new Map<string, { status: number; body: unknown }>(), withdrawals: [] as unknown[],
  };
  const tokens = { issued: new Set<string>(), revoked: new Set<string>(), expiresIn: 3_600, failLocal: 0, logouts: [] as string[] };
  let origins = { studio: "", api: "", supabase: "", store: "" };

  const ids = { research: randomUUID(), design: randomUUID(), edit: randomUUID(), artifact: randomUUID(), v1: randomUUID(), v2: randomUUID(), html1: randomUUID(), html2: randomUUID(), md: randomUUID(), note: randomUUID(), decision: randomUUID() };
  const html1 = Buffer.from("<!doctype html><section id=intro>Otters</section>");
  const html2 = Buffer.from("<!doctype html><section id=intro>Otters, briefly</section>");

  function nativeTask(id: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, kind, goalId: randomUUID(), attemptId: randomUUID(), commandId: randomUUID(), actorId: PRINCIPAL_UUID, state: "running", phase: "running", createdAt: new Date().toISOString(), contextSourceId: randomUUID(), inputSourceIds: [], resultSourceId: null, reason: null, ...extra };
  }
  function version(id: string, htmlSource: string, html: Buffer, parentId: string | null): Record<string, unknown> {
    return { id, artifactId: ids.artifact, projectId: PROJECT_UUID, parentId, sourceId: ids.md, sourceHash: sha256("markdown"), state: "stable", previewId: null, format: "markdown", exportEditability: "source_editable", title: "River otters report", versionNumber: parentId ? 2 : 1, limitations: ["free text limitation"], renditions: [{ format: "html", sourceId: htmlSource, sha256: createHash("sha256").update(html).digest("hex"), byteLength: html.byteLength, mime: "text/html", pageCount: null }] };
  }
  /** The product's reaction to the create utterance: a research task handing its HTML to a published design. */
  function createReport(): void {
    const research = nativeTask(ids.research, "research");
    const design = nativeTask(ids.design, "design", { state: "succeeded", phase: "result_ready", artifactId: ids.artifact });
    api.work = [research, design];
    api.tasks.set(ids.research, { task: research, instruction: FREE_TEXT[0], result: { markdown: FREE_TEXT[1], sourceId: ids.md, sha256: sha256("markdown"), outputs: [] }, research: { question: FREE_TEXT[0], specialist: "x", outputs: [], rootTaskId: ids.research, capUsd: 1, committedUsd: 0, spentUsd: 0, searches: {}, reads: {}, html: { state: "published", designTaskId: ids.design } } });
    api.tasks.set(ids.design, { task: design, instruction: FREE_TEXT[0], result: null, design: { researchTaskId: ids.research, artifactId: ids.artifact, baseVersionId: ids.v1, state: "published", targets: [], revisions: 0, renders: 1, candidates: [], maxRepairs: 2, publishedVersionId: ids.v1, mode: "create", sections: ["intro", "findings"] } });
    api.versions.set(ids.artifact, [version(ids.v1, ids.html1, html1, null)]);
    api.contents.set(ids.html1, html1);
    api.mission = [{ id: ids.note, kind: "observation", epistemic: "reported", state: "current", text: FREE_TEXT[2], textKind: "member_text", authoredBy: "member", actorId: PRINCIPAL_UUID, origin: "voice", exchangeId: EXCHANGE_UUID, inputEpoch: 1 }];
  }
  function setPhase(taskId: string, phase: string, state = "running"): void {
    api.work = api.work.map((task) => task.id === taskId ? { ...task, phase, state } : task);
    const detail = api.tasks.get(taskId)!;
    api.tasks.set(taskId, { ...detail, task: { ...(detail.task as Record<string, unknown>), phase, state } });
  }

  beforeAll(async () => {
    const supabase = await listen((request, response, body) => {
      const url = new URL(request.url ?? "/", "http://local");
      if (request.headers.apikey !== FAKE_PUBLISHABLE_KEY) { response.writeHead(401).end(); return; }
      if (request.method === "GET" && url.pathname === "/auth/v1/health") { response.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
      if (request.method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
        const credentials = JSON.parse(body) as { email: string; password: string };
        if (credentials.email !== FAKE_EMAIL || credentials.password !== FAKE_PASSWORD) { response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" })); return; }
        const token = `fake-access-token-${randomUUID()}`;
        tokens.issued.add(token);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: token, refresh_token: `fake-refresh-${randomUUID()}`, token_type: "bearer", expires_in: tokens.expiresIn, expires_at: Math.floor(Date.now() / 1_000) + tokens.expiresIn, user: { id: PRINCIPAL_UUID, aud: "authenticated" } }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/auth/v1/logout" && url.searchParams.get("scope") === "global") {
        tokens.logouts.push("global");
        const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
        if (!tokens.issued.has(token) || tokens.revoked.has(token)) { response.writeHead(401).end(); return; }
        for (const issued of tokens.issued) tokens.revoked.add(issued);
        response.writeHead(204).end();
        return;
      }
      // scope=local revokes only the presented session, as Supabase Auth does.
      if (request.method === "POST" && url.pathname === "/auth/v1/logout" && url.searchParams.get("scope") === "local") {
        tokens.logouts.push("local");
        const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
        if (tokens.failLocal > 0) { tokens.failLocal -= 1; response.writeHead(503).end(); return; }
        if (!tokens.issued.has(token) || tokens.revoked.has(token)) { response.writeHead(401).end(); return; }
        tokens.revoked.add(token);
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    });
    const store = await listen((request, response) => {
      const url = new URL(request.url ?? "/", "http://local");
      const match = /^\/obj\/([0-9a-f-]{36})$/.exec(url.pathname);
      const bytes = match ? api.contents.get(match[1]!) : undefined;
      if (!bytes || !(request.url ?? "").includes(SIGNATURE)) { response.writeHead(403).end(); return; }
      response.writeHead(200, { "content-type": "text/html", "content-length": String(bytes.byteLength) }).end(bytes);
    });
    const apiServer = await listen((request, response, body) => {
      const url = new URL(request.url ?? "/", "http://local");
      const cors = { "access-control-allow-origin": origins.studio, "access-control-allow-headers": "authorization", "access-control-allow-methods": "GET, POST" };
      const json = (status: number, value: unknown) => response.writeHead(status, { ...cors, "content-type": "application/json" }).end(JSON.stringify(value));
      if (request.method === "OPTIONS") { response.writeHead(204, cors).end(); return; }
      if (url.pathname === "/health") { json(200, { ok: true, commit: API_SHA }); return; }
      if (url.pathname === "/ready") { json(200, { ready: true }); return; }
      const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!tokens.issued.has(token) || tokens.revoked.has(token)) { json(401, { error: "unauthorized" }); return; }
      api.calls.push(`${request.method} ${url.pathname}`);
      const path = url.pathname;
      if (request.method === "POST" && path === `/test/projects/${PROJECT_UUID}/exchanges`) {
        const open = () => { api.exchangeId = EXCHANGE_UUID; json(200, { exchangeId: EXCHANGE_UUID }); };
        if (api.openDelayMs > 0) api.openTimer = setTimeout(open, api.openDelayMs); else open();
        return;
      }
      if (request.method === "GET" && path === `/api/v1/projects/${PROJECT_UUID}/snapshot`) {
        json(200, { projectId: PROJECT_UUID, title: "Synthetic", room: { id: "room-g7-test", revision: 1, inputActorId: api.exchangeId ? api.inputActorId : null, mode: "invoked", sophia: { exchangeId: api.exchangeId, exchange: api.exchangeId ? "open" : "none", inputEpoch: 1, inputActorId: api.exchangeId ? api.inputActorId : null } }, work: api.work });
        return;
      }
      if (request.method === "GET" && path === `/api/v1/exchanges/${EXCHANGE_UUID}/qualification-evidence`) {
        if (api.evidenceMode === "missing" || !api.grant) { json(404, { code: "not_found", message: "Qualification evidence not found" }); return; }
        const grant = api.evidenceMode === "foreign" ? { ...api.grant, runBindingSha256: "e".repeat(64) } : api.grant;
        json(200, { exchangeId: EXCHANGE_UUID, state: api.exchangeId === EXCHANGE_UUID ? "open" : "ended", grant, receipts: api.evidenceMode === "foreign" ? [] : [...api.receipts].sort((left, right) => left.source === right.source ? left.seq - right.seq : left.source < right.source ? -1 : 1) });
        // Product changes that land right after this answer (e.g. the guard ends the exchange).
        api.onEvidence?.();
        return;
      }
      const endMatch = /^\/api\/v1\/exchanges\/([0-9a-f-]{36})\/end$/.exec(path);
      if (request.method === "POST" && endMatch) {
        // End is id-bound: it ends exactly the named exchange, if it is the live one.
        api.ended.push(endMatch[1]!);
        if (api.exchangeId === endMatch[1]) { api.exchangeId = null; api.onEnd?.(); api.onEnd = null; }
        response.writeHead(204, cors).end();
        return;
      }
      const taskMatch = new RegExp(`^/api/v1/projects/${PROJECT_UUID}/native-tasks/([0-9a-f-]{36})$`).exec(path);
      if (request.method === "GET" && taskMatch) { const detail = api.tasks.get(taskMatch[1]!); if (detail) json(200, detail); else json(404, { code: "not_found", message: "Task not found" }); return; }
      const versionsMatch = /^\/api\/v1\/artifacts\/([0-9a-f-]{36})\/versions$/.exec(path);
      if (request.method === "GET" && versionsMatch) { json(200, api.versions.get(versionsMatch[1]!) ?? []); return; }
      const sourceMatch = /^\/api\/v1\/sources\/([0-9a-f-]{36})\/content$/.exec(path);
      if (request.method === "GET" && sourceMatch) {
        const bytes = api.contents.get(sourceMatch[1]!);
        if (!bytes) { json(404, { code: "not_found", message: "Source not found" }); return; }
        json(200, { sourceId: sourceMatch[1], sha256: createHash("sha256").update(bytes).digest("hex"), mime: "text/html", byteLength: bytes.byteLength, filename: "River otters.html", disposition: "inline", downloadUrl: `${origins.store}/obj/${sourceMatch[1]}?${SIGNATURE}`, expiresAt: new Date(Date.now() + 60_000).toISOString() });
        return;
      }
      if (request.method === "GET" && path === `/api/v1/projects/${PROJECT_UUID}/mission`) { json(200, { projectId: PROJECT_UUID, entries: api.mission, history: [] }); return; }
      if (path === `/api/v1/projects/${PROJECT_UUID}/mission/entries/${ids.note}/withdrawal`) {
        if (request.method === "GET") { json(200, { entryId: ids.note, ledgerRevision: 4, previewToken: PREVIEW_PROOF, expiresAt: new Date(Date.now() + 900_000).toISOString(), entries: [{ id: ids.note, state: "current", text: FREE_TEXT[2] }], decisions: [{ id: ids.decision, kind: "mission", state: "accepted", revision: 2, statement: FREE_TEXT[2], purpose: null, destination: null, origin: null }] }); return; }
        const parsed = JSON.parse(body) as { previewToken: string; expectedAffected: { entryIds: string[]; decisions: Array<{ id: string; revision: number }> } };
        api.withdrawals.push({ idempotencyKey: request.headers["idempotency-key"], ...parsed });
        if (parsed.previewToken !== PREVIEW_PROOF || JSON.stringify(parsed.expectedAffected) !== JSON.stringify({ entryIds: [ids.note], decisions: [{ id: ids.decision, revision: 2 }] })) { json(409, { code: "stale_revision", message: FREE_TEXT[4] }); return; }
        api.mission = api.mission.map((entry) => ({ ...entry, state: "withdrawn", text: null }));
        const design = api.tasks.get(ids.design)!;
        api.tasks.set(ids.design, { ...design, design: { ...(design.design as Record<string, unknown>), state: "cancelled" } });
        json(202, { status: "committed", operation: "withdraw_note", projectId: PROJECT_UUID, entryId: ids.note, decisionId: null, decisionRevision: null, decision: null, sourceId: null, sha256: null, affected: [ids.note], ledgerRevision: 5, missionRevision: 2, eligibilityRevision: 2, cursor: "12" });
        return;
      }
      if (request.method === "POST" && path === `/api/v1/projects/${PROJECT_UUID}/html-edits`) {
        const key = String(request.headers["idempotency-key"] ?? "");
        const prior = api.edits.get(key);
        if (prior) { json(prior.status, prior.body); return; }
        const parsed = JSON.parse(body) as { versionId: string; sections: string[]; instruction: string };
        const versions = api.versions.get(ids.artifact) ?? [];
        if (parsed.versionId !== versions[0]?.id) { const answer = { status: 409, body: { code: "stale_revision", message: FREE_TEXT[4], requestId: randomUUID(), retry: "reconcile_first" } }; api.edits.set(key, answer); json(answer.status, answer.body); return; }
        const edit = nativeTask(ids.edit, "design", { state: "succeeded", phase: "result_ready", artifactId: ids.artifact });
        api.work = [...api.work, edit];
        api.tasks.set(ids.edit, { task: edit, instruction: parsed.instruction, result: null, design: { researchTaskId: ids.research, artifactId: ids.artifact, baseVersionId: ids.v1, state: "published", targets: [], revisions: 1, renders: 1, candidates: [], maxRepairs: 2, publishedVersionId: ids.v2, mode: "edit", sections: parsed.sections } });
        api.versions.set(ids.artifact, [version(ids.v2, ids.html2, html2, ids.v1), ...versions]);
        api.contents.set(ids.html2, html2);
        const answer = { status: 202, body: { taskId: ids.edit, state: "designing", versionId: parsed.versionId, baseCandidateId: randomUUID(), sections: parsed.sections, shell: false, styles: false, contributionId: randomUUID() } };
        api.edits.set(key, answer);
        json(answer.status, answer.body);
        return;
      }
      json(404, { error: "not_found" });
    });
    const studio = await listen((request, response) => {
      const url = new URL(request.url ?? "/", "http://local");
      if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><head><meta charset="utf-8"><meta name="sophia-build" content="${STUDIO_SHA}"><title>Studio</title></head><body></body></html>`); return; }
      if (url.pathname !== `/p/${PROJECT_UUID}/studio`) { response.writeHead(404).end(); return; }
      page.serves += 1;
      const cfg = JSON.stringify({ api: origins.api, storageKey: "sb-127-auth-token", projectId: PROJECT_UUID, grantId: page.grantId, runBindingSha256: page.runBindingSha256, micDelayMs: page.micDelayMs });
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
  join.onclick = async () => { show(true); if (cfg.micDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, cfg.micDelayMs)); if (localStorage.getItem('sophia.mic.v1') !== 'off') await publish(); };
  mic.onclick = async () => { if (mic.getAttribute('aria-pressed') === 'true') unpublish(); else await publish(); };
  leave.onclick = () => { unpublish(); show(false); };
  speak.onclick = async () => {
    const response = await fetch(cfg.api + '/test/projects/' + cfg.projectId + '/exchanges', { method: 'POST', headers: { authorization: 'Bearer ' + session.access_token } });
    exchangeId = (await response.json()).exchangeId;
    emit('sophia_playback', { phase: 'play', trackSid: sophiaSid, mediaTimeMs: 0 });
    emit('sophia_playback', { phase: 'playing', trackSid: sophiaSid, mediaTimeMs: 0 });
  };
  end.onclick = async () => {
    // Like the room UI, End acts on whatever exchange the room shows now.
    const shown = await (await fetch(cfg.api + '/api/v1/projects/' + cfg.projectId + '/snapshot', { headers: { authorization: 'Bearer ' + session.access_token } })).json();
    const current = shown && shown.room && shown.room.sophia ? shown.room.sophia.exchangeId : null;
    if (current) await fetch(cfg.api + '/api/v1/exchanges/' + current + '/end', { method: 'POST', headers: { authorization: 'Bearer ' + session.access_token } });
    emit('sophia_playback', { phase: 'pause', trackSid: sophiaSid, mediaTimeMs: 1200 });
  };
}
</script></body></html>`);
    });
    servers.push(supabase.server, apiServer.server, studio.server, store.server);
    origins = { studio: studio.origin, api: apiServer.origin, supabase: supabase.origin, store: store.origin };
  }, 30_000);

  afterAll(async () => {
    for (const browserServer of browserServers) await browserServer.close().catch(() => undefined);
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }, 30_000);

  function harness(overrides: NodeJS.ProcessEnv = {}, timeouts: Record<string, number> = {}) {
    const config = studioTestConfig({ studio: origins.studio, api: origins.api, supabase: origins.supabase }, {
      SOPHIA_VOICE_LAB_ALLOWED_ORIGINS: `http://frontend.test,http://gateway.test,http://voice.test,http://langgraph.test,${origins.studio},${origins.api},${origins.supabase},${origins.store}`,
      SOPHIA_VOICE_LAB_STUDIO_OBJECT_STORE_ORIGINS: origins.store,
      ...overrides,
    });
    const readinessDriver: Pick<VoiceBrowserDriver, "readiness" | "close"> = { readiness: async () => ({ ok: true, detail: "fixture" }), close: async () => undefined };
    const driver = new StudioG7Driver(config, config.studioG7!, {
      readinessDriver,
      launchBrowserServer: async (options) => {
        const server = await chromium.launchServer({ ...options, executablePath: executablePath! });
        browserServers.push(server);
        return server;
      },
      timeouts: { micArrivalGraceMs: 3_000, exchangeEndMs: 8_000, sessionClosedMs: 5_000, uiActionMs: 3_000, designSettleMs: 5_000, ...timeouts },
    });
    const run = studioRun(config);
    page.micDelayMs = 0;
    page.serves = 0;
    tokens.expiresIn = 3_600;
    tokens.failLocal = 0;
    tokens.logouts.length = 0;
    page.runBindingSha256 = bindingOf(run);
    api.grant = evidenceGrant(run);
    api.exchangeId = null;
    api.inputActorId = PRINCIPAL_UUID;
    api.evidenceMode = "ok";
    api.onEvidence = null;
    // A delayed open left over from an earlier test must never land in this one.
    if (api.openTimer !== null) clearTimeout(api.openTimer);
    api.openTimer = null;
    api.openDelayMs = 0;
    api.ended.length = 0;
    api.calls.length = 0;
    api.receipts = [];
    api.work = [];
    api.tasks.clear();
    api.versions.clear();
    api.contents.clear();
    api.mission = [];
    api.edits.clear();
    api.withdrawals.length = 0;
    return { config, driver, run };
  }

  const audioOf = (wav: Buffer): ResolvedAudio => ({ id: "sine", sha256: createHash("sha256").update(wav).digest("hex"), sampleRate: 16_000, channels: 1, durationMs: 800, bytes: wav, source: "fixture", synthesis: { engine: "fixture", engine_version: "1", voice: "none", rate: "none" } });

  it("performs the whole G7 episode as operations, reads canonical outcomes, and cleans up only what it owns", async () => {
    const { driver, run } = harness();
    let seq = 0;
    const push = (kind: string, receipt: Record<string, unknown>) => api.receipts.push({ source: kind === "guard" ? "service" : "bridge", seq: Number(receipt.seq), kind, receivedAt: new Date().toISOString(), receipt });
    const collected: Array<Omit<LabEvent, "runId" | "seq" | "at">> = [];
    const durable: string[] = [];
    const started = await driver.start(run, "capability-not-used-by-studio", undefined, undefined, undefined, async (events) => { durable.push(...events.map((event) => event.kind)); });
    collected.push(...started.events);
    // Write-ahead: the Speak intent is durable before the click, the join right after.
    expect(durable.indexOf("studio.exchange.speak_requested")).toBeGreaterThan(-1);
    expect(durable.indexOf("studio.exchange.opened")).toBeGreaterThan(durable.indexOf("studio.exchange.speak_requested"));
    expect(started.events.find((event) => event.kind === "studio.exchange.opened")?.payload).toMatchObject({ exchange_id: EXCHANGE_UUID, grant_id: page.grantId, input_actor_is_principal: true });
    expect(started.events.find((event) => event.kind === "studio.exchange.ownership")?.payload).toMatchObject({ status: "proven", run_binding_matches: true });
    // The access-JWT lifetime the product issued is durable (it bounds a dead owner's lease release).
    expect(started.events.find((event) => event.kind === "studio.auth.session_established")?.payload).toMatchObject({ expires_in_s: 3_600 });

    push("provider", providerReceipt(run, seq++, "ready"));
    const operations: OperationRecord[] = [];
    const wav = sineWav(800);
    const speakStep = async (step: string) => {
      const operation = speakOperation(run, new Date(Date.now() + operations.length), { input: { fixture_id: "sine", _g7_step: `g7.${step}` } });
      operations.push(operation);
      collected.push(...(await driver.schedule(run, operation.id, randomUUID(), audioOf(wav), 0)).events);
      const deadline = Date.now() + 15_000;
      while (!collected.some((event) => event.kind === "audio.input.completed" && event.payload.operation_id === operation.id) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        collected.push(...await driver.drain(run.id));
      }
      const ordinal = operations.filter((candidate) => candidate.type === "speak").length;
      push("input_window", inputWindow(run, seq++, ordinal, 800));
      push("input_turn", inputTurn(run, seq++, ordinal));
      push("output_reply", outputReply(run, seq++, ordinal, Date.now()));
    };
    const act = async (input: Record<string, unknown>) => {
      const operation: OperationRecord = { ...speakOperation(run, new Date(Date.now() + operations.length)), type: "studio_action", input, result: null };
      const result = await driver.studioAction(run, operation.id, input);
      collected.push(...result.events);
      operations.push({ ...operation, result: result.receipt });
      return result;
    };

    await speakStep("create");
    createReport();
    await speakStep("steer");
    const left = await act({ action: "leave_and_return" });
    expect(left.receipt).toMatchObject({ performed: true, status: "returned" });
    const revised = await act({ action: "section_revision", instruction: FREE_TEXT[3], sections: ["intro"] });
    expect(revised.receipt).toMatchObject({ performed: true, status: "admitted", http_status: 202, task_id: ids.edit, design_state_at_return: "published" });
    const stale = await act({ action: "stale_edit" });
    expect(stale.receipt).toMatchObject({ performed: true, status: "refused", http_status: 409, code: "stale_revision" });
    for (const [step, phase, state] of [["hold", "held", "running"], ["resume", "running", "running"], ["stop", "stopped", "cancelled"]] as const) {
      await speakStep(step);
      setPhase(ids.research, phase, state);
      expect((await act({ action: "observe", for_step: step })).receipt).toMatchObject({ performed: false, status: "observed" });
    }
    const withdrawn = await act({ action: "withdrawal" });
    expect(withdrawn.receipt).toMatchObject({ performed: true, status: "committed", entry_id: ids.note, http_status: 202 });
    expect(api.withdrawals).toHaveLength(1);
    expect(api.withdrawals[0]).toMatchObject({ idempotencyKey: expect.stringMatching(/^voice-lab-g7:/), previewToken: PREVIEW_PROOF });

    api.onEnd = () => {
      push("provider", providerReceipt(run, seq++, "closed"));
      push("session_closed", sessionClosed(run, seq++, { windows: 5, turns: 5, replies: 5 }));
    };
    const ended = await driver.end(run, "unused", "unused");
    collected.push(...ended.events);
    operations.push({ ...speakOperation(run, new Date(Date.now() + 100)), type: "end", input: {}, result: {} });
    expect(driver.hasSession(run.id)).toBe(false);
    expect(api.exchangeId).toBeNull();
    // End is requested only as the id-bound API End of the proven exchange, never by the room UI.
    expect(ended.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: true, basis: "api_end", ownership: "proven", verified_by: "member_snapshot" });
    expect(ended.events.filter((event) => event.kind === "studio.exchange.end_requested").map((event) => event.payload.basis)).toEqual(["api_end"]);
    expect(api.ended).toEqual([EXCHANGE_UUID]);
    expect(ended.events.find((event) => event.kind === "studio.cleanup.signed_out")?.payload).toMatchObject({ confirmed: true, scope: "global" });
    expect(ended.events.find((event) => event.kind === "cleanup.browser_context_closed")?.payload).toMatchObject({ close_resolved: true, browser_process_close_resolved: true });

    // Canonical outcomes: downloaded bytes hashed and compared with the declared digests.
    const outcomes = collected.filter((event) => event.kind === "studio.outcome.observed");
    const finalOutcome = outcomes.find((event) => event.payload.purpose === "final")!;
    const artifacts = finalOutcome.payload.artifacts as Array<Record<string, unknown>>;
    expect(artifacts.map((artifact) => [artifact.version_id, artifact.status, artifact.downloaded_sha256])).toEqual(expect.arrayContaining([
      [ids.v1, "verified", createHash("sha256").update(html1).digest("hex")],
      [ids.v2, "verified", createHash("sha256").update(html2).digest("hex")],
    ]));
    expect(finalOutcome.payload.join).toMatchObject({ status: "uncertain", missing_product_field: "NativeTask.exchangeId" });

    // Nothing secret or free-text is durable: no password, JWT, refresh token, preview proof, signed URL, instruction, Markdown, title or note words.
    const serialized = JSON.stringify(collected);
    for (const forbidden of [FAKE_PASSWORD, "fake-access-token-", "fake-refresh-", PREVIEW_PROOF, "fakesignature", "River otters report", "River otters.html", "free text limitation", ...FREE_TEXT]) expect(serialized, forbidden).not.toContain(forbidden);

    const events: LabEvent[] = [
      ...operations.filter((operation) => operation.type === "speak").map((operation) => ({ kind: "utterance.resolved", source: "worker" as const, payload: { operation_id: operation.id, wav: { sha256: sha256(wav.toString("base64")), duration_ms: 800 } }, dedupeKey: null })),
      ...collected,
      { kind: "cleanup.browser_lease_released", source: "worker" as const, payload: { cas_deleted: true }, dedupeKey: null },
    ].map((event, index) => ({ ...event, runId: run.id, seq: index + 1, at: new Date(), dedupeKey: event.dedupeKey ?? null }));
    const evaluation = evaluateStudioG7Run(run, events, operations, { expected: { studio: STUDIO_SHA, api: API_SHA, bridge: BRIDGE_SHA } });
    const withheld = evaluation.harness.filter((assertion) => assertion.status !== "pass").map((assertion) => `${assertion.id}:${assertion.status}:${assertion.reason}`);
    expect(withheld).toEqual([]);
    expect(Object.fromEntries(evaluation.steps.map((step) => [step.step_id, `${step.executed}/${step.outcome}`]))).toEqual({
      "g7.create": "pass/uncertain", "g7.steer": "pass/uncertain", "g7.leave_return": "pass/pass", "g7.section_revision": "pass/pass", "g7.stale_edit": "pass/pass",
      "g7.hold": "pass/uncertain", "g7.resume": "pass/uncertain", "g7.stop": "pass/uncertain", "g7.withdrawal": "pass/pass",
    });
    expect(deriveStudioG7Verdicts(evaluation, { sessionEstablished: true })).toEqual({ harness: "pass", product: "inconclusive", provider: "pass", auth: "pass", evidence: "pass" });
  }, 180_000);

  it("never touches an exchange whose evidence names another run, nor one held by another principal", async () => {
    const foreign = harness();
    api.evidenceMode = "foreign";
    const error = await foreign.driver.start(foreign.run, "unused").catch((caught: unknown) => caught) as { detail?: Record<string, unknown> };
    expect(error.detail).toMatchObject({ code: "STUDIO_EXCHANGE_OWNERSHIP_MISMATCH", category: "harness" });
    const aborted = await foreign.driver.abort(foreign.run, "STUDIO_EXCHANGE_OWNERSHIP_MISMATCH");
    expect(api.exchangeId).toBe(EXCHANGE_UUID);
    expect(api.calls).not.toContain(`POST /api/v1/exchanges/${EXCHANGE_UUID}/end`);
    expect(aborted.events.filter((event) => event.kind === "studio.exchange.end_requested")).toHaveLength(0);
    expect(aborted.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: false, status: "uncertain", ownership: "mismatch" });
    expect(aborted.events.find((event) => event.kind === "cleanup.browser_context_closed")?.payload).toMatchObject({ close_resolved: true });

    const other = harness();
    api.inputActorId = OTHER_PRINCIPAL;
    const wrong = await other.driver.start(other.run, "unused").catch((caught: unknown) => caught) as { detail?: Record<string, unknown> };
    expect(wrong.detail).toMatchObject({ code: "STUDIO_EXCHANGE_NOT_PRINCIPALS" });
    const cleaned = await other.driver.abort(other.run, "STUDIO_EXCHANGE_NOT_PRINCIPALS");
    expect(api.exchangeId).toBe(EXCHANGE_UUID);
    expect(api.calls).not.toContain(`POST /api/v1/exchanges/${EXCHANGE_UUID}/end`);
    expect(cleaned.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: false, status: "uncertain", basis: "live_exchange_not_joined_to_run" });
  }, 120_000);

  it("without the evidence route, End never touches the exchange; recovery confirms it only once it is no longer live", async () => {
    const { driver, run } = harness();
    api.evidenceMode = "missing";
    const started = await driver.start(run, "unused");
    expect(started.events.find((event) => event.kind === "studio.exchange.ownership")?.payload).toMatchObject({ status: "unavailable", reason: "evidence_not_answered_to_principal" });
    const ended = await driver.end(run, "unused", "unused");
    expect(api.exchangeId).toBe(EXCHANGE_UUID);
    expect(api.calls).not.toContain(`POST /api/v1/exchanges/${EXCHANGE_UUID}/end`);
    expect(ended.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: false, status: "unavailable", basis: "ownership_unproven_not_touched" });
    expect(ended.events.find((event) => event.kind === "studio.cleanup.signed_out")?.payload).toMatchObject({ confirmed: true });
    expect(driver.hasSession(run.id)).toBe(false);
    // The product guard ends the exchange at its deadline; recovery proves it read-only.
    api.exchangeId = null;
    const recovered = await driver.recover({ id: run.id, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId } as never, "unused");
    expect(recovered.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: true, basis: "run_exchange_not_live" });
    expect(recovered.events.find((event) => event.kind === "studio.cleanup.recovery")?.payload).toMatchObject({ complete: true });
  }, 120_000);

  it("withdraws only a note bound to the run's own, ownership-proven exchange", async () => {
    const { driver, run } = harness();
    await driver.start(run, "unused");
    createReport();
    const foreignNote = { ...api.mission[0]!, exchangeId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
    api.mission = [foreignNote];
    const foreign = await driver.studioAction(run, randomUUID(), { action: "withdrawal", entry_id: ids.note });
    expect(foreign.receipt).toMatchObject({ performed: false, status: "unavailable", reason: "entry_not_bound_to_run_exchange" });
    api.mission = [{ ...foreignNote, exchangeId: EXCHANGE_UUID, actorId: OTHER_PRINCIPAL }];
    expect((await driver.studioAction(run, randomUUID(), { action: "withdrawal" })).receipt).toMatchObject({ performed: false, reason: "no_note_bound_to_run_exchange" });
    // Without proven ownership of the exchange nothing is withdrawn at all.
    api.mission = [{ ...foreignNote, exchangeId: EXCHANGE_UUID }];
    api.evidenceMode = "missing";
    const unproven = await driver.studioAction(run, randomUUID(), { action: "withdrawal" });
    expect(unproven.receipt).toMatchObject({ performed: false, reason: "exchange_ownership_unproven" });
    expect(api.withdrawals).toHaveLength(0);
    expect(api.calls.filter((call) => call.startsWith("POST") && call.includes("/withdrawal"))).toHaveLength(0);
    // A stale edit with no superseded version is typed, never sent.
    api.evidenceMode = "ok";
    expect((await driver.studioAction(run, randomUUID(), { action: "stale_edit" })).receipt).toMatchObject({ performed: false, reason: "no_superseded_version" });
    expect(api.calls.filter((call) => call.endsWith("/html-edits"))).toHaveLength(0);
    await driver.end(run, "unused", "unused");
  }, 120_000);

  it("types a rejected password as an auth failure and still proves the browser closed", async () => {
    const { config } = harness({ SOPHIA_VOICE_LAB_STUDIO_PRINCIPAL_PASSWORD: "wrong-fake-password-0002" });
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

  it("abort ends an ownership-proven exchange through the API and signs out when the browser process is dead", async () => {
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
    expect(aborted.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: true, basis: "api_end", exchange_id: EXCHANGE_UUID, ownership: "proven" });
    expect(aborted.events.find((event) => event.kind === "studio.cleanup.signed_out")?.payload).toMatchObject({ confirmed: true, scope: "global" });
    expect(aborted.events.find((event) => event.kind === "cleanup.browser_context_closed")?.payload).toMatchObject({ close_resolved: true, process_exited_before_close: true });
    expect(aborted.events.some((event) => event.kind === "cleanup.capture_unavailable")).toBe(true);
    expect(driver.hasSession(run.id)).toBe(false);
  }, 90_000);

  it("ends only the proven exchange by id: another member's exchange that replaced it after the proof is never ended", async () => {
    const { driver, run } = harness();
    const started = await driver.start(run, "unused");
    expect(started.events.find((event) => event.kind === "studio.exchange.ownership")?.payload).toMatchObject({ status: "proven" });
    // Right after End's ownership proof (the second evidence read of end():
    // the final drain reads it first), the guard ends the run's exchange and
    // another member opens a new one in the same room.
    let reads = 0;
    api.onEvidence = () => { reads += 1; if (reads === 2) { api.exchangeId = OTHER_EXCHANGE; api.inputActorId = OTHER_PRINCIPAL; } };
    const ended = await driver.end(run, "unused", "unused");
    expect(api.exchangeId).toBe(OTHER_EXCHANGE);
    expect(api.ended).not.toContain(OTHER_EXCHANGE);
    expect(api.ended.every((id) => id === EXCHANGE_UUID)).toBe(true);
    expect(ended.events.filter((event) => event.kind === "studio.exchange.end_requested").map((event) => event.payload.basis)).not.toContain("ui_end");
    expect(ended.events.find((event) => event.kind === "studio.exchange.ownership")?.payload).toMatchObject({ status: "proven", exchange_id: EXCHANGE_UUID });
    expect(ended.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: true, exchange_id: EXCHANGE_UUID });
  }, 120_000);

  it("a watchdog during the grant gate never counts as the end of the exchange Speak opens later, nor releases the owner's lease (P3-7)", async () => {
    const { driver, run } = harness();
    page.micDelayMs = 2_500;
    api.evidenceMode = "missing";
    const batches: DriverEvent[][] = [];
    const starting = driver.start(run, "unused", undefined, undefined, acquisitionRecorder(batches) as never, async (events) => { batches.push(events); });
    const deadline = Date.now() + 60_000;
    while (!(page.serves > 0 && driver.hasSession(run.id) && driver.exchangeJoin(run.id)?.speakRequested === false) && Date.now() < deadline) await sleep(25);
    await sleep(800);
    const fired = await driver.fireWatchdog(run.id);
    // True at that moment: Speak was not requested yet.
    expect(fired.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: true, basis: "no_exchange_opened_by_run" });
    const started = await starting;
    expect(api.exchangeId).toBe(EXCHANGE_UUID);
    // Ownership is unprovable (no evidence route): the exchange stays live; the browser closes and the principal signs out.
    const aborted = await driver.abort(run, "TEST_ABORT");
    expect(api.exchangeId).toBe(EXCHANGE_UUID);
    const events = ledgerOrder(run.id, [...batches, started.events, aborted.events]);
    const stale = events.find((event) => event.kind === "studio.cleanup.exchange_ended" && event.payload.basis === "no_exchange_opened_by_run")!;
    expect(stale.seq).toBeGreaterThan(events.find((event) => event.kind === "studio.exchange.opened")!.seq);
    expect(studioG7CleanupProof(events)).toMatchObject({ exchangeEnded: false, signedOut: true, browserClosed: true, complete: false });
    expect(ownerCleanupForLease(events, OWNER)).toMatchObject({ complete: false, reason: "owner_exchange_end_not_confirmed" });
  }, 120_000);

  it("an exchange that opens after start gave up is never confirmed ended while live; only a read after the principal left with nothing live confirms it (P3-7)", async () => {
    const { driver, run } = harness({}, { exchangeOpenMs: 2_000, exchangeOpenWindowMs: 6_000 });
    api.openDelayMs = 3_500;
    const batches: DriverEvent[][] = [];
    const error = await driver.start(run, "unused", undefined, undefined, acquisitionRecorder(batches) as never, async (events) => { batches.push(events); }).catch((caught: unknown) => caught) as { detail?: Record<string, unknown> };
    expect(error.detail).toMatchObject({ code: "STUDIO_EXCHANGE_NOT_OPENED" });
    const speakAt = Date.now();
    const aborted = await driver.abort(run, "STUDIO_EXCHANGE_NOT_OPENED");
    expect(aborted.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: false, status: "uncertain" });
    const opened = Date.now() + 15_000;
    while (api.exchangeId === null && Date.now() < opened) await sleep(50);
    expect(api.exchangeId).toBe(EXCHANGE_UUID);
    await sleep(Math.max(0, speakAt + 6_500 - Date.now()));
    // After the window, but the exchange is live: still never confirmed.
    const binding = { id: run.id, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId } as never;
    const live = await driver.recover(binding, "unused");
    expect(live.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: false });
    let events = ledgerOrder(run.id, [...batches, aborted.events, live.events]);
    expect(studioG7CleanupProof(events)).toMatchObject({ exchangeEnded: false, complete: false });
    expect(ownerCleanupForLease(events, OWNER)).toMatchObject({ complete: false, reason: "owner_exchange_end_not_confirmed" });
    // The product guard ends it; a read-only observation after the window with nothing live confirms.
    api.exchangeId = null;
    const after = await driver.recover(binding, "unused");
    expect(after.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: true, basis: "no_live_exchange_after_principal_left", verified_by: "member_snapshot", browser_closed_before_observation: true, signed_out_before_observation: true });
    events = ledgerOrder(run.id, [...batches, aborted.events, live.events, after.events]);
    expect(studioG7CleanupProof(events).exchangeEnded).toBe(true);
  }, 120_000);

  it("E3: an exchange that opens later than any open window is never reported ended by the abort that preceded it (third review)", async () => {
    // A 20 s-style floor: the earlier rule confirmed "ended" once exchangeOpenMs had passed.
    const { driver, run } = harness({}, { exchangeOpenMs: 2_000, exchangeOpenWindowMs: 1 });
    api.openDelayMs = 5_000;
    const batches: DriverEvent[][] = [];
    const error = await driver.start(run, "unused", undefined, undefined, acquisitionRecorder(batches) as never, async (events) => { batches.push(events); }).catch((caught: unknown) => caught) as { detail?: Record<string, unknown> };
    expect(error.detail).toMatchObject({ code: "STUDIO_EXCHANGE_NOT_OPENED" });
    const aborted = await driver.abort(run, "STUDIO_EXCHANGE_NOT_OPENED");
    // The abort's read precedes its own browser close and sign-out: never a confirmation.
    expect(aborted.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: false, status: "uncertain", browser_closed_before_observation: false });
    const deadline = Date.now() + 15_000;
    while (api.exchangeId === null && Date.now() < deadline) await sleep(50);
    expect(api.exchangeId).toBe(EXCHANGE_UUID);
    const events = ledgerOrder(run.id, [...batches, aborted.events]);
    expect(studioG7CleanupProof(events)).toMatchObject({ exchangeEnded: false, complete: false });
    expect(ownerCleanupForLease(events, OWNER)).toMatchObject({ complete: false });
  }, 120_000);

  it("fails start closed when the product issues an access-JWT lifetime above 24 h, before any browser holds it (P3-6)", async () => {
    const { driver, run } = harness();
    tokens.expiresIn = 1_000_000_000_000;
    const durable: DriverEvent[] = [];
    const error = await driver.start(run, "unused", undefined, undefined, undefined, async (events) => { durable.push(...events); }).catch((caught: unknown) => caught) as { detail?: Record<string, unknown> };
    expect(error.detail).toMatchObject({ code: "STUDIO_AUTH_TOKEN_LIFETIME_UNBOUNDED", details: { expires_in_s: 1_000_000_000_000, max_expires_in_s: 86_400, issued_session_revoked: true } });
    expect(page.serves).toBe(0);
    expect(tokens.logouts).toEqual(["local"]);
    expect(durable.some((event) => event.kind === "studio.auth.session_established")).toBe(false);
    const aborted = await driver.abort(run, "STUDIO_AUTH_TOKEN_LIFETIME_UNBOUNDED");
    expect(aborted.events.find((event) => event.kind === "cleanup.browser_context_closed")?.payload).toMatchObject({ close_resolved: true });
  }, 60_000);

  it("makes the issued access-JWT lifetime durable before the browser is seeded with the session (P3-6)", async () => {
    const { driver, run } = harness();
    const batches: DriverEvent[][] = [];
    const error = await driver.start(run, "unused", undefined, undefined, undefined, async (events) => { batches.push(events); throw new Error("ledger unavailable"); }).catch((caught: unknown) => caught);
    expect(error).toBeTruthy();
    expect(batches[0]?.find((event) => event.kind === "studio.auth.session_established")?.payload).toMatchObject({ expires_in_s: 3_600 });
    // The durable write failed, so the session was never seeded: the room page was never loaded.
    expect(page.serves).toBe(0);
    await driver.abort(run, "LEDGER_UNAVAILABLE");
  }, 60_000);

  it("revokes only the evidence-refresh session end to end; a failed local revoke leaves cleanup incomplete and never signs out globally (P3-5 follow-up)", async () => {
    const { config, driver, run } = harness();
    const batches: DriverEvent[][] = [];
    const started = await driver.start(run, "unused", undefined, undefined, acquisitionRecorder(batches) as never, async (events) => { batches.push(events); });
    const ended = await driver.end(run, "unused", "unused");
    expect(api.exchangeId).toBeNull();
    // A later run of the same principal is live now.
    const later = await passwordGrant({ supabaseUrl: config.studioG7!.supabaseUrl, publishableKey: FAKE_PUBLISHABLE_KEY }, { email: FAKE_EMAIL, password: FAKE_PASSWORD });
    tokens.logouts.length = 0;
    const join = { exchangeId: EXCHANGE_UUID, grantId: page.grantId, runBindingSha256: bindingOf(run), speakRequested: true, exchangeOpenedAtMs: null };
    const refreshed = await driver.refreshStudioEvidence(run, join);
    expect(tokens.logouts).toEqual(["local"]);
    expect(refreshed.find((event) => event.kind === "studio.evidence.session_revoked")?.payload).toMatchObject({ scope: "local", confirmed: true });
    expect(tokens.revoked.has(later.accessToken)).toBe(false);
    // The local revoke keeps failing: retried with backoff, never replaced by a global sign-out.
    tokens.logouts.length = 0;
    tokens.failLocal = 3;
    const failed = await driver.refreshStudioEvidence(run, join);
    expect(tokens.logouts).toEqual(["local", "local", "local"]);
    expect(failed.find((event) => event.kind === "studio.evidence.session_revoked")?.payload).toMatchObject({ scope: "local", confirmed: false, status: "unrevoked", attempts: 3 });
    expect(tokens.revoked.has(later.accessToken)).toBe(false);
    const events = ledgerOrder(run.id, [...batches, started.events, ended.events, refreshed, failed]);
    expect(studioG7CleanupProof(events)).toMatchObject({ exchangeEnded: true, signedOut: true, refreshSessionsRevoked: false, complete: false });
  }, 120_000);

  it("a run-deadline watchdog firing while Speak is still opening the exchange never confirms it ended", async () => {
    const { driver, run } = harness();
    api.openDelayMs = 3_000;
    const starting = driver.start(run, "unused");
    const deadline = Date.now() + 60_000;
    while (!(driver.exchangeJoin(run.id)?.speakRequested === true && driver.exchangeJoin(run.id)?.exchangeId === null && api.calls.includes(`POST /test/projects/${PROJECT_UUID}/exchanges`)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(api.exchangeId).toBeNull();
    const fired = await driver.fireWatchdog(run.id);
    expect(fired.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: false, status: "uncertain" });
    await starting;
    expect(api.exchangeId).toBe(EXCHANGE_UUID);
    await driver.end(run, "unused", "unused");
    expect(api.exchangeId).toBeNull();
  }, 120_000);
});
