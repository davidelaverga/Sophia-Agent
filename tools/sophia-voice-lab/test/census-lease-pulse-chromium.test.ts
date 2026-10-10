import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { Writable } from "node:stream";

import pino from "pino";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AudioResolver } from "../src/audio.js";
import { PlaywrightVoiceDriver, readHarnessEvents, type VoiceBrowserDriver } from "../src/browser-driver.js";
import { buildVoiceLabInitScript } from "../src/browser-init.js";
import type { recoveryTransportBinding } from "../src/recovery-control.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CapabilityCodec, sha256 } from "../src/security.js";
import { VoiceLabWorker } from "../src/worker.js";
import { testConfig, testRun } from "./helpers.js";
import { espeakLikeWav } from "./tts-silence-helper.js";

/**
 * #151 (Codex r4077602539) in real Chromium: the per-frame census of a 120 s
 * synthetic utterance through the deployed product's microphone pipeline
 * (ScriptProcessor 4096 at a 44.1 kHz context, extracted from the frontend
 * source as tts-trailing-silence-chromium.test.ts does) into the real page
 * ring (buildVoiceLabInitScript, 2,048 events), drained by the real worker
 * loop (VoiceLabWorker.run()) through the real reader (readHarnessEvents).
 *
 * The stalls are real: retained recovery of earlier runs whose Gateway
 * accepts and never answers, through the real PlaywrightVoiceDriver.recover
 * and its real 15 s fetch timeout, so one maintenance pass takes 15 s per
 * retained control. Before #151 the run's lease was renewed and its ring
 * drained only after those stages.
 *
 * Glue, not under examination: a thin driver that owns the one page and
 * mirrors the real schedule (bridge.schedule, then a drain), drain (its
 * harness half; the deployed product's own capture ring does not exist here)
 * and abort (a final drain, then the context closes). It returns [] from
 * continueSession (no context renewal is due within these windows). No
 * provider, product, Gateway or network beyond 127.0.0.1 is contacted: the
 * live run's Gateway host is a reserved .test name.
 */

const PRODUCT_SOURCE = path.resolve(process.cwd(), "../../frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts");
const LIVE_CONTEXT_RATE = 44_100;
/** + the 186 ms espeak tail + the resolver's 1,500 ms zero tail = 119,986 ms, within the 120,000 ms maximum. */
const SPEECH_MS = 118_300;
const RECOVERY_FETCH_TIMEOUT_MS = 15_000;

/**
 * The deployed microphone pipeline, extracted from the frontend source: the
 * top-level declarations startMicrophoneAudioPipeline reaches, plus those of
 * relative modules it imports (the product's resampler, in revisions that
 * have one), in source order, type-stripped. Any other import fails here.
 */
async function moduleClosure(file: string, roots: string[]): Promise<string[]> {
  const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const declarations = new Map<string, ts.Statement>();
  const imports = new Map<string, string>();
  for (const statement of source.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) declarations.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, statement);
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const element of statement.importClause.namedBindings.elements) imports.set(element.name.text, statement.moduleSpecifier.text);
    }
  }
  const included = new Set<ts.Statement>();
  const imported = new Map<string, string[]>();
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const statement = declarations.get(name);
    if (!statement) {
      const specifier = imports.get(name);
      if (specifier !== undefined) {
        if (!specifier.startsWith("./")) throw new Error(`The microphone pipeline imports ${name} from ${specifier}, which this test cannot inline.`);
        imported.set(specifier, [...(imported.get(specifier) ?? []), name]);
      }
      continue;
    }
    included.add(statement);
    const identifiers = new Set<string>();
    (function walk(node: ts.Node) { if (ts.isIdentifier(node)) identifiers.add(node.text); ts.forEachChild(node, walk); })(statement);
    for (const identifier of identifiers) if (!seen.has(identifier) && (declarations.has(identifier) || imports.has(identifier))) queue.push(identifier);
  }
  const dependencies: string[] = [];
  for (const [specifier, names] of imported) dependencies.push(...await moduleClosure(path.resolve(path.dirname(file), `${specifier}.ts`), names));
  return [...dependencies, ...[...included].sort((a, b) => a.pos - b.pos).map((statement) => statement.getText(source).replace(/^export\s+/, ""))];
}

async function productPipelineScript(): Promise<string> {
  const statements = await moduleClosure(PRODUCT_SOURCE, ["startMicrophoneAudioPipeline"]);
  expect(statements.some((statement) => statement.startsWith("function startMicrophoneAudioPipeline"))).toBe(true);
  const js = ts.transpileModule(statements.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return `window.__productPipeline = (() => { ${js}\n return { startMicrophoneAudioPipeline }; })();`;
}

/** Minimal RFC 6455 reader for client-to-server text frames: what the "provider" actually received. */
function wsReader(onText: (text: string) => void): (chunk: Buffer) => void {
  let buffered = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.length < 2) return;
      const fin = (buffered[0]! & 0x80) !== 0, opcode = buffered[0]! & 0x0f, masked = (buffered[1]! & 0x80) !== 0;
      let length = buffered[1]! & 0x7f, offset = 2;
      if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffered.length < 10) return; length = Number(buffered.readBigUInt64BE(2)); offset = 10; }
      const maskLength = masked ? 4 : 0;
      if (buffered.length < offset + maskLength + length) return;
      const mask = masked ? buffered.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(buffered.subarray(offset + maskLength, offset + maskLength + length));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i]! ^= mask[i % 4]!;
      buffered = buffered.subarray(offset + maskLength + length);
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload);
        if (fin) { onText(Buffer.concat(fragments).toString("utf8")); fragments = []; }
      }
    }
  };
}

const sockets = new Set<Socket>();
const servers: Server[] = [];
let browser: Browser;
let productScript: string;
let hangOrigin: string;

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

/** One case's page origin and "provider" WebSocket, counting the audio frames it received. */
async function providerServer(): Promise<{ origin: string; received: { audio: number; streamEnd: number; other: number } }> {
  const received = { audio: 0, streamEnd: 0, other: 0 };
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><title>census</title>"); });
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("data", wsReader((text) => {
      try {
        const frame = JSON.parse(text) as { realtimeInput?: { audio?: unknown; audioStreamEnd?: boolean } };
        if (frame.realtimeInput?.audio) received.audio += 1;
        else if (frame.realtimeInput?.audioStreamEnd === true) received.streamEnd += 1;
        else received.other += 1;
      } catch { received.other += 1; }
    }));
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")}\r\n\r\n`);
  });
  return { origin: await listen(server), received };
}

beforeAll(async () => {
  // A Gateway that accepts every connection and request and never answers.
  const hang = createServer(() => undefined);
  hang.on("connection", (socket) => sockets.add(socket));
  hangOrigin = await listen(hang);
  productScript = await productPipelineScript();
  const preferred = chromium.executablePath();
  const revision = preferred.match(/chromium_headless_shell-(\d+)/)?.[1];
  const cacheRoot = path.dirname(path.dirname(path.dirname(preferred)));
  const executablePath = [preferred, ...(revision ? [
    path.join(cacheRoot, `chromium-${revision}`, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
    path.join(cacheRoot, `chromium-${revision}`, "chrome-linux", "chrome"),
    path.join(cacheRoot, `chromium-${revision}`, "chrome-linux64", "chrome"),
  ] : [])].find(existsSync);
  if (!executablePath) throw new Error(`Pinned Chromium executable is unavailable (expected ${preferred}).`);
  browser = await chromium.launch({ executablePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
}, 60_000);

interface DrainRecord { startedAt: number; endedAt: number; ok: boolean; events: number; error?: string }

class CensusDriver {
  readonly sessions = new Map<string, { context: BrowserContext; page: Page; harnessCursor: number }>();
  readonly drains: DrainRecord[] = [];
  readonly calls: Array<{ at: number; call: string }> = [];
  /** When each recovery of a retained control (a stalled maintenance stage) settled. */
  readonly retainedRecoveries: Array<{ startedAt: number; endedAt: number }> = [];
  constructor(readonly origin: string, readonly liveRunId: () => string, readonly real: PlaywrightVoiceDriver) {}
  hasSession(runId: string): boolean { return this.sessions.has(runId); }
  async readiness() { return { ok: true, detail: "census", engine: "chromium", version: browser.version() }; }
  async start(run: { id: string; testRunId: string; cleanupObligationId: string; target: { expectedDeployment: unknown } }) {
    this.calls.push({ at: Date.now(), call: "start" });
    const wsOrigin = this.origin.replace("http://", "ws://");
    const context = await browser.newContext();
    await context.addInitScript({ content: buildVoiceLabInitScript({ pageOrigin: this.origin, websocketOrigins: [wsOrigin], maxAudioBytes: 8_000_000, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId }) });
    const page = await context.newPage();
    await page.goto(this.origin);
    await page.addScriptTag({ content: productScript });
    const rate = await page.evaluate(async ({ wsUrl, rate }) => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const audioContext = new AudioContext({ sampleRate: rate });
      await audioContext.resume();
      const socket = new WebSocket(wsUrl);
      await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("open failed")), { once: true }); });
      let latest: Record<string, unknown> | null = null;
      addEventListener("sophia:voice-lab-input-operation", (event) => { latest = { ...(event as CustomEvent).detail }; });
      const syntheticInputEvidence = { currentBinding: () => latest, observePcmFrame: () => null };
      (window as any).__pipeline = (window as any).__productPipeline.startMicrophoneAudioPipeline({ localStream: stream, audioContext, websocketRef: { current: socket }, syntheticInputEvidence });
      return audioContext.sampleRate;
    }, { wsUrl: wsOrigin, rate: LIVE_CONTEXT_RATE });
    expect(rate).toBe(LIVE_CONTEXT_RATE);
    this.sessions.set((run as { id: string }).id, { context, page, harnessCursor: 0 });
    return { observedDeployment: run.target.expectedDeployment, events: [] };
  }
  async schedule(run: { id: string }, operationId: string, utteranceId: string, audio: { bytes: Buffer; sha256: string; fixture?: { fixtureClass?: string } }, delayMs = 0) {
    this.calls.push({ at: Date.now(), call: "schedule" });
    const session = this.sessions.get(run.id)!;
    const receipt = await session.page.evaluate(async (input) => (window as any).__sophiaVoiceLab.schedule(input), {
      operationId, utteranceId, audioBase64: audio.bytes.toString("base64"), sha256: audio.sha256, delayMs,
      expectedSilence: audio.fixture?.fixtureClass === "silence", settlementWindowMs: 3_000, activeTarget: null,
    });
    return { receipt: { product: receipt }, events: await this.drain(run.id) };
  }
  async drain(runId: string) {
    const session = this.sessions.get(runId);
    if (!session) throw new Error("no session");
    const record: DrainRecord = { startedAt: Date.now(), endedAt: 0, ok: false, events: 0 };
    this.drains.push(record);
    try {
      const harness = await readHarnessEvents(session.page, session.harnessCursor);
      session.harnessCursor = harness.cursor;
      Object.assign(record, { ok: true, endedAt: Date.now(), events: harness.events.length });
      return harness.events;
    } catch (error) {
      Object.assign(record, { endedAt: Date.now(), error: (error as { detail?: { code?: string } })?.detail?.code ?? (error instanceof Error ? error.message : String(error)) });
      throw error;
    }
  }
  async continueSession() { return []; }
  async recover(binding: ReturnType<typeof recoveryTransportBinding>, capability: string, processTermination?: never) {
    const retained = binding.id !== this.liveRunId();
    const startedAt = Date.now();
    try { return await this.real.recover(binding, capability, processTermination); }
    finally { if (retained) this.retainedRecoveries.push({ startedAt, endedAt: Date.now() }); }
  }
  async #close(runId: string) { const session = this.sessions.get(runId); this.sessions.delete(runId); await session?.context.close().catch(() => undefined); }
  async cancel(runId: string, reason: string) { this.calls.push({ at: Date.now(), call: `cancel:${reason}` }); await this.#close(runId); }
  async abort(run: { id: string }, reason: string) {
    this.calls.push({ at: Date.now(), call: `abort:${reason}` });
    // As the real abort: a final drain, then the context closes.
    const events = this.sessions.has(run.id) ? await this.drain(run.id).catch(() => []) : [];
    await this.#close(run.id);
    return { events, artifacts: [] };
  }
  async end(): Promise<never> { throw new Error("end is not exercised by the census cases"); }
  async close() { for (const runId of [...this.sessions.keys()]) await this.#close(runId); }
}

interface CensusCase {
  retainedControls: number;
  browserLeaseSeconds?: number;
  /** A second speak operation queued this long after the first was scheduled. */
  pendingAfterMs?: number;
}

async function runCensus(options: CensusCase) {
  const provider = await providerServer();
  const logLines: string[] = [];
  const logger = pino({ level: "info" }, new Writable({ write(chunk, _encoding, done) { logLines.push(String(chunk)); done(); } }));
  const config = testConfig({
    SOPHIA_VOICE_LAB_ESPEAK_VERSION: "9.9",
    SOPHIA_VOICE_LAB_MAX_AUDIO_DURATION_MS: "120000",
    SOPHIA_VOICE_LAB_ALLOWED_ORIGINS: `http://frontend.test,http://gateway.test,http://voice.test,http://langgraph.test,${hangOrigin}`,
    ...(options.browserLeaseSeconds === undefined ? {} : { SOPHIA_VOICE_LAB_BROWSER_LEASE_SECONDS: String(options.browserLeaseSeconds) }),
  });
  const audio = new AudioResolver(config, async () => espeakLikeWav(SPEECH_MS, 186), async () => "9.9");
  await audio.initialize();
  const ledger = new MemoryVoiceLabLedger("test");
  const run = testRun({ scenarioId: "V-O01", expiresAt: new Date(Date.now() + 900_000) });
  const driver = new CensusDriver(provider.origin, () => run.id, new PlaywrightVoiceDriver(config));
  const worker = new VoiceLabWorker("census-worker", ledger, config, audio, driver as unknown as VoiceBrowserDriver,
    new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), logger);
  const operation = (type: "start" | "speak", input: Record<string, unknown> = {}) => ({ id: randomUUID(), runId: run.id, callerId: run.callerId, type, idempotencyKey: randomUUID(), requestHash: sha256(randomUUID()), input });
  await ledger.createRunWithOperation(run, operation("start"), { global: 1, caller: 1 });
  const executing: Array<{ operationId: string; at: number }> = [];
  const markExecuting = ledger.markOperationExecuting.bind(ledger);
  ledger.markOperationExecuting = async (operationId, workerId, epoch) => {
    const marked = await markExecuting(operationId, workerId, epoch);
    executing.push({ operationId, at: Date.now() });
    return marked;
  };

  // Lease truth, every second: the durable lease next to the owner's live page.
  const leaseSamples: Array<{ at: number; epoch: number | null; expiresInMs: number | null; pageAlive: boolean }> = [];
  const sampler = setInterval(() => {
    void ledger.getBrowserLease(run.id).then((lease) => {
      leaseSamples.push({ at: Date.now(), epoch: lease?.leaseEpoch ?? null, expiresInMs: lease ? lease.expiresAt.getTime() - Date.now() : null, pageAlive: driver.hasSession(run.id) });
    });
  }, 1_000);

  const loop = worker.run();
  let pending: ReturnType<typeof operation> | null = null;
  try {
    for (let i = 0; i < 600 && (await ledger.getRun(run.id))?.state !== "ready"; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await ledger.getRun(run.id))?.state).toBe("ready");
    await ledger.createOperation(operation("speak", { text: "governed synthetic long utterance", _admission: { duration_ms: 120_000, bytes: 8_000_000 } }));
    for (let i = 0; i < 600 && driver.calls.every((call) => call.call !== "schedule"); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const scheduledAt = Date.now();
    if (options.retainedControls > 0) {
      // Retained recovery becomes due for earlier runs whose Gateway no longer answers.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      for (let i = 0; i < options.retainedControls; i += 1) {
        const retained = testRun({ scenarioId: "V-A01", state: "failed_harness", retentionPurgeDueAt: new Date(0), retentionPurgePending: true, target: { ...run.target, gatewayUrl: hangOrigin } });
        await ledger.createRunWithOperation(retained, { id: randomUUID(), runId: retained.id, callerId: retained.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(retained.id), input: {} }, { global: 100, caller: 100 });
      }
      await ledger.purgeExpiredRetention(new Date(), 100);
    }
    if (options.pendingAfterMs !== undefined) {
      const wait = scheduledAt + options.pendingAfterMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      pending = operation("speak", { text: "governed synthetic follow-up", _admission: { duration_ms: 10_000, bytes: 1_000_000 } });
      await ledger.createOperation(pending);
    }
    // Until the input completes and is drained, the run leaves its live states, or 170 s pass (the input is 119.986 s).
    const deadline = Date.now() + 170_000;
    for (;;) {
      const state = (await ledger.getRun(run.id))?.state;
      if (await ledger.findLatestEvent(run.id, ["audio.input.completed"])) break;
      if (state && !["ready", "active"].includes(state)) break;
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  } finally {
    clearInterval(sampler);
    worker.stop();
    await Promise.race([loop.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 60_000))]);
  }

  const events = (await ledger.listEvents(run.id, 0, 100_000)).events;
  const browserSeqs = events.filter((event) => /^browser:\d+$/.test(event.dedupeKey ?? "")).map((event) => Number(event.dedupeKey!.slice(8))).sort((a, b) => a - b);
  const firstSpeak = (await ledger.listOperations(run.id)).filter((op) => op.type === "speak").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  const forwarded = events.filter((event) => event.kind === "harness.input_frame_forwarded" && event.payload.operation_id === firstSpeak?.id);
  const frameSeqs = forwarded.map((event) => Number(event.payload.frame_seq)).sort((a, b) => a - b);
  const censusAudio = events.filter((event) => event.kind === "harness.provider_frame_sent" && event.payload.realtime_input_kind === "audio").length;
  return {
    ledger, run, driver, provider, logLines, leaseSamples, executing, pending,
    finalRun: (await ledger.getRun(run.id))!,
    operations: await ledger.listOperations(run.id),
    browserSeqs, forwarded, frameSeqs, censusAudio,
    completed: events.find((event) => event.kind === "audio.input.completed"),
    loss: events.filter((event) => event.kind === "durability.browser_worker_loss_observed"),
    expiredWhileAlive: leaseSamples.filter((sample) => sample.pageAlive && sample.expiresInMs !== null && sample.expiresInMs <= 0),
    epochs: [...new Set(leaseSamples.filter((sample) => sample.epoch !== null).map((sample) => sample.epoch))],
    stallEnds: driver.retainedRecoveries.map((recovery) => recovery.endedAt).sort((a, b) => a - b),
  };
}

type CensusResult = Awaited<ReturnType<typeof runCensus>>;

/** No ring gap and lease truth: every persisted harness event in order, every forwarded frame once, the provider received each. */
function expectCompleteCensus(result: CensusResult, options: { inputCompleted: boolean }): void {
  expect(result.driver.drains.filter((drain) => !drain.ok)).toEqual([]);
  expect(result.browserSeqs.length).toBeGreaterThan(0);
  expect(result.browserSeqs.every((seq, index) => seq === index + 1), "persisted harness events are contiguous from 1").toBe(true);
  expect(result.frameSeqs.every((seq, index) => seq === index + 1), "forwarded frame_seq is contiguous from 1").toBe(true);
  expect(result.censusAudio).toBe(result.provider.received.audio);
  expect(result.forwarded.length).toBe(result.provider.received.audio);
  if (options.inputCompleted) {
    expect(result.completed, "the input completed and was drained").toBeDefined();
    expect(result.completed!.payload.forwarded_frame_count).toBe(result.forwarded.length);
    expect(result.forwarded.length).toBeGreaterThanOrEqual(1_280);
  }
  expect(result.expiredWhileAlive, "the lease never expired while its owner's page was alive").toEqual([]);
  expect(result.loss).toEqual([]);
  expect(result.epochs).toHaveLength(1);
}

describe.concurrent("#151 census in real Chromium: maintenance cannot starve a live run", () => {
  it("positive control: a 120 s utterance under healthy maintenance keeps its lease and a complete census", async () => {
    const result = await runCensus({ retainedControls: 0 });
    expectCompleteCensus(result, { inputCompleted: true });
    expect(result.stallEnds).toEqual([]);
  }, 300_000);

  it("lease stall: retained recovery against a silent Gateway stalls each maintenance pass 45 s past the 30 s lease; the lease stays live and the census complete", async () => {
    const result = await runCensus({ retainedControls: 3 });
    expect(result.stallEnds.length).toBeGreaterThanOrEqual(3);
    expectCompleteCensus(result, { inputCompleted: true });
    expect(result.finalRun.state).toBe("active");
  }, 300_000);

  it("ring stall: with a 120 s lease, seven silent retained recoveries stall a pass past the ring window (105 s at ~21.5 events/s against 2,048 events); no ring gap", async () => {
    const result = await runCensus({ retainedControls: 7, browserLeaseSeconds: 120 });
    const stall = result.driver.retainedRecoveries;
    expect(stall.length).toBeGreaterThanOrEqual(7);
    expect(stall.slice(0, 7).reduce((total, recovery) => total + recovery.endedAt - recovery.startedAt, 0)).toBeGreaterThanOrEqual(7 * RECOVERY_FETCH_TIMEOUT_MS - 1_000);
    expectCompleteCensus(result, { inputCompleted: true });
    expect(result.finalRun.state).toBe("active");
  }, 300_000);

  it("pending operation through the stall (harness limitation: no product settlement event): the queued speak is claimed within one maintenance pass after the stall, never cancelled, then fails INPUT_OPERATION_SETTLEMENT_PENDING only because this harness has no product turn settlement", async () => {
    const result = await runCensus({ retainedControls: 3, pendingAfterMs: 5_000 });
    const pending = result.operations.find((op) => op.id === result.pending?.id)!;
    expect(pending).toBeDefined();
    const claim = result.executing.find((entry) => entry.operationId === pending.id);
    expect(claim, "the queued operation was claimed").toBeDefined();
    // The stall: the first pass's retained recoveries. The claim follows the end of that pass.
    const firstStallEnd = result.stallEnds.find((endedAt) => endedAt <= claim!.at && result.stallEnds.filter((other) => other <= endedAt).length >= 3);
    expect(firstStallEnd, "the claim followed the stalled pass").toBeDefined();
    const lastStallEndBeforeClaim = Math.max(...result.stallEnds.filter((endedAt) => endedAt <= claim!.at));
    expect(claim!.at - lastStallEndBeforeClaim, "claimed within one maintenance pass after the stall").toBeLessThan(2_000);
    expect(pending.state).not.toBe("cancelled");
    // The harness limitation, labelled: the deployed product authors the turn settlement this page cannot.
    expect(pending).toMatchObject({ state: "failed", error: { code: "INPUT_OPERATION_SETTLEMENT_PENDING" } });
    process.stdout.write("[#151 census] pending-operation case: INPUT_OPERATION_SETTLEMENT_PENDING is the harness limitation (no product turn settlement event in this page), not a census or lease result\n");
    expectCompleteCensus(result, { inputCompleted: false });
    expect(result.finalRun.terminalError?.code).toBe("INPUT_OPERATION_SETTLEMENT_PENDING");
  }, 300_000);
});
