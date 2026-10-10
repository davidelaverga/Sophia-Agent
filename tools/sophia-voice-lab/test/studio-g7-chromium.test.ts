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
import { STUDIO_G7_NOTE_TEXT, StudioG7Driver, type StudioDriverDependencies } from "../src/studio-g7/studio-driver.js";
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
/** The product's revoke reason (sophia.design_revoke_source, 0041_design_lifecycle.sql), verbatim. */
const REVOKED = "revoked: a source the report drew on was withdrawn";
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
    exchangeId: null as string | null, inputActorId: PRINCIPAL_UUID, evidenceMode: "ok" as "ok" | "missing" | "foreign" | "route_absent",
    receipts: [] as Row[], calls: [] as string[], grant: null as Record<string, unknown> | null, onEnd: null as (() => void) | null,
    onEvidence: null as (() => void) | null, openDelayMs: 0, ended: [] as string[], openTimer: null as ReturnType<typeof setTimeout> | null,
    work: [] as Array<Record<string, unknown>>, tasks: new Map<string, Record<string, unknown>>(), versions: new Map<string, Array<Record<string, unknown>>>(),
    contents: new Map<string, Buffer>(), mission: [] as Array<Record<string, unknown>>, edits: new Map<string, { status: number; body: unknown }>(), withdrawals: [] as unknown[],
    /** The room as the bridge last saw it (A15 RoomLivePresence, without roomId); null: no report yet. */
    presence: null as Record<string, unknown> | null,
    /** The principal's own voice calls in the exchange, as the service recorded them (A15 ExchangeCalls); _began is when recording began on the read clock. */
    exchangeCalls: [] as Array<Record<string, unknown>>,
    callsClock: 0,
    callsStamps: new Map<string, number>(),
    onCallsRead: null as (() => void) | null,
    /** Every html-edit request as sent (the version and sections it targets). */
    editRequests: [] as Array<{ versionId: string; sections: string[] }>,
    /** Runs as a native task is read, before it is answered (a chain that changes between reads). */
    onTaskRead: null as ((taskId: string) => void) | null,
    /** Mission decisions (MissionDecision): proposals and decisions, each resting on `supportingEntryIds`. */
    decisions: [] as Array<Record<string, unknown>>,
    /** record_note requests as sent (idempotency key and the note's kind; never its words), and their replayable answers. */
    noteRequests: [] as Array<{ idempotencyKey: unknown; kind: string; epistemic: string }>,
    noteAnswers: new Map<string, { status: number; body: unknown }>(),
    /** Each task's consumed closure (its manifest's source dependencies), which the product keeps apart from inputSourceIds. */
    closures: new Map<string, string[]>(),
    /** Runs as a withdrawal preview is read (GET), before its cascade is computed: a decision that changes before the preview. */
    onWithdrawalPreview: null as (() => void) | null,
    /** Runs as a withdrawal is posted, before the product's staleness check: a change after the preview. */
    onWithdrawalPost: null as (() => void) | null,
    /** Runs as the mission is read, with the number of mission reads so far. */
    onMissionRead: null as ((reads: number) => void) | null,
    missionReads: 0,
  };
  const ROOM_UUID = "70000000-0000-4000-8000-0000000000a7";
  const tokens = { issued: new Set<string>(), revoked: new Set<string>(), expiresIn: 3_600, failLocal: 0, logouts: [] as string[] };
  let origins = { studio: "", api: "", supabase: "", store: "" };

  const ids = { goal: randomUUID(), research: randomUUID(), design: randomUUID(), edit: randomUUID(), artifact: randomUUID(), v1: randomUUID(), v2: randomUUID(), html1: randomUUID(), html2: randomUUID(), md: randomUUID(), note: randomUUID(), decision: randomUUID(),
    /** The run's own note's source S (its record_note receipt names it). */
    noteSource: randomUUID(),
    /** The Stop sub-episode: its own research on its own goal. */
    stopGoal: randomUUID(), stopResearch: randomUUID() };
  const html1 = Buffer.from("<!doctype html><section id=intro>Otters</section>");
  const html2 = Buffer.from("<!doctype html><section id=intro>Otters, briefly</section>");

  function nativeTask(id: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, kind, goalId: randomUUID(), attemptId: randomUUID(), commandId: randomUUID(), actorId: PRINCIPAL_UUID, state: "running", phase: "running", createdAt: new Date().toISOString(), contextSourceId: randomUUID(), inputSourceIds: [], resultSourceId: null, reason: null, ...extra };
  }
  function version(id: string, htmlSource: string, html: Buffer, parentId: string | null): Record<string, unknown> {
    return { id, artifactId: ids.artifact, projectId: PROJECT_UUID, parentId, sourceId: ids.md, sourceHash: sha256("markdown"), state: "stable", previewId: null, format: "markdown", exportEditability: "source_editable", title: "River otters report", versionNumber: parentId ? 2 : 1, limitations: ["free text limitation"], renditions: [{ format: "html", sourceId: htmlSource, sha256: createHash("sha256").update(html).digest("hex"), byteLength: html.byteLength, mime: "text/html", pageCount: null }] };
  }
  /**
   * The product's reaction to the create utterance: a research task handing
   * its HTML to a published design. The research task was created by the
   * exchange's voice tool call, so it names the exchange (A15); the design
   * task, created by the service from the handoff, does not.
   */
  function createReport(): void {
    const research = nativeTask(ids.research, "research", { exchangeId: EXCHANGE_UUID, goalId: ids.goal });
    const design = nativeTask(ids.design, "design", { state: "succeeded", phase: "result_ready", artifactId: ids.artifact });
    api.work = [research, design];
    api.tasks.set(ids.research, { task: research, instruction: FREE_TEXT[0], result: { markdown: FREE_TEXT[1], sourceId: ids.md, sha256: sha256("markdown"), outputs: [] }, research: { question: FREE_TEXT[0], specialist: "x", outputs: [], rootTaskId: ids.research, capUsd: 1, committedUsd: 0, spentUsd: 0, searches: {}, reads: {}, html: { state: "published", designTaskId: ids.design } } });
    api.tasks.set(ids.design, { task: design, instruction: FREE_TEXT[0], result: null, design: { researchTaskId: ids.research, artifactId: ids.artifact, baseVersionId: ids.v1, state: "published", targets: [], revisions: 0, renders: 1, candidates: [], maxRepairs: 2, publishedVersionId: ids.v1, mode: "create", sections: ["intro", "findings"] } });
    api.versions.set(ids.artifact, [version(ids.v1, ids.html1, html1, null)]);
    api.contents.set(ids.html1, html1);
    api.mission = [{ id: ids.note, kind: "observation", epistemic: "reported", state: "current", text: FREE_TEXT[2], textKind: "member_text", authoredBy: "member", actorId: PRINCIPAL_UUID, origin: "voice", exchangeId: EXCHANGE_UUID, inputEpoch: 1, supersedesEntryId: null, sourceId: randomUUID() }];
    // The run's own decision resting on the note: proposed and accepted by the principal by voice.
    api.decisions = [missionDecision(ids.decision, { revision: 2, state: "accepted", supportingEntryIds: [ids.note], decidedBy: PRINCIPAL_UUID })];
  }
  /** A MissionDecision as the product lists it (its words are free text the Lab drops). */
  function missionDecision(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, revision: 1, kind: "constraint", state: "proposed", statement: FREE_TEXT[2], purpose: null, destination: null, origin: null, textKind: "member_text", proposedBy: PRINCIPAL_UUID, proposedVia: "voice", createdAt: new Date().toISOString(), baseMissionRevision: null, stale: false, supersedesDecisionId: null, supportingEntryIds: [], decidedBy: null, decidedAt: null, decidedVia: null, sourceId: randomUUID(), sha256: "e".repeat(64), ...extra };
  }
  /**
   * What forgetting a note reaches, as the product computes it
   * (mission_forget_reach): every version of the note from the first one the
   * principal authored on, and every decision resting on one of them.
   */
  function forgetReach(entryId: string): { entries: Array<Record<string, unknown>>; decisions: Array<Record<string, unknown>> } {
    const byId = new Map(api.mission.map((entry) => [String(entry.id), entry]));
    const chain: Array<Record<string, unknown>> = [];
    for (let at: Record<string, unknown> | undefined = byId.get(entryId); at; at = typeof at.supersedesEntryId === "string" ? byId.get(at.supersedesEntryId) : undefined) chain.unshift(at);
    for (let at = api.mission.find((entry) => entry.supersedesEntryId === entryId); at; at = api.mission.find((entry) => entry.supersedesEntryId === at!.id)) chain.push(at);
    const first = Math.max(0, chain.findIndex((entry) => entry.actorId === PRINCIPAL_UUID));
    const reach = chain.slice(first).filter((entry) => entry.state !== "withdrawn");
    const ids = new Set(reach.map((entry) => String(entry.id)));
    return { entries: reach, decisions: api.decisions.filter((decision) => decision.state !== "withdrawn" && (decision.supportingEntryIds as string[]).some((id) => ids.has(id))) };
  }
  function setPhase(taskId: string, phase: string, state = "running", reason: string | null = null): void {
    api.work = api.work.map((task) => task.id === taskId ? { ...task, phase, state, reason } : task);
    const detail = api.tasks.get(taskId)!;
    api.tasks.set(taskId, { ...detail, task: { ...(detail.task as Record<string, unknown>), phase, state, reason } });
  }
  function setDesign(taskId: string, change: Record<string, unknown>): void {
    const detail = api.tasks.get(taskId)!;
    api.tasks.set(taskId, { ...detail, design: { ...(detail.design as Record<string, unknown>), ...change } });
  }
  /** A report version without a page (the research's Markdown, version 1). */
  function markdownVersion(id: string): Record<string, unknown> {
    return { id, artifactId: ids.artifact, projectId: PROJECT_UUID, parentId: null, sourceId: ids.md, sourceHash: sha256("markdown"), state: "stable", previewId: null, format: "markdown", exportEditability: "source_editable", title: "River otters report", versionNumber: 1, limitations: [], renditions: [] };
  }
  /**
   * The product's lifecycle (R2, apps/api/src/voice-episode.db.test.ts): the
   * research R the create's voice call made (bound to the exchange) drew on
   * the run's own note's source S and reads result_ready; its report is
   * version 1 (Markdown, no page); the design D it handed the page to is
   * under way (create, designing) on the same goal, bound to no exchange.
   * As the product: S is in R's manifest's dependency graph (the closure a
   * withdrawal reaches, `api.closures`), never in NativeTask.inputSourceIds,
   * which native_task_view (0022) builds from discussion contributions only.
   * Every research and design detail serves withdrawnSourceIds (computed
   * live), [] until a source it drew on is withdrawn.
   */
  function lifecycleReport(noteSource: string): void {
    const research = nativeTask(ids.research, "research", { state: "succeeded", phase: "result_ready", exchangeId: EXCHANGE_UUID, goalId: ids.goal, inputSourceIds: [] });
    api.closures.set(ids.research, [noteSource]);
    const design = nativeTask(ids.design, "design", { goalId: ids.goal, artifactId: ids.artifact });
    api.work = [research, design];
    api.tasks.set(ids.research, { task: research, instruction: FREE_TEXT[0], result: { markdown: FREE_TEXT[1], sourceId: ids.md, sha256: sha256("markdown"), outputs: [] }, research: { question: FREE_TEXT[0], specialist: "x", outputs: [], rootTaskId: ids.research, capUsd: 1, committedUsd: 0, spentUsd: 0, searches: {}, reads: {}, html: { state: "designing", designTaskId: ids.design } }, withdrawnSourceIds: [] });
    api.tasks.set(ids.design, { task: design, instruction: FREE_TEXT[0], result: null, design: { researchTaskId: ids.research, artifactId: ids.artifact, baseVersionId: ids.v1, state: "designing", targets: [], revisions: 0, renders: 0, candidates: [], maxRepairs: 2, mode: "create", sections: ["intro", "findings"] }, withdrawnSourceIds: [] });
    api.versions.set(ids.artifact, [markdownVersion(ids.v1)]);
  }
  /** D publishes its page: version 2 (the page) over version 1; D's job succeeds and the goal completes. */
  function publishDesign(): void {
    setPhase(ids.design, "result_ready", "succeeded");
    setDesign(ids.design, { state: "published", renders: 1, publishedVersionId: ids.v2 });
    const research = api.tasks.get(ids.research)!;
    api.tasks.set(ids.research, { ...research, research: { ...(research.research as Record<string, unknown>), html: { state: "published", designTaskId: ids.design } } });
    api.versions.set(ids.artifact, [version(ids.v2, ids.html1, html1, ids.v1), markdownVersion(ids.v1)]);
    api.contents.set(ids.html1, html1);
  }
  /** The Lab's admitted edit X publishes its revision: a new version (with its page) of the same artifact. */
  function publishEdit(): string {
    const versions = api.versions.get(ids.artifact) ?? [];
    const published = versions.some((listed) => listed.id === ids.v2) ? randomUUID() : ids.v2;
    setPhase(ids.edit, "result_ready", "succeeded");
    setDesign(ids.edit, { state: "published", renders: 1, publishedVersionId: published });
    api.versions.set(ids.artifact, [version(published, ids.html2, html2, String(versions[0]?.id ?? ids.v1)), ...versions]);
    api.contents.set(ids.html2, html2);
    return published;
  }
  /** The Stop sub-episode's research: a second voice create on its own goal, pending (queued, goal ready). */
  function stopTarget(): void {
    const pending = nativeTask(ids.stopResearch, "research", { state: "pending", phase: "queued", exchangeId: EXCHANGE_UUID, goalId: ids.stopGoal });
    api.work = [...api.work, pending];
    api.tasks.set(ids.stopResearch, { task: pending, instruction: FREE_TEXT[0], result: null, research: { question: FREE_TEXT[0], specialist: "x", outputs: [], rootTaskId: ids.stopResearch, capUsd: 1, committedUsd: 0, spentUsd: 0, searches: {}, reads: {}, html: { state: "none", designTaskId: null } }, withdrawnSourceIds: [] });
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
      // Exactly as the product answers: a domain error is `{code, message, retry, requestId}`
      // (`not_found` is HTTP 422), and Fastify answers an absent route with its own 404.
      const productError = (status: number, code: string, message: string) => json(status, { code, message, retry: "never", requestId: randomUUID() });
      const routeNotFound = () => json(404, { message: `Route ${request.method}:${url.pathname} not found`, error: "Not Found", statusCode: 404 });
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
        json(200, { projectId: PROJECT_UUID, title: "Synthetic", room: { id: ROOM_UUID, revision: 1, inputActorId: api.exchangeId ? api.inputActorId : null, mode: "invoked", sophia: { exchangeId: api.exchangeId, exchange: api.exchangeId ? "open" : "none", inputEpoch: 1, inputActorId: api.exchangeId ? api.inputActorId : null } }, work: api.work });
        return;
      }
      if (request.method === "GET" && path === `/api/v1/exchanges/${EXCHANGE_UUID}/qualification-evidence`) {
        // SOPHIA_VOICE_QUALIFICATION off: the route is absent and Fastify answers its own 404.
        if (api.evidenceMode === "route_absent") { routeNotFound(); return; }
        // Not the grant's principal, or no grant covers the exchange: the domain error not_found (HTTP 422, A15).
        if (api.evidenceMode === "missing" || !api.grant) { productError(422, "not_found", "Qualification evidence not found"); return; }
        const grant = api.evidenceMode === "foreign" ? { ...api.grant, runBindingSha256: "e".repeat(64) } : api.grant;
        json(200, { exchangeId: EXCHANGE_UUID, state: api.exchangeId === EXCHANGE_UUID ? "open" : "ended", grant, receipts: api.evidenceMode === "foreign" ? [] : [...api.receipts].sort((left, right) => left.source === right.source ? left.seq - right.seq : left.source < right.source ? -1 : 1) });
        // Product changes that land right after this answer (e.g. the guard ends the exchange).
        api.onEvidence?.();
        return;
      }
      const callsMatch = /^\/api\/v1\/exchanges\/([0-9a-f-]{36})\/calls$/.exec(path);
      if (request.method === "GET" && callsMatch) {
        if (api.evidenceMode === "route_absent") { routeNotFound(); return; }
        if (callsMatch[1] !== EXCHANGE_UUID) { productError(422, "not_found", "Exchange not found"); return; }
        // readAt on a logical read clock; after lists only calls whose recording began after that read.
        api.onCallsRead?.();
        api.callsClock += 1;
        const readAt = new Date(Date.UTC(2026, 9, 9, 12, 0, 0) + api.callsClock * 1_000).toISOString();
        api.callsStamps.set(readAt, api.callsClock);
        const after = url.searchParams.get("after");
        const since = after === null ? null : api.callsStamps.get(after) ?? Number.POSITIVE_INFINITY;
        json(200, { exchangeId: EXCHANGE_UUID, readAt, calls: api.exchangeCalls.filter((entry) => since === null || Number(entry._began) > since).map(({ _began: _ignored, ...entry }) => entry) });
        return;
      }
      const presenceMatch = /^\/api\/v1\/rooms\/([0-9a-f-]{36})\/live-presence$/.exec(path);
      if (request.method === "GET" && presenceMatch) {
        if (api.evidenceMode === "route_absent") { routeNotFound(); return; }
        if (presenceMatch[1] !== ROOM_UUID) { productError(422, "not_found", "Room not found"); return; }
        json(200, { roomId: ROOM_UUID, ...(api.presence ?? { observed: false, reportedAt: null, fresh: false, voice: null, exchangeId: null, selfPresent: false, participants: 0, guests: 0, emptySince: null }) });
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
      if (request.method === "GET" && taskMatch) { api.onTaskRead?.(taskMatch[1]!); const detail = api.tasks.get(taskMatch[1]!); if (detail) json(200, detail); else productError(422, "not_found", "Task not found"); return; }
      const versionsMatch = /^\/api\/v1\/artifacts\/([0-9a-f-]{36})\/versions$/.exec(path);
      if (request.method === "GET" && versionsMatch) { json(200, api.versions.get(versionsMatch[1]!) ?? []); return; }
      const sourceMatch = /^\/api\/v1\/sources\/([0-9a-f-]{36})\/content$/.exec(path);
      if (request.method === "GET" && sourceMatch) {
        const bytes = api.contents.get(sourceMatch[1]!);
        if (!bytes) { productError(422, "not_found", "Source not found"); return; }
        json(200, { sourceId: sourceMatch[1], sha256: createHash("sha256").update(bytes).digest("hex"), mime: "text/html", byteLength: bytes.byteLength, filename: "River otters.html", disposition: "inline", downloadUrl: `${origins.store}/obj/${sourceMatch[1]}?${SIGNATURE}`, expiresAt: new Date(Date.now() + 60_000).toISOString() });
        return;
      }
      if (request.method === "POST" && path === `/api/v1/projects/${PROJECT_UUID}/mission/entries`) {
        // record_note (MissionEntryRequest -> MissionReceipt, 202): a member's note through the member route
        // (origin studio, no exchange); the receipt names the entry and the note's source.
        const key = String(request.headers["idempotency-key"] ?? "");
        const prior = api.noteAnswers.get(key);
        if (prior) { json(prior.status, prior.body); return; }
        const parsed = JSON.parse(body) as { kind: string; epistemic: string; text: string };
        api.noteRequests.push({ idempotencyKey: request.headers["idempotency-key"], kind: parsed.kind, epistemic: parsed.epistemic });
        const first = !api.mission.some((entry) => entry.id === ids.note);
        const entryId = first ? ids.note : randomUUID();
        const sourceId = first ? ids.noteSource : randomUUID();
        api.mission = [...api.mission, { id: entryId, kind: parsed.kind, epistemic: parsed.epistemic, state: "current", text: parsed.text, textKind: "member_text", authoredBy: "member", actorId: PRINCIPAL_UUID, origin: "studio", exchangeId: null, inputEpoch: null, supersedesEntryId: null, goalId: null, sourceId }];
        const answer = { status: 202, body: { status: "committed", operation: "record_note", projectId: PROJECT_UUID, entryId, decisionId: null, decisionRevision: null, decision: null, sourceId, sha256: sha256(parsed.text), affected: [], ledgerRevision: 4, missionRevision: 1, eligibilityRevision: 1, cursor: "11" } };
        api.noteAnswers.set(key, answer);
        json(answer.status, answer.body);
        return;
      }
      if (request.method === "GET" && path === `/api/v1/projects/${PROJECT_UUID}/mission`) {
        api.missionReads += 1;
        api.onMissionRead?.(api.missionReads);
        json(200, { projectId: PROJECT_UUID, entries: api.mission.filter((entry) => entry.state === "current"), history: api.mission.filter((entry) => entry.state !== "current"),
          constraints: api.decisions.filter((decision) => decision.state === "accepted"), pending: api.decisions.filter((decision) => decision.state === "proposed"), decided: api.decisions.filter((decision) => decision.state === "rejected") });
        return;
      }
      const withdrawalMatch = new RegExp(`^/api/v1/projects/${PROJECT_UUID}/mission/entries/([0-9a-f-]{36})/withdrawal$`).exec(path);
      if (withdrawalMatch) {
        if (request.method === "GET") api.onWithdrawalPreview?.();
        else api.onWithdrawalPost?.();
        const entryId = withdrawalMatch[1]!;
        const note = api.mission.find((entry) => entry.id === entryId);
        if (!note || note.state === "withdrawn" || note.actorId !== PRINCIPAL_UUID) { productError(422, "not_found", "Note not found"); return; }
        // The cascade as the product previews it: every version of the note, and every decision resting on one of them.
        const reach = forgetReach(entryId);
        const previewEntries = reach.entries.map((entry) => ({ id: entry.id, state: entry.state, text: entry.text }));
        const previewDecisions = reach.decisions.map((decision) => ({ id: decision.id, kind: decision.kind, state: decision.state, revision: decision.revision, statement: decision.statement, purpose: decision.purpose, destination: decision.destination, origin: decision.origin }));
        if (request.method === "GET") { json(200, { entryId, ledgerRevision: 4, previewToken: PREVIEW_PROOF, expiresAt: new Date(Date.now() + 900_000).toISOString(), entries: previewEntries, decisions: previewDecisions }); return; }
        const parsed = JSON.parse(body) as { previewToken: string; expectedAffected: { entryIds: string[]; decisions: Array<{ id: string; revision: number }> } };
        api.withdrawals.push({ idempotencyKey: request.headers["idempotency-key"], ...parsed });
        if (parsed.previewToken !== PREVIEW_PROOF || JSON.stringify(parsed.expectedAffected) !== JSON.stringify({ entryIds: previewEntries.map((entry) => entry.id), decisions: previewDecisions.map((decision) => ({ id: decision.id, revision: decision.revision })) })) { json(409, { code: "stale_revision", message: FREE_TEXT[4] }); return; }
        const reached = new Set([...previewEntries.map((entry) => String(entry.id)), ...previewDecisions.map((decision) => String(decision.id))]);
        api.mission = api.mission.map((entry) => reached.has(String(entry.id)) ? { ...entry, state: "withdrawn", text: null } : entry);
        api.decisions = api.decisions.map((decision) => reached.has(String(decision.id)) ? { ...decision, state: "withdrawn" } : decision);
        // As the product (0041 design_revoke_source, R2 withdrawnSourceIds): every research that drew on a
        // forgotten source, and every design of its report, lists that source (computed live); a design still
        // under way that drew on it is revoked (failed, the revoke reason); a published or ended one is not touched.
        const forgotten = new Set(reach.entries.map((entry) => String(entry.sourceId)));
        // The closure (the manifest's source_dependencies), never NativeTask.inputSourceIds.
        const drew = (taskId: unknown) => (api.closures.get(String(taskId)) ?? []).filter((id) => forgotten.has(id));
        for (const [taskId, detail] of [...api.tasks.entries()]) {
          const design = detail.design as Record<string, unknown> | undefined;
          const listed = [...new Set([...drew(taskId), ...(design ? drew(design.researchTaskId) : [])])];
          if (listed.length === 0) continue;
          let next: Record<string, unknown> = { ...detail, withdrawnSourceIds: [...new Set([...((detail.withdrawnSourceIds as string[] | undefined) ?? []), ...listed])] };
          if (design && (design.state === "designing" || design.state === "reviewing")) {
            next = { ...next, task: { ...(detail.task as Record<string, unknown>), state: "failed", phase: "failed", reason: REVOKED }, design: { ...design, state: "failed", reason: REVOKED } };
            api.work = api.work.map((task) => task.id === taskId ? { ...task, state: "failed", phase: "failed", reason: REVOKED } : task);
          }
          api.tasks.set(taskId, next);
        }
        json(202, { status: "committed", operation: "withdraw_note", projectId: PROJECT_UUID, entryId, decisionId: null, decisionRevision: null, decision: null, sourceId: note.sourceId ?? null, sha256: null, affected: [...reached], ledgerRevision: 5, missionRevision: 2, eligibilityRevision: 2, cursor: "12" });
        return;
      }
      if (request.method === "POST" && path === `/api/v1/projects/${PROJECT_UUID}/html-edits`) {
        const key = String(request.headers["idempotency-key"] ?? "");
        const parsed = JSON.parse(body) as { versionId: string; sections: string[]; instruction: string };
        api.editRequests.push({ versionId: parsed.versionId, sections: parsed.sections });
        const prior = api.edits.get(key);
        if (prior) { json(prior.status, prior.body); return; }
        const versions = api.versions.get(ids.artifact) ?? [];
        const refuse = (status: number, code: string, message: string) => { const answer = { status, body: { code, message, requestId: randomUUID(), retry: "reconcile_first" } }; api.edits.set(key, answer); json(answer.status, answer.body); };
        // As the product: staleness is checked before anything else (so the stale probe is refused even while an edit is live).
        if (parsed.versionId !== versions[0]?.id) { refuse(409, "stale_revision", FREE_TEXT[4]!); return; }
        // No designed page on the current version yet: nothing is started (the product raises 22023, mapped to 422 invalid_request).
        if (!((versions[0]!.renditions as Array<Record<string, unknown>>) ?? []).some((rendition) => rendition.format === "html")) { refuse(422, "invalid_request", "That report has no designed HTML page to revise."); return; }
        // One design of a page at a time.
        if ([...api.tasks.values()].some((detail) => { const design = detail.design as Record<string, unknown> | undefined; return design?.artifactId === ids.artifact && (design.state === "designing" || design.state === "reviewing"); })) { refuse(409, "invalid_state", "A design of this page is under way."); return; }
        // The edit X: admitted, designing on the run's goal, the same research and artifact; it does not publish by itself.
        const edit = nativeTask(ids.edit, "design", { goalId: ids.goal, artifactId: ids.artifact });
        api.work = [...api.work, edit];
        api.tasks.set(ids.edit, { task: edit, instruction: parsed.instruction, result: null, design: { researchTaskId: ids.research, artifactId: ids.artifact, baseVersionId: parsed.versionId, state: "designing", targets: [], revisions: 1, renders: 0, candidates: [], maxRepairs: 2, mode: "edit", sections: parsed.sections }, withdrawnSourceIds: [] });
        const answer = { status: 202, body: { taskId: ids.edit, state: "designing", versionId: parsed.versionId, baseCandidateId: randomUUID(), sections: parsed.sections, shell: false, styles: false, contributionId: randomUUID() } };
        api.edits.set(key, answer);
        json(answer.status, answer.body);
        return;
      }
      routeNotFound();
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

  function harness(overrides: NodeJS.ProcessEnv = {}, timeouts: NonNullable<StudioDriverDependencies["timeouts"]> = {}) {
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
      timeouts: { micArrivalGraceMs: 3_000, exchangeEndMs: 8_000, sessionClosedMs: 5_000, uiActionMs: 3_000, designSettleMs: 5_000, callsSettleWaitMs: 10, ...timeouts },
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
    api.presence = null;
    api.exchangeCalls = [];
    api.callsClock = 0;
    api.callsStamps.clear();
    api.onCallsRead = null;
    api.editRequests.length = 0;
    api.onTaskRead = null;
    api.decisions = [];
    api.noteRequests.length = 0;
    api.noteAnswers.clear();
    api.closures.clear();
    api.onWithdrawalPreview = null;
    api.onWithdrawalPost = null;
    api.onMissionRead = null;
    api.missionReads = 0;
    return { config, driver, run };
  }

  const audioOf = (wav: Buffer): ResolvedAudio => ({ id: "sine", sha256: createHash("sha256").update(wav).digest("hex"), sampleRate: 16_000, channels: 1, durationMs: 800, bytes: wav, source: "fixture", synthesis: { engine: "fixture", engine_version: "1", voice: "none", rate: "none" } });

  it("performs the whole G7 episode in the order the product supports, reads canonical outcomes, passes every product assertion, and cleans up only what it owns", async () => {
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
    // The product records the principal's voice tool call as the step is spoken (A15 ExchangeCalls).
    const recordCall = (tool: string, kind: string | null, taskId: string | null = null, goalId = ids.goal) => {
      const callSeq = api.exchangeCalls.length + 1;
      const at = new Date().toISOString();
      api.exchangeCalls.push({ _began: api.callsClock + 0.5, seq: callSeq, recordedAt: at, inputEpoch: 1, tool, answeredAt: at, outcome: kind === null ? "ok" : kind === "native_task" ? "admitted" : "ok", taskId, command: kind === null ? null : { commandId: randomUUID(), kind, goalId, authorityEpoch: callSeq, goalRevision: 1, state: "acknowledged", createdAt: at } });
    };
    const speakStep = async (step: string, calls: () => void = () => undefined) => {
      const operation = speakOperation(run, new Date(Date.now() + operations.length), { input: { fixture_id: "sine", _g7_step: `g7.${step}` } });
      operations.push(operation);
      // As the worker does: the step's calls baseline before it acts, then its own calls (after = that readAt) once it settled.
      const baseline = await driver.readStudioCalls(run, "baseline", operation.id, `g7.${step}`);
      collected.push(baseline);
      collected.push(...(await driver.schedule(run, operation.id, randomUUID(), audioOf(wav), 0)).events);
      const callsBefore = api.exchangeCalls.length;
      calls();
      // The provider showed the step's calls while its input window was open (the bridge's toolCallCount).
      const shown = api.exchangeCalls.length - callsBefore;
      const ownCalls = () => driver.readStudioCalls(run, "after", operation.id, `g7.${step}`, String(baseline.payload.read_at));
      const deadline = Date.now() + 15_000;
      while (!collected.some((event) => event.kind === "audio.input.completed" && event.payload.operation_id === operation.id) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        collected.push(...await driver.drain(run.id));
      }
      const ordinal = operations.filter((candidate) => candidate.type === "speak").length;
      push("input_window", inputWindow(run, seq++, ordinal, 800));
      push("input_turn", inputTurn(run, seq++, ordinal, { toolCallCount: shown }));
      push("output_reply", outputReply(run, seq++, ordinal, Date.now()));
      collected.push(await ownCalls());
    };
    const act = async (input: Record<string, unknown>) => {
      const operation: OperationRecord = { ...speakOperation(run, new Date(Date.now() + operations.length)), type: "studio_action", input, result: null };
      // As the worker does: the run's certified create task (the create step's /calls certification).
      const result = await driver.studioAction(run, operation.id, { ...input, _own_create_task_id: ids.research });
      collected.push(...result.events);
      operations.push({ ...operation, result: result.receipt });
      return result;
    };
    const decoys = { other: randomUUID(), none: randomUUID() };
    const mirror = (phase: string, state: string) => { for (const id of [decoys.other, decoys.none]) setPhase(id, phase, state); };

    // 1. The run's own note N, through the member route: its receipt names the entry and the note's source S.
    const noted = await act({ action: "record_note" });
    expect(noted.receipt).toMatchObject({ performed: true, status: "committed", http_status: 202, entry_id: ids.note, source_id: ids.noteSource });
    expect(api.noteRequests).toEqual([{ idempotencyKey: expect.stringMatching(/^voice-lab-g7:/), kind: "observation", epistemic: "reported" }]);
    // 2. Create by voice: the research R draws on S; its design D is under way on the same goal.
    await speakStep("create", () => { recordCall("start_research", "native_task", ids.research); lifecycleReport(ids.noteSource); });
    // Decoys in the time window, by the principal: one created by another
    // exchange's voice call, one with no exchange (a typed command, or voice
    // qualification off). Both mirror every step's phase; neither is ever bound.
    for (const [id, exchangeId] of [[decoys.other, OTHER_EXCHANGE], [decoys.none, null]] as const) {
      const decoy = nativeTask(id, "research", exchangeId === null ? {} : { exchangeId });
      api.work = [...api.work, decoy];
      api.tasks.set(id, { task: decoy, instruction: FREE_TEXT[0], result: null, research: { question: FREE_TEXT[0], specialist: "x", outputs: [], rootTaskId: id, capUsd: 1, committedUsd: 0, spentUsd: 0, searches: {}, reads: {}, html: { state: "none", designTaskId: null } } });
    }
    // 3. Steer while R/D are live; leave and return.
    await speakStep("steer", () => { recordCall("project_status", null); recordCall("control_work", "steer"); });
    const left = await act({ action: "leave_and_return" });
    expect(left.receipt).toMatchObject({ performed: true, status: "returned" });
    // 4. Hold, then resume, by voice, while D is under way: the goal holds D (held), then runs it again.
    for (const [step, phase] of [["hold", "held"], ["resume", "running"]] as const) {
      await speakStep(step, () => recordCall("control_work", step));
      setPhase(ids.design, phase);
      mirror(phase, "running");
      expect((await act({ action: "observe", for_step: step })).receipt).toMatchObject({ performed: false, status: "observed" });
    }
    // 5. D publishes its page (version 2 over the report's version 1); its goal completes.
    publishDesign();
    // 6. The section revision over HTTP: the Lab's own edit X, admitted on the current version, left under way.
    const revised = await act({ action: "section_revision", instruction: FREE_TEXT[3], sections: ["intro"] });
    expect(revised.receipt).toMatchObject({ performed: true, status: "admitted", http_status: 202, task_id: ids.edit, design_state_at_return: "designing" });
    expect(api.editRequests).toEqual([{ versionId: ids.v2, sections: ["intro"] }]);
    // 7. The stale probe: the superseded version 1, refused 409 stale_revision (the product checks staleness first).
    const stale = await act({ action: "stale_edit" });
    expect(stale.receipt).toMatchObject({ performed: true, status: "refused", http_status: 409, code: "stale_revision" });
    expect(api.editRequests.at(-1)).toMatchObject({ versionId: ids.v1 });
    // 8. The run's own note N withdrawn while X is live: X is revoked, listing S; R and D list S and are not ended.
    const withdrawn = await act({ action: "withdrawal" });
    expect(withdrawn.receipt).toMatchObject({ performed: true, status: "committed", entry_id: ids.note, http_status: 202 });
    expect(api.withdrawals).toEqual([expect.objectContaining({ idempotencyKey: expect.stringMatching(/^voice-lab-g7:/), previewToken: PREVIEW_PROOF, expectedAffected: { entryIds: [ids.note], decisions: [] } })]);
    expect(withdrawn.events.find((event) => event.kind === "studio.action.withdrawal")?.payload).toMatchObject({ entry_id: ids.note, own_note_entry_id: ids.note, own_note_source_id: ids.noteSource, entry_source_id: ids.noteSource, receipt_source_id: ids.noteSource, own_live_task_ids: [ids.edit] });
    // 9. The Stop sub-episode: a second voice create (its own research, on its own goal, pending), then Stop on it.
    await speakStep("create_stop_target", () => { recordCall("start_research", "native_task", ids.stopResearch, ids.stopGoal); stopTarget(); });
    expect((await act({ action: "observe", for_step: "create_stop_target" })).receipt).toMatchObject({ performed: false, status: "observed" });
    await speakStep("stop", () => recordCall("control_work", "stop", null, ids.stopGoal));
    setPhase(ids.stopResearch, "stopped", "cancelled", "stopped");
    mirror("stopped", "cancelled");
    expect((await act({ action: "observe", for_step: "stop" })).receipt).toMatchObject({ performed: false, status: "observed" });

    api.onEnd = () => {
      push("provider", providerReceipt(run, seq++, "closed"));
      push("session_closed", sessionClosed(run, seq++, { windows: 6, turns: 6, replies: 6 }));
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

    // Canonical outcomes: the own design's page, its downloaded bytes hashed and compared with the declared digests (X never published).
    const outcomes = collected.filter((event) => event.kind === "studio.outcome.observed");
    const finalOutcome = outcomes.find((event) => event.payload.purpose === "final")!;
    const artifacts = finalOutcome.payload.artifacts as Array<Record<string, unknown>>;
    expect(artifacts.map((artifact) => [artifact.task_id, artifact.version_id, artifact.status, artifact.downloaded_sha256])).toEqual([[ids.design, ids.v2, "verified", createHash("sha256").update(html1).digest("hex")]]);
    // Bound only by the exchange id the product recorded for the voice call that created the task.
    expect(finalOutcome.payload.join).toMatchObject({ basis: "native_task_exchange_id", run_exchange_id: EXCHANGE_UUID, bound_task_ids: expect.arrayContaining([ids.research, ids.stopResearch]), other_exchange_task_count: 1 });
    const finalTasks = finalOutcome.payload.tasks as Array<Record<string, unknown>>;
    expect(finalTasks.find((item) => item.task_id === decoys.other)).toMatchObject({ exchange_id: OTHER_EXCHANGE });
    expect(finalTasks.find((item) => item.task_id === decoys.none)).toMatchObject({ exchange_id: null });
    expect(finalTasks.find((item) => item.task_id === ids.edit)).toMatchObject({ state: "failed", withdrawn_source_ids: [ids.noteSource], design: { state: "failed", mode: "edit", reason_class: "revoked_source_withdrawn" } });
    // As the product serves R: S only in withdrawnSourceIds, never in inputSourceIds (contributions only).
    expect(finalTasks.find((item) => item.task_id === ids.research)).toMatchObject({ phase: "result_ready", input_source_ids: [], withdrawn_source_ids: [ids.noteSource] });
    expect(finalTasks.find((item) => item.task_id === ids.design)).toMatchObject({ design: { state: "published" } });
    expect(finalTasks.find((item) => item.task_id === ids.stopResearch)).toMatchObject({ state: "cancelled", phase: "stopped", reason_class: "stopped", withdrawn_source_ids: [] });

    // Nothing secret or free-text is durable: no password, JWT, refresh token, preview proof, signed URL, instruction, Markdown, title, note words or reason text.
    const serialized = JSON.stringify(collected);
    for (const forbidden of [FAKE_PASSWORD, "fake-access-token-", "fake-refresh-", PREVIEW_PROOF, "fakesignature", "River otters report", "River otters.html", "free text limitation", STUDIO_G7_NOTE_TEXT, REVOKED, ...FREE_TEXT]) expect(serialized, forbidden).not.toContain(forbidden);

    const events: LabEvent[] = [
      ...operations.filter((operation) => operation.type === "speak").map((operation) => ({ kind: "utterance.resolved", source: "worker" as const, payload: { operation_id: operation.id, wav: { sha256: sha256(wav.toString("base64")), duration_ms: 800 } }, dedupeKey: null })),
      ...collected,
      { kind: "cleanup.browser_lease_released", source: "worker" as const, payload: { cas_deleted: true }, dedupeKey: null },
    ].map((event, index) => ({ ...event, runId: run.id, seq: index + 1, at: new Date(), dedupeKey: event.dedupeKey ?? null }));
    const evaluation = evaluateStudioG7Run(run, events, operations, { expected: { studio: STUDIO_SHA, api: API_SHA, bridge: BRIDGE_SHA } });
    const withheld = evaluation.harness.filter((assertion) => assertion.status !== "pass").map((assertion) => `${assertion.id}:${assertion.status}:${assertion.reason}`);
    expect(withheld).toEqual([]);
    expect(Object.fromEntries(evaluation.steps.map((step) => [step.step_id, `${step.executed}/${step.outcome}`]))).toEqual({
      "g7.record_note": "pass/pass", "g7.create": "pass/pass", "g7.steer": "pass/pass", "g7.leave_return": "pass/pass", "g7.hold": "pass/pass", "g7.resume": "pass/pass",
      "g7.section_revision": "pass/pass", "g7.stale_edit": "pass/pass", "g7.withdrawal": "pass/pass", "g7.create_stop_target": "pass/pass", "g7.stop": "pass/pass",
    });
    expect(evaluation.outcome.voice_steps.map((step) => [step.step_id, step.command_kind, step.candidate_seqs])).toEqual([
      ["g7.create", "native_task", [1]], ["g7.steer", "steer", [2, 3]], ["g7.hold", "hold", [4]], ["g7.resume", "resume", [5]], ["g7.create_stop_target", "native_task", [6]], ["g7.stop", "stop", [7]],
    ]);
    // Every assertion passes, design_ended on S and the sub-episode's independent Stop included.
    expect(evaluation.product.filter((assertion) => assertion.status !== "pass").map((assertion) => `${assertion.id}:${assertion.status}:${assertion.reason}`)).toEqual([]);
    expect(evaluation.product.find((assertion) => assertion.id === "step.g7.withdrawal.design_ended")).toMatchObject({ status: "pass" });
    expect(evaluation.product.find((assertion) => assertion.id === "step.g7.stop.outcome")).toMatchObject({ status: "pass" });
    expect(deriveStudioG7Verdicts(evaluation, { sessionEstablished: true })).toEqual({ harness: "pass", product: "pass", provider: "pass", auth: "pass", evidence: "pass" });
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

  it("when the evidence is not answered to the principal (422 not_found), End never touches the exchange; recovery confirms it only once it is no longer live", async () => {
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

  it("against a product whose evidence route is absent (404: voice qualification off), a run never requests End and the absent route proves nothing", async () => {
    const { driver, run } = harness();
    api.evidenceMode = "route_absent";
    const batches: DriverEvent[][] = [];
    const started = await driver.start(run, "unused", undefined, undefined, acquisitionRecorder(batches) as never, async (events) => { batches.push(events); });
    // Unavailable, never "not yours" and never a mismatch.
    expect(started.events.find((event) => event.kind === "studio.exchange.ownership")?.payload).toMatchObject({ status: "unavailable", reason: "evidence_endpoint_not_served" });
    const ended = await driver.end(run, "unused", "unused");
    expect(api.exchangeId).toBe(EXCHANGE_UUID);
    expect(ended.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: false, status: "unavailable", basis: "ownership_unproven_not_touched", ownership: "unavailable", reason: "evidence_endpoint_not_served" });
    expect(ended.events.find((event) => event.kind === "studio.cleanup.signed_out")?.payload).toMatchObject({ confirmed: true });
    // Recovery while the exchange is still live and the route still absent: still nothing is ended.
    const binding = { id: run.id, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId } as never;
    const live = await driver.recover(binding, "unused");
    expect(live.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: false, reason: "evidence_endpoint_not_served" });
    let events = ledgerOrder(run.id, [...batches, started.events, ended.events, live.events]);
    const unavailable = events.filter((event) => event.kind === "studio.bridge_evidence_unavailable");
    expect(unavailable.length).toBeGreaterThan(0);
    expect(unavailable.every((event) => event.payload.reason === "endpoint_not_served" && event.payload.http_status === 404)).toBe(true);
    expect(events.filter((event) => event.kind === "studio.exchange.end_requested")).toHaveLength(0);
    expect(events.some((event) => event.kind === "studio.exchange.ownership" && event.payload.status !== "unavailable")).toBe(false);
    expect(studioG7CleanupProof(events)).toMatchObject({ exchangeEnded: false, complete: false });
    expect(ownerCleanupForLease(events, OWNER)).toMatchObject({ complete: false });
    // The product guard ends it; only a read that sees it no longer live confirms the end, read-only.
    api.exchangeId = null;
    const after = await driver.recover(binding, "unused");
    expect(after.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: true, basis: "run_exchange_not_live" });
    events = ledgerOrder(run.id, [...batches, started.events, ended.events, live.events, after.events]);
    expect(studioG7CleanupProof(events).exchangeEnded).toBe(true);
    expect(api.calls.filter((call) => call.startsWith("POST") && call.endsWith("/end"))).toHaveLength(0);
    expect(api.ended).toHaveLength(0);
    // The live-presence route is absent too: room presence is unobservable, never "gone".
    const presence = events.filter((event) => event.kind === "studio.room.live_presence");
    expect(presence.length).toBeGreaterThan(0);
    expect(presence.every((event) => event.payload.status === "unobservable" && event.payload.reason === "endpoint_not_served" && event.payload.http_status === 404)).toBe(true);
  }, 120_000);

  it("re-reads the exchange's calls with the run's session until every listed call is answered, and types a read that never settles", async () => {
    const { driver, run } = harness();
    await driver.start(run, "unused");
    const at = new Date().toISOString();
    const unanswered = { _began: 0.5, seq: 1, recordedAt: at, inputEpoch: 1, tool: "control_work", answeredAt: null, outcome: null, taskId: null, command: null };
    api.exchangeCalls = [unanswered];
    let reads = 0;
    api.onCallsRead = () => { reads += 1; if (reads === 2) api.exchangeCalls = [{ ...unanswered, answeredAt: at, outcome: "refused" }]; };
    const settled = await driver.readStudioCalls(run, "baseline", "op-settle", "g7.hold");
    expect(settled.payload).toMatchObject({ status: "available", settled: true, attempts: 2, read_at: expect.any(String) });
    expect((settled.payload.calls as Array<Record<string, unknown>>)[0]).toMatchObject({ answered_at: at, outcome: "refused", command: null });
    // A call recorded after the baseline that is never answered: the step's read stays unsettled after the bounded re-reads.
    api.onCallsRead = null;
    api.exchangeCalls = [{ ...unanswered, _began: api.callsClock + 0.5, seq: 2 }];
    const never = await driver.readStudioCalls(run, "after", "op-settle", "g7.hold", String(settled.payload.read_at));
    expect(never.payload).toMatchObject({ status: "available", settled: false, attempts: 10, after: settled.payload.read_at });
    await driver.end(run, "unused", "unused");
  }, 120_000);

  it("withdraws only the run's own note: a named note neither recorded by the run nor bound to its ownership-proven exchange is refused", async () => {
    const { driver, run } = harness();
    await driver.start(run, "unused");
    createReport();
    const foreignNote = { ...api.mission[0]!, exchangeId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
    api.mission = [foreignNote];
    const foreign = await driver.studioAction(run, randomUUID(), { action: "withdrawal", entry_id: ids.note });
    expect(foreign.receipt).toMatchObject({ performed: false, status: "unavailable", reason: "entry_not_own_note" });
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
    expect((await driver.studioAction(run, randomUUID(), { action: "stale_edit", _own_create_task_id: ids.research })).receipt).toMatchObject({ performed: false, reason: "no_superseded_version" });
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
    const { driver, run } = harness({}, { exchangeOpenMs: 2_000 });
    api.openDelayMs = 3_500;
    const batches: DriverEvent[][] = [];
    const error = await driver.start(run, "unused", undefined, undefined, acquisitionRecorder(batches) as never, async (events) => { batches.push(events); }).catch((caught: unknown) => caught) as { detail?: Record<string, unknown> };
    expect(error.detail).toMatchObject({ code: "STUDIO_EXCHANGE_NOT_OPENED" });
    const aborted = await driver.abort(run, "STUDIO_EXCHANGE_NOT_OPENED");
    expect(aborted.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: false, status: "uncertain" });
    const opened = Date.now() + 15_000;
    while (api.exchangeId === null && Date.now() < opened) await sleep(50);
    expect(api.exchangeId).toBe(EXCHANGE_UUID);
    // The principal has left, but the exchange is live: never confirmed.
    const binding = { id: run.id, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId } as never;
    const live = await driver.recover(binding, "unused");
    expect(live.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: false });
    let events = ledgerOrder(run.id, [...batches, aborted.events, live.events]);
    expect(studioG7CleanupProof(events)).toMatchObject({ exchangeEnded: false, complete: false });
    expect(ownerCleanupForLease(events, OWNER)).toMatchObject({ complete: false, reason: "owner_exchange_end_not_confirmed" });
    // The product guard ends it; a read-only observation after the principal left (browser closed, global sign-out) with nothing live confirms.
    api.exchangeId = null;
    const after = await driver.recover(binding, "unused");
    expect(after.events.find((event) => event.kind === "studio.cleanup.exchange_ended")?.payload).toMatchObject({ confirmed: true, basis: "no_live_exchange_after_principal_left", verified_by: "member_snapshot", browser_closed_before_observation: true, signed_out_before_observation: true });
    events = ledgerOrder(run.id, [...batches, aborted.events, live.events, after.events]);
    expect(studioG7CleanupProof(events).exchangeEnded).toBe(true);
  }, 120_000);

  it("E3: an exchange that opens after the start gave up is never reported ended by the abort that preceded it (third review)", async () => {
    // The exchange opens 5 s after Speak, long after the start's 2 s open timeout.
    const { driver, run } = harness({}, { exchangeOpenMs: 2_000 });
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
  // ------------------------------------------------------------------ delta 4
  // The run's report is resolved only through the product's own chain: the
  // certified create task (bound to the run's exchange) -> its research's
  // designTaskId -> that design (naming the research back) -> its artifact and
  // published version. A design in the window or by the principal is never a
  // fallback, and it is never verified or edited.

  /** Root's exact scenario: the run's own research is still pending with no design; the only published design belongs to OTHER_EXCHANGE's research. */
  function rootScenario(): { pendingId: string } {
    createReport();
    const detail = api.tasks.get(ids.research)!;
    const foreign = { ...(detail.task as Record<string, unknown>), exchangeId: OTHER_EXCHANGE };
    api.tasks.set(ids.research, { ...detail, task: foreign });
    api.work = api.work.map((task) => task.id === ids.research ? foreign : task);
    const pendingId = randomUUID();
    const pending = nativeTask(pendingId, "research", { exchangeId: EXCHANGE_UUID, goalId: randomUUID() });
    api.work.push(pending);
    api.tasks.set(pendingId, { task: pending, instruction: "Own research still pending", result: null, research: { outputs: [], rootTaskId: pendingId, html: { state: "none", designTaskId: null } } });
    return { pendingId };
  }

  /** A second version of the report artifact (so a stale edit has a superseded version to send). */
  function supersede(): void {
    api.versions.set(ids.artifact, [version(ids.v2, ids.html2, html2, ids.v1), version(ids.v1, ids.html1, html1, null)]);
    api.contents.set(ids.html2, html2);
  }

  /** Another exchange's research and its published design, newer, by the principal, in the run's window: its own artifact and versions. */
  function foreignReport(): { research: string; design: string; artifact: string; v1: string; v2: string; html: string } {
    const f = { research: randomUUID(), design: randomUUID(), artifact: randomUUID(), v1: randomUUID(), v2: randomUUID(), html: randomUUID() };
    const later = new Date(Date.now() + 1_000).toISOString();
    const research = nativeTask(f.research, "research", { exchangeId: OTHER_EXCHANGE, createdAt: later });
    const design = nativeTask(f.design, "design", { state: "succeeded", phase: "result_ready", artifactId: f.artifact, createdAt: later });
    api.work = [design, research, ...api.work];
    api.tasks.set(f.research, { task: research, instruction: FREE_TEXT[0], result: null, research: { outputs: [], rootTaskId: f.research, html: { state: "published", designTaskId: f.design } } });
    api.tasks.set(f.design, { task: design, instruction: FREE_TEXT[0], result: null, design: { researchTaskId: f.research, artifactId: f.artifact, baseVersionId: f.v1, state: "published", targets: [], revisions: 0, renders: 1, candidates: [], maxRepairs: 2, publishedVersionId: f.v2, mode: "create", sections: ["intro"] } });
    api.versions.set(f.artifact, [{ ...version(f.v2, f.html, html2, f.v1), artifactId: f.artifact }, { ...version(f.v1, f.html, html1, null), artifactId: f.artifact }]);
    api.contents.set(f.html, html2);
    return f;
  }

  const postedEdits = () => api.calls.filter((call) => call.startsWith("POST") && call.endsWith("/html-edits"));
  const observedArtifacts = (events: DriverEvent[]) => events.filter((event) => event.kind === "studio.outcome.observed").flatMap((event) => event.payload.artifacts as Array<Record<string, unknown>>);

  for (const action of ["section_revision", "stale_edit"] as const) {
    it(`delta 4 (${action}): root's scenario — the own research is pending and the sole recent design is another exchange's — performs nothing`, async () => {
      const { driver, run } = harness();
      await driver.start(run, "unused");
      const { pendingId } = rootScenario();
      if (action === "stale_edit") supersede();
      const input = action === "section_revision" ? { action, instruction: "Shorten the introduction", sections: ["intro"] } : { action };
      const acted = await driver.studioAction(run, randomUUID(), { ...input, _own_create_task_id: pendingId });
      expect({ receipt: acted.receipt, edits: api.edits.size }).toMatchObject({ receipt: { performed: false, status: "unavailable", reason: "own_design_pending" }, edits: 0 });
      expect(postedEdits()).toEqual([]);
      expect(acted.events.find((event) => event.kind === "studio.action.html_edit")?.payload).toMatchObject({ requested: false, status: "unavailable", reason: "own_design_pending", target_join: "canonical_chain", own_create_task_id: pendingId });
      // The foreign design is never verified either: its bytes are never downloaded.
      expect(observedArtifacts(acted.events)).toEqual([]);
      expect(acted.events.find((event) => event.kind === "studio.outcome.observed")?.payload.own_report).toMatchObject({ status: "unavailable", reason: "own_design_pending", create_task_id: pendingId });
      // A create task bound to another exchange is never the run's own; nor is one the worker did not certify.
      const foreignRoot = await driver.studioAction(run, randomUUID(), { ...input, _own_create_task_id: ids.research });
      expect(foreignRoot.receipt).toMatchObject({ performed: false, status: "uncertain", reason: "target_not_canonical" });
      const uncertified = await driver.studioAction(run, randomUUID(), { ...input, _own_create_task_id: null });
      expect(uncertified.receipt).toMatchObject({ performed: false, status: "unavailable", reason: "create_step_not_certified" });
      // An own research whose design names another research back: not the run's report.
      api.tasks.set(pendingId, { ...api.tasks.get(pendingId)!, research: { outputs: [], rootTaskId: pendingId, html: { state: "published", designTaskId: ids.design } } });
      const misLinked = await driver.studioAction(run, randomUUID(), { ...input, _own_create_task_id: pendingId });
      expect(misLinked.receipt).toMatchObject({ performed: false, status: "uncertain", reason: "target_not_canonical" });
      expect(api.edits.size).toBe(0);
      expect(postedEdits()).toEqual([]);
      const ended = await driver.end(run, "unused", "unused");
      expect(observedArtifacts(ended.events)).toEqual([]);
      expect(api.calls.filter((call) => call.includes(`/sources/${ids.html1}/`) || call.includes(`/sources/${ids.html2}/`))).toEqual([]);
    }, 120_000);
  }

  it("delta 4: own-positive control — the run's own create -> research -> published design: the revision and the stale edit land on that design's artifact only", async () => {
    const { driver, run } = harness();
    await driver.start(run, "unused");
    createReport();
    const revised = await driver.studioAction(run, randomUUID(), { action: "section_revision", instruction: "Shorten the introduction", sections: ["intro"], _own_create_task_id: ids.research });
    expect(revised.receipt).toMatchObject({ performed: true, status: "admitted", http_status: 202, task_id: ids.edit });
    expect(api.editRequests).toEqual([{ versionId: ids.v1, sections: ["intro"] }]);
    expect(revised.events.find((event) => event.kind === "studio.action.html_edit")?.payload).toMatchObject({ requested: true, target_join: "canonical_chain", own_create_task_id: ids.research, design_task_id: ids.design, artifact_id: ids.artifact, version_id: ids.v1 });
    // Its outcome verifies the own design's published version; the Lab's own edit X is under way (it publishes nothing yet).
    expect(observedArtifacts(revised.events).map((artifact) => [artifact.task_id, artifact.version_id, artifact.status])).toEqual([[ids.design, ids.v1, "verified"]]);
    // X publishes its revision; the outcome then verifies it too, and v1 is superseded.
    publishEdit();
    const observed = await driver.studioAction(run, randomUUID(), { action: "observe", for_step: "create", _own_create_task_id: ids.research });
    expect(observedArtifacts(observed.events).map((artifact) => [artifact.task_id, artifact.version_id, artifact.status])).toEqual([[ids.design, ids.v1, "verified"], [ids.edit, ids.v2, "verified"]]);
    const stale = await driver.studioAction(run, randomUUID(), { action: "stale_edit", _own_create_task_id: ids.research });
    expect(stale.receipt).toMatchObject({ performed: true, status: "refused", http_status: 409, code: "stale_revision" });
    expect(api.editRequests.at(-1)).toEqual({ versionId: ids.v1, sections: ["intro"] });
    expect(stale.events.find((event) => event.kind === "studio.action.html_edit")?.payload).toMatchObject({ artifact_id: ids.artifact, version_id: ids.v1, superseded_by_version_id: ids.v2 });
    expect(api.edits.size).toBe(2);
    await driver.end(run, "unused", "unused");
  }, 120_000);

  it("delta 4: mixed control — own and foreign designs both published in the window: only the own one is targeted and verified", async () => {
    const { driver, run } = harness();
    await driver.start(run, "unused");
    createReport();
    const foreign = foreignReport();
    const revised = await driver.studioAction(run, randomUUID(), { action: "section_revision", instruction: "Shorten the introduction", sections: ["intro"], _own_create_task_id: ids.research });
    expect(revised.receipt).toMatchObject({ performed: true, status: "admitted", http_status: 202 });
    publishEdit();
    const stale = await driver.studioAction(run, randomUUID(), { action: "stale_edit", _own_create_task_id: ids.research });
    expect(stale.receipt).toMatchObject({ performed: true, status: "refused", http_status: 409, code: "stale_revision" });
    // Both requests target the own artifact's versions; the foreign versions are never sent.
    expect(api.editRequests.map((request) => request.versionId)).toEqual([ids.v1, ids.v1]);
    expect(api.editRequests.some((request) => request.versionId === foreign.v1 || request.versionId === foreign.v2)).toBe(false);
    for (const acted of [revised, stale]) {
      expect(acted.events.find((event) => event.kind === "studio.action.html_edit")?.payload).toMatchObject({ artifact_id: ids.artifact, design_task_id: ids.design });
      expect(observedArtifacts(acted.events).every((artifact) => artifact.artifact_id === ids.artifact)).toBe(true);
    }
    const ended = await driver.end(run, "unused", "unused");
    expect(observedArtifacts(ended.events).map((artifact) => artifact.artifact_id)).toEqual([ids.artifact, ids.artifact]);
    // The foreign design's bytes are never downloaded, so they can never judge the run.
    expect(api.calls.filter((call) => call.includes(`/artifacts/${foreign.artifact}/`) || call.includes(`/sources/${foreign.html}/`))).toEqual([]);
  }, 120_000);

  for (const flip of ["exchange_rebound", "design_replaced"] as const) {
    it(`delta 4: the chain is re-verified immediately before the mutating request (${flip}): a chain that changed is refused, nothing is edited`, async () => {
      const { driver, run } = harness();
      await driver.start(run, "unused");
      createReport();
      const other = foreignReport();
      let reads = 0;
      api.onTaskRead = (taskId) => {
        if (taskId !== ids.research || ++reads !== 2) return;
        // Between the first resolution and the mutation the product's chain changes.
        const detail = api.tasks.get(ids.research)!;
        if (flip === "exchange_rebound") api.tasks.set(ids.research, { ...detail, task: { ...(detail.task as Record<string, unknown>), exchangeId: OTHER_EXCHANGE } });
        else {
          api.tasks.set(ids.research, { ...detail, research: { ...(detail.research as Record<string, unknown>), html: { state: "published", designTaskId: other.design } } });
          const design = api.tasks.get(other.design)!;
          api.tasks.set(other.design, { ...design, design: { ...(design.design as Record<string, unknown>), researchTaskId: ids.research } });
        }
      };
      const acted = await driver.studioAction(run, randomUUID(), { action: "section_revision", instruction: "Shorten the introduction", sections: ["intro"], _own_create_task_id: ids.research });
      expect(acted.receipt).toMatchObject({ performed: false, status: "uncertain", reason: "target_changed" });
      expect(api.edits.size).toBe(0);
      expect(postedEdits()).toEqual([]);
      await driver.end(run, "unused", "unused");
    }, 120_000);
  }
  it("delta 5 nit: a calls read renews the run's own session near its expiry (a password grant); End's global sign-out revokes the renewed session too", async () => {
    const { driver, run } = harness();
    tokens.expiresIn = 62;
    await driver.start(run, "unused");
    // Every token issued so far is at least 3 s old: within 60 s of its expiry.
    await sleep(3_000);
    const issuedBefore = tokens.issued.size;
    const read = await driver.readStudioCalls(run, "baseline", randomUUID(), "g7.create");
    expect(read.payload).toMatchObject({ status: "available" });
    expect(tokens.issued.size).toBe(issuedBefore + 1);
    const ended = await driver.end(run, "unused", "unused");
    expect(ended.events.find((event) => event.kind === "studio.cleanup.signed_out")?.payload).toMatchObject({ scope: "global", confirmed: true });
    expect(tokens.logouts).toContain("global");
    expect([...tokens.issued].filter((token) => !tokens.revoked.has(token))).toEqual([]);
  }, 120_000);
  // ---------------------------------------------------- delta 4 review (labrev4)
  it("labrev4 P3-1: a newer version of the run's own artifact (a rendition that keeps the page) is revised; the stale probe still sends the design's published version", async () => {
    const { driver, run } = harness();
    await driver.start(run, "unused");
    createReport();
    const rendition = randomUUID();
    api.versions.set(ids.artifact, [version(rendition, ids.html1, html1, ids.v1), version(ids.v1, ids.html1, html1, null)]);
    const revised = await driver.studioAction(run, randomUUID(), { action: "section_revision", instruction: "Shorten the introduction", sections: ["intro"], _own_create_task_id: ids.research });
    expect(revised.receipt).toMatchObject({ performed: true, status: "admitted", http_status: 202 });
    expect(api.editRequests).toEqual([{ versionId: rendition, sections: ["intro"] }]);
    expect(revised.events.find((event) => event.kind === "studio.action.html_edit")?.payload).toMatchObject({ artifact_id: ids.artifact, version_id: rendition });
    const stale = await driver.studioAction(run, randomUUID(), { action: "stale_edit", _own_create_task_id: ids.research });
    expect(stale.receipt).toMatchObject({ performed: true, status: "refused", http_status: 409, code: "stale_revision" });
    expect(api.editRequests.at(-1)).toEqual({ versionId: ids.v1, sections: ["intro"] });
    await driver.end(run, "unused", "unused");
  }, 120_000);

  it("labrev4 nit: the run's own-chain state is forgotten once its browser closes", async () => {
    const { driver, run } = harness();
    await driver.start(run, "unused");
    createReport();
    await driver.studioAction(run, randomUUID(), { action: "section_revision", instruction: "Shorten the introduction", sections: ["intro"], _own_create_task_id: ids.research });
    expect(driver.retainsStudioRunState(run.id)).toBe(true);
    await driver.end(run, "unused", "unused");
    expect(driver.retainsStudioRunState(run.id)).toBe(false);
  }, 120_000);

  // labrev4 P3-2: the withdrawal confirms the preview's whole cascade, so it is sent only when all of it is the run's own.
  const postedWithdrawals = () => api.calls.filter((call) => call.startsWith("POST") && call.includes("/withdrawal"));
  const foreignCascades: Array<[string, () => { entryId: string }]> = [
    ["a correction of the run's note by another member", () => {
      const correction = randomUUID();
      api.mission = [{ ...api.mission[0]!, state: "superseded" }, { ...api.mission[0]!, id: correction, actorId: OTHER_PRINCIPAL, origin: "studio", exchangeId: null, inputEpoch: null, supersedesEntryId: ids.note, sourceId: randomUUID() }];
      return { entryId: ids.note };
    }],
    ["a correction of the run's note not bound to the run's exchange (the principal's typed one)", () => {
      const correction = randomUUID();
      api.mission = [{ ...api.mission[0]!, state: "superseded" }, { ...api.mission[0]!, id: correction, origin: "studio", exchangeId: null, inputEpoch: null, supersedesEntryId: ids.note, sourceId: randomUUID() }];
      return { entryId: ids.note };
    }],
    ["another member's correction inside the chain of the run's current note (the run corrected it back)", () => {
      const foreign = randomUUID(), own = randomUUID();
      api.mission = [{ ...api.mission[0]!, state: "superseded" }, { ...api.mission[0]!, id: foreign, state: "superseded", actorId: OTHER_PRINCIPAL, origin: "studio", exchangeId: null, inputEpoch: null, supersedesEntryId: ids.note, sourceId: randomUUID() },
        { ...api.mission[0]!, id: own, supersedesEntryId: foreign, inputEpoch: 2, sourceId: randomUUID() }];
      return { entryId: own };
    }],
    ["a proposal citing the note made by another member", () => {
      api.decisions = [...api.decisions, missionDecision(randomUUID(), { proposedBy: OTHER_PRINCIPAL, proposedVia: "studio", supportingEntryIds: [ids.note] })];
      return { entryId: ids.note };
    }],
    ["a decision citing the note accepted by another member", () => {
      api.decisions = [...api.decisions, missionDecision(randomUUID(), { state: "accepted", revision: 2, supportingEntryIds: [ids.note], decidedBy: OTHER_PRINCIPAL, decidedVia: "studio" })];
      return { entryId: ids.note };
    }],
    ["a decision citing the note that also rests on a note not bound to the run's exchange", () => {
      const typed = randomUUID();
      api.mission = [...api.mission, { ...api.mission[0]!, id: typed, origin: "studio", exchangeId: null, inputEpoch: null, sourceId: randomUUID() }];
      api.decisions = [...api.decisions, missionDecision(randomUUID(), { supportingEntryIds: [ids.note, typed] })];
      return { entryId: ids.note };
    }],
  ];
  for (const [label, arrange] of foreignCascades) {
    it(`labrev4 P3-2: a withdrawal whose cascade reaches ${label} sends nothing`, async () => {
      const { driver, run } = harness();
      await driver.start(run, "unused");
      createReport();
      const { entryId } = arrange();
      const acted = await driver.studioAction(run, randomUUID(), { action: "withdrawal", entry_id: entryId });
      expect(acted.receipt).toMatchObject({ performed: false, status: "unavailable", reason: "withdrawal_cascade_not_own" });
      expect(acted.events.find((event) => event.kind === "studio.action.withdrawal")?.payload).toMatchObject({ requested: false, reason: "withdrawal_cascade_not_own" });
      expect(postedWithdrawals()).toEqual([]);
      expect(api.withdrawals).toEqual([]);
      await driver.end(run, "unused", "unused");
    }, 120_000);
  }

  it("labrev4 P3-2 positive control: the run's own note, its own correction and its own decision citing it are withdrawn with exactly those ids and revisions", async () => {
    const { driver, run } = harness();
    await driver.start(run, "unused");
    createReport();
    const correction = randomUUID();
    const decision = randomUUID();
    api.mission = [{ ...api.mission[0]!, state: "superseded" }, { ...api.mission[0]!, id: correction, supersedesEntryId: ids.note, inputEpoch: 2, sourceId: randomUUID() }];
    api.decisions = [...api.decisions, missionDecision(decision, { revision: 3, state: "accepted", supportingEntryIds: [correction], decidedBy: PRINCIPAL_UUID, decidedVia: "voice" })];
    const acted = await driver.studioAction(run, randomUUID(), { action: "withdrawal" });
    expect(acted.receipt).toMatchObject({ performed: true, status: "committed", entry_id: correction, http_status: 202 });
    expect(postedWithdrawals()).toHaveLength(1);
    expect(api.withdrawals).toEqual([expect.objectContaining({ expectedAffected: { entryIds: [ids.note, correction], decisions: [{ id: ids.decision, revision: 2 }, { id: decision, revision: 3 }] }, previewToken: PREVIEW_PROOF })]);
    expect(api.mission.every((entry) => entry.state === "withdrawn")).toBe(true);
    await driver.end(run, "unused", "unused");
  }, 120_000);

  // Security P1 (root, PR #168 comment 6090735518): a decision is the run's own only at the exact {id, revision} the
  // ownership read saw. A revision the preview names but that read did not see is confirmed by one fresh mission read
  // (still the principal's own, at exactly the previewed revision) or the withdrawal sends nothing.
  const ownProposal = (id: string) => missionDecision(id, { revision: 1, state: "proposed", supportingEntryIds: [ids.note] });
  const acceptedBy = (actor: string, revision: number, via: string) => (decision: Record<string, unknown>) => ({ ...decision, revision, state: "accepted", decidedBy: actor, decidedVia: via, decidedAt: new Date().toISOString() });
  const changeDecision = (id: string, change: (decision: Record<string, unknown>) => Record<string, unknown>) => {
    api.decisions = api.decisions.map((decision) => decision.id === id ? change(decision) : decision);
  };
  const decisionOf = (id: string) => api.decisions.find((decision) => decision.id === id);

  it("security P1: another member's acceptance between the ownership read and the preview is never withdrawn (the race)", async () => {
    const { driver, run } = harness();
    await driver.start(run, "unused");
    createReport();
    const D = randomUUID();
    api.decisions = [...api.decisions, ownProposal(D)];
    // Root's sequence: D is the principal's own undecided voice proposal at revision 1 when the mission is read; as
    // the preview is read, another member accepts it (revision 2, decided by OTHER), and the preview names D@2.
    api.onWithdrawalPreview = () => { api.onWithdrawalPreview = null; changeDecision(D, acceptedBy(OTHER_PRINCIPAL, 2, "studio")); };
    const readsBefore = api.missionReads;
    const acted = await driver.studioAction(run, randomUUID(), { action: "withdrawal", entry_id: ids.note });
    expect(acted.receipt).toMatchObject({ performed: false, status: "unavailable", reason: "withdrawal_cascade_not_own" });
    expect(postedWithdrawals()).toEqual([]);
    expect(api.withdrawals).toEqual([]);
    expect(decisionOf(D)).toMatchObject({ revision: 2, state: "accepted", decidedBy: OTHER_PRINCIPAL });
    expect(api.mission.find((entry) => entry.id === ids.note)).toMatchObject({ state: "current" });
    // One bounded fresh check, never more.
    expect(api.missionReads - readsBefore).toBe(2);
    await driver.end(run, "unused", "unused");
  }, 120_000);

  it("security P1 positive control: the run's own undecided decision at the revision it was read at is still withdrawn, without a fresh read", async () => {
    const { driver, run } = harness();
    await driver.start(run, "unused");
    createReport();
    const D = randomUUID();
    api.decisions = [...api.decisions, ownProposal(D)];
    const readsBefore = api.missionReads;
    const acted = await driver.studioAction(run, randomUUID(), { action: "withdrawal", entry_id: ids.note });
    expect(acted.receipt).toMatchObject({ performed: true, status: "committed", entry_id: ids.note, http_status: 202 });
    expect(api.withdrawals).toEqual([expect.objectContaining({ expectedAffected: { entryIds: [ids.note], decisions: [{ id: ids.decision, revision: 2 }, { id: D, revision: 1 }] }, previewToken: PREVIEW_PROOF })]);
    expect(decisionOf(D)).toMatchObject({ revision: 1, state: "withdrawn" });
    expect(api.missionReads - readsBefore).toBe(1);
    await driver.end(run, "unused", "unused");
  }, 120_000);

  it("security P1: the principal's own acceptance between the ownership read and the preview is confirmed by the fresh read and withdrawn at that exact revision", async () => {
    const { driver, run } = harness();
    await driver.start(run, "unused");
    createReport();
    const D = randomUUID();
    api.decisions = [...api.decisions, ownProposal(D)];
    api.onWithdrawalPreview = () => { api.onWithdrawalPreview = null; changeDecision(D, acceptedBy(PRINCIPAL_UUID, 2, "voice")); };
    const readsBefore = api.missionReads;
    const acted = await driver.studioAction(run, randomUUID(), { action: "withdrawal", entry_id: ids.note });
    expect(acted.receipt).toMatchObject({ performed: true, status: "committed", entry_id: ids.note, http_status: 202 });
    expect(api.withdrawals).toEqual([expect.objectContaining({ expectedAffected: { entryIds: [ids.note], decisions: [{ id: ids.decision, revision: 2 }, { id: D, revision: 2 }] } })]);
    expect(api.missionReads - readsBefore).toBe(2);
    await driver.end(run, "unused", "unused");
  }, 120_000);

  it("security P1: a fresh read that finds the decision at yet another revision, even the principal's own again, sends nothing", async () => {
    const { driver, run } = harness();
    await driver.start(run, "unused");
    createReport();
    const D = randomUUID();
    api.decisions = [...api.decisions, ownProposal(D)];
    let previewed = false;
    api.onWithdrawalPreview = () => { api.onWithdrawalPreview = null; previewed = true; changeDecision(D, acceptedBy(OTHER_PRINCIPAL, 2, "studio")); };
    // After the preview, before the fresh read: the acceptance is undone (revision 3, the principal's own proposal again).
    api.onMissionRead = () => { if (!previewed) return; api.onMissionRead = null; changeDecision(D, (decision) => ({ ...decision, revision: 3, state: "proposed", decidedBy: null, decidedVia: null, decidedAt: null })); };
    const acted = await driver.studioAction(run, randomUUID(), { action: "withdrawal", entry_id: ids.note });
    expect(acted.receipt).toMatchObject({ performed: false, status: "unavailable", reason: "withdrawal_cascade_not_own" });
    expect(postedWithdrawals()).toEqual([]);
    expect(decisionOf(D)).toMatchObject({ revision: 3, state: "proposed" });
    await driver.end(run, "unused", "unused");
  }, 120_000);

  it("security P1: a change after the preview is refused by the product's staleness check, as before", async () => {
    const { driver, run } = harness();
    await driver.start(run, "unused");
    createReport();
    const D = randomUUID();
    api.decisions = [...api.decisions, ownProposal(D)];
    // The ownership read and the preview agree (D@1, the principal's own); another member accepts D before the post.
    api.onWithdrawalPost = () => { api.onWithdrawalPost = null; changeDecision(D, acceptedBy(OTHER_PRINCIPAL, 2, "studio")); };
    const acted = await driver.studioAction(run, randomUUID(), { action: "withdrawal", entry_id: ids.note });
    expect(acted.receipt).toMatchObject({ performed: true, status: "refused", entry_id: ids.note, http_status: 409, code: "stale_revision" });
    expect(postedWithdrawals()).toHaveLength(1);
    expect(decisionOf(D)).toMatchObject({ revision: 2, state: "accepted", decidedBy: OTHER_PRINCIPAL });
    expect(api.mission.find((entry) => entry.id === ids.note)).toMatchObject({ state: "current" });
    await driver.end(run, "unused", "unused");
  }, 120_000);
  it("labrev5 C4: End audits every call after the exchange ended and session_closed, before the global sign-out; a stray call made as End begins is listed", async () => {
    const { driver, run } = harness();
    await driver.start(run, "unused");
    let seq = 0;
    const push = (kind: string, receipt: Record<string, unknown>) => api.receipts.push({ source: "bridge", seq: Number(receipt.seq), kind, receivedAt: new Date().toISOString(), receipt });
    push("provider", providerReceipt(run, seq++, "ready"));
    // A stray voice call the principal's session made right before End.
    const at = new Date().toISOString();
    api.exchangeCalls.push({ _began: api.callsClock + 0.5, seq: 1, recordedAt: at, inputEpoch: 1, tool: "control_work", answeredAt: at, outcome: "ok", taskId: null, command: { commandId: randomUUID(), kind: "stop", goalId: ids.goal, authorityEpoch: 1, goalRevision: 1, state: "acknowledged", createdAt: at } });
    api.onEnd = () => {
      push("provider", providerReceipt(run, seq++, "closed"));
      push("session_closed", sessionClosed(run, seq++, { windows: 0, turns: 0, replies: 0 }));
    };
    const ended = await driver.end(run, "unused", "unused");
    const index = (predicate: (event: DriverEvent) => boolean) => ended.events.findIndex(predicate);
    const audit = index((event) => event.kind === "studio.exchange.calls_read" && event.payload.step_id === "final");
    expect(audit).toBeGreaterThan(-1);
    expect(ended.events[audit]!.payload).toMatchObject({ purpose: "baseline", operation_id: "end", after: null, status: "available", settled: true, quiescence: { exchange_ended: true, session_closed: true } });
    expect((ended.events[audit]!.payload.calls as Array<Record<string, unknown>>).map((call) => call.seq)).toEqual([1]);
    expect(index((event) => event.kind === "studio.cleanup.exchange_ended" && event.payload.confirmed === true)).toBeLessThan(audit);
    expect(index((event) => event.kind === "studio.bridge_receipt" && event.payload.kind === "session_closed")).toBeLessThan(audit);
    expect(index((event) => event.kind === "studio.cleanup.signed_out")).toBeGreaterThan(audit);
  }, 120_000);

  // C5 (the product fences call recording against End): a call recorded before
  // End may be listed unanswered right after End and answered later; none is
  // recorded after it. End's audit re-reads (bounded) until every listed call
  // is answered, before the global sign-out; one never answered stays unsettled.
  for (const answered of [true, false] as const) {
    it(`C5: End's post-quiescence audit ${answered ? "settles once a call recorded before End is answered after it" : "stays unsettled (never final) while a call recorded before End is never answered"}`, async () => {
      const { driver, run } = harness();
      await driver.start(run, "unused");
      let seq = 0;
      const push = (kind: string, receipt: Record<string, unknown>) => api.receipts.push({ source: "bridge", seq: Number(receipt.seq), kind, receivedAt: new Date().toISOString(), receipt });
      push("provider", providerReceipt(run, seq++, "ready"));
      const at = new Date().toISOString();
      api.exchangeCalls.push({ _began: api.callsClock + 0.5, seq: 1, recordedAt: at, inputEpoch: 1, tool: "project_status", answeredAt: null, outcome: null, taskId: null, command: null });
      api.onEnd = () => {
        push("provider", providerReceipt(run, seq++, "closed"));
        push("session_closed", sessionClosed(run, seq++, { windows: 0, turns: 0, replies: 0 }));
      };
      // Reads after the exchange ended: the second one sees the call answered (or never does).
      let readsAfterEnd = 0;
      api.onCallsRead = () => {
        if (api.exchangeId !== null) return;
        readsAfterEnd += 1;
        if (answered && readsAfterEnd === 2) api.exchangeCalls = api.exchangeCalls.map((call) => ({ ...call, answeredAt: new Date().toISOString(), outcome: "ok" }));
      };
      const ended = await driver.end(run, "unused", "unused");
      const audit = ended.events.find((event) => event.kind === "studio.exchange.calls_read" && event.payload.step_id === "final")!;
      expect(audit.payload).toMatchObject({ purpose: "baseline", operation_id: "end", status: "available", settled: answered, attempts: answered ? 2 : 10, quiescence: { exchange_ended: true, session_closed: true } });
      expect((audit.payload.calls as Array<Record<string, unknown>>).map((call) => [call.seq, call.answered_at === null])).toEqual([[1, !answered]]);
      // Taken while the principal could still read, before the global sign-out.
      expect(ended.events.indexOf(audit)).toBeLessThan(ended.events.findIndex((event) => event.kind === "studio.cleanup.signed_out"));
    }, 120_000);
  }
});
