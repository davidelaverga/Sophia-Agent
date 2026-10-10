import { createPrivateKey, randomUUID, sign } from "node:crypto";

import pino from "pino";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AudioResolver } from "../src/audio.js";
import type { D02BrowserContextBinding, D02ProductCleanupAcknowledgement, D02ProductCleanupRequest, VoiceBrowserDriver } from "../src/browser-driver.js";
import type { VoiceLabConfig } from "../src/config.js";
import { D02GatewayClient } from "../src/d02-gateway.js";
import type { RunRecord } from "../src/domain.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CapabilityCodec, canonicalRequestHash, sha256, type AuthenticatedCaller } from "../src/security.js";
import { VoiceLabService } from "../src/service.js";
import { VoiceLabWorker } from "../src/worker.js";
import { testConfig, testRun } from "./helpers.js";

/**
 * #151 (Codex r4077602539): a live run's lease and page capture must not
 * depend on the maintenance pass reaching them. These run the real worker loop
 * (worker.run()) on fake timers, a memory ledger and a fake page whose capture
 * ring has the product's 2,048-event capacity and the census frame rate of a
 * 44.1 kHz context with 4,096-sample buffers (two ring events per frame).
 */

const RING_CAPACITY = 2_048;
const FRAMES_PER_SECOND = 44_100 / 4_096;
const SPEECH_MS = 120_000;
/** A pulse interval plus the time one in-memory maintenance step or drain can take. */
const SLACK_MS = 1_000;
const WORKER_ID = "pulse-worker";
const DEPLOYMENT_CONTROL_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDhkSCJg4Qta3ZaccGJIGUnCLA/WT8IuvVrBV11Vg0Ot";

interface DriverEvent { kind: string; source: "browser" | "worker" | "canonical"; payload: Record<string, unknown>; dedupeKey: string }

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
/** Captured before any test fakes the timers: lets real I/O (zlib, fs) settle between fake-clock steps. */
const realSetTimeout = globalThis.setTimeout;
function realTurn(): Promise<void> { return new Promise((resolve) => { realSetTimeout(resolve, 1); }); }

/** One page's capture ring: frames are produced on the (fake) clock, the oldest are overwritten past capacity. */
class FakePage {
  live = true;
  speechStart: number | null = null;
  speechEnd: number | null = null;
  totalFrames = 0;
  cursor = 0;
  lost = 0;

  startSpeech(durationMs: number): void {
    this.speechStart = Date.now();
    this.speechEnd = null;
    this.totalFrames = Math.floor(durationMs / 1_000 * FRAMES_PER_SECOND);
  }

  stopSpeech(): void { this.speechEnd ??= Date.now(); }

  produced(): number {
    if (this.speechStart === null) return 0;
    const until = Math.min(Date.now(), this.speechEnd ?? Number.POSITIVE_INFINITY);
    return 2 * Math.min(this.totalFrames, Math.max(0, Math.floor((until - this.speechStart) / 1_000 * FRAMES_PER_SECOND)));
  }

  read(): DriverEvent[] {
    const produced = this.produced();
    const oldest = Math.max(0, produced - RING_CAPACITY);
    if (this.cursor < oldest) {
      this.lost += oldest - this.cursor;
      this.cursor = oldest;
    }
    const events: DriverEvent[] = [];
    for (let seq = this.cursor; seq < produced; seq += 1) {
      events.push({ kind: seq % 2 === 0 ? "harness.provider_frame_sent" : "harness.input_frame_forwarded", source: "browser", payload: { ring_seq: seq, frame_seq: Math.floor(seq / 2) }, dedupeKey: `ring:${seq}` });
    }
    this.cursor = produced;
    return events;
  }
}

interface HeldDrain { runId: string; entered: () => void; released: Promise<void> }

class PulseDriver {
  readonly pages = new Map<string, FakePage>();
  /** Every capture read, by whom: "worker" is a VoiceLabWorker drain() call, "driver" a read inside a driver operation. */
  readonly reads: Array<{ runId: string; at: number; by: "worker" | "driver" }> = [];
  /** drain() calls made while a driver operation of the same run was in progress: a serialization violation. */
  readonly foreignWhileHeld: Array<{ runId: string; at: number }> = [];
  readonly continueCalls: Array<{ runId: string; at: number }> = [];
  readonly cancelCalls: Array<{ runId: string; at: number }> = [];
  readonly inOperation = new Set<string>();
  readonly #inFlight = new Map<string, number>();
  /** Runs whose session maintenance just continued: maintenance reads right after continuing, the pulse never continues. */
  readonly #continued = new Set<string>();
  overlaps = 0;
  drainLatencyMs = 2;
  rotateHoldMs = new Map<string, number>();
  endHoldMs = 15_000;
  recoverDelayMs = 0;
  quiesceDelayMs = 0;
  hold: HeldDrain | null = null;
  /** Events the next worker read of a run returns ahead of its ring events. */
  readonly extra = new Map<string, DriverEvent[]>();

  hasSession = (runId: string) => this.pages.get(runId)?.live === true;
  start = async (run: RunRecord, _capability: string, binding?: D02BrowserContextBinding) => {
    this.pages.set(run.id, new FakePage());
    return { observedDeployment: run.target.expectedDeployment, events: [], browserContextBinding: binding };
  };
  readiness = async () => ({ ok: true, detail: "fixture", engine: "chromium", version: "fixture" });

  async #read(runId: string, by: "worker" | "driver"): Promise<DriverEvent[]> {
    const page = this.pages.get(runId);
    if (!page?.live) throw new Error("Browser session is not live.");
    const concurrent = (this.#inFlight.get(runId) ?? 0) + 1;
    this.#inFlight.set(runId, concurrent);
    if (concurrent > 1) this.overlaps += 1;
    try {
      await sleep(this.drainLatencyMs);
      const maintenanceRead = this.#continued.delete(runId);
      // A held read is always the active-lease pulse's, never maintenance's.
      if (by === "worker" && !maintenanceRead && this.hold?.runId === runId) {
        const hold = this.hold;
        this.hold = null;
        hold.entered();
        await hold.released;
      }
      if (!page.live) throw new Error("Browser session closed during the read.");
      this.reads.push({ runId, at: Date.now(), by });
      const extra = by === "worker" ? this.extra.get(runId) ?? [] : [];
      if (by === "worker") this.extra.delete(runId);
      return [...extra, ...page.read()];
    } finally {
      this.#inFlight.set(runId, (this.#inFlight.get(runId) ?? 1) - 1);
    }
  }

  drain = async (runId: string): Promise<DriverEvent[]> => {
    if (this.inOperation.has(runId)) this.foreignWhileHeld.push({ runId, at: Date.now() });
    return this.#read(runId, "worker");
  };

  async #operation<T>(runId: string, body: () => Promise<T>): Promise<T> {
    this.inOperation.add(runId);
    try { return await body(); } finally { this.inOperation.delete(runId); }
  }

  continueSession = async (run: RunRecord) => {
    this.continueCalls.push({ runId: run.id, at: Date.now() });
    this.#continued.add(run.id);
    return [];
  };
  schedule = async (run: RunRecord, operationId: string) => this.#operation(run.id, async () => {
    this.pages.get(run.id)!.startSpeech(SPEECH_MS);
    return { receipt: { scheduled: true, operation_id: operationId }, events: await this.#read(run.id, "driver") };
  });
  /** As the real rotate: reads first, then every 100 ms until it settles. */
  rotate = async (run: RunRecord) => this.#operation(run.id, async () => {
    const until = Date.now() + (this.rotateHoldMs.get(run.id) ?? 0);
    const events: DriverEvent[] = [];
    for (;;) {
      events.push(...await this.#read(run.id, "driver"));
      if (Date.now() >= until) return { receipt: { rotated: true }, events };
      await sleep(100);
    }
  });
  /** As the real end: the grant refresh and the finalization wait read nothing; input stops at the click, then two reads. */
  end = async (run: RunRecord) => this.#operation(run.id, async () => {
    await sleep(this.endHoldMs);
    const page = this.pages.get(run.id)!;
    page.stopSpeech();
    const events = [...await this.#read(run.id, "driver"), ...await this.#read(run.id, "driver")];
    page.live = false;
    events.push({ kind: "cleanup.browser_context_closed", source: "worker", payload: { closed: true }, dedupeKey: `cleanup:${run.id}:context` });
    return { events, artifacts: [] };
  });
  abort = async (run: RunRecord) => this.#operation(run.id, async () => {
    const page = this.pages.get(run.id);
    if (!page?.live) return { events: [{ kind: "cleanup.browser_absent", source: "browser" as const, payload: {}, dedupeKey: `cleanup:${run.id}:absent` }], artifacts: [] };
    const events = await this.#read(run.id, "driver");
    page.stopSpeech();
    page.live = false;
    events.push({ kind: "cleanup.browser_context_closed", source: "worker", payload: { closed: true }, dedupeKey: `cleanup:${run.id}:context` });
    return { events, artifacts: [] };
  });
  cancel = async (runId: string) => {
    this.cancelCalls.push({ runId, at: Date.now() });
    const page = this.pages.get(runId);
    if (page) { page.stopSpeech(); page.live = false; }
  };
  /** One complete Gateway recovery, as slow as a Gateway that takes `recoverDelayMs` to answer. */
  recover = async (binding: { runId: string }) => {
    if (this.recoverDelayMs > 0) await sleep(this.recoverDelayMs);
    return { events: [{ kind: "cleanup.recovery", source: "canonical" as const, payload: { complete: true, live_cleanup_complete: false }, dedupeKey: `recovery:${binding.runId}:${Date.now()}` }], artifacts: [] };
  };
  quiesceD02Provider = async (_run: RunRecord, request: D02ProductCleanupRequest): Promise<D02ProductCleanupAcknowledgement> => {
    if (this.quiesceDelayMs > 0) await sleep(this.quiesceDelayMs);
    return {
      schema: "sophia_voice_lab_d02_product_provider_cleanup_acknowledgement_v1",
      voice_lab_run_id_sha256: request.browserContextBinding.voice_lab_run_id_sha256,
      browser_worker_id_sha256: request.browserContextBinding.browser_worker_id_sha256,
      browser_lease_epoch: request.browserContextBinding.browser_lease_epoch,
      browser_context_id_sha256: request.browserContextBinding.browser_context_id_sha256,
      provider_session_id_sha256: request.providerSessionIdSha256,
      frozen_provider_connection_epochs: [...request.frozenProviderConnectionEpochs],
      browser_provider_close_receipt_count: request.frozenProviderConnectionEpochs.length,
      browser_provider_activation_abort_receipt_count: 0,
      settlement_acknowledgement_sha256: canonicalRequestHash({ accepted_epochs: request.frozenProviderConnectionEpochs }),
      raw_provider_and_receipt_identifiers_excluded: true,
    };
  };
  close = async () => { for (const page of this.pages.values()) { page.stopSpeech(); page.live = false; } };
}

interface Harness {
  config: VoiceLabConfig;
  ledger: MemoryVoiceLabLedger;
  driver: PulseDriver;
  worker: VoiceLabWorker;
  runs: RunRecord[];
  logs: Array<Record<string, unknown>>;
  renewals: Array<{ runId: string; epoch: number; at: number; ok: boolean }>;
  executing: Array<{ operationId: string; at: number }>;
  /** Every runOnce() of the loop that claimed work: when it returned, i.e. when its operation released the run's turn. */
  iterations: Array<{ startedAt: number; returnedAt: number }>;
  samples: Array<{ runId: string; at: number; state: "live" | "expired" | "absent" }>;
  stall: { active: boolean; entered: number[]; open: () => void; promise: Promise<void> };
  running: Promise<void> | null;
}

let audio: AudioResolver;
let current: Harness | null = null;
beforeAll(async () => {
  audio = new AudioResolver(testConfig());
  await audio.initialize();
});
afterEach(async () => {
  // A test that failed early must not leave its worker loop running into the next one.
  const h = current;
  current = null;
  if (h?.running) {
    let done = false;
    void h.running.then(() => { done = true; }, () => { done = true; });
    h.worker.stop();
    releaseMaintenance(h);
    h.driver.hold = null;
    for (let step = 0; step < 3_000 && !done; step += 1) { await vi.advanceTimersByTimeAsync(100); await realTurn(); }
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function newOperation(run: RunRecord, type: "start" | "speak" | "force_socket_rotation" | "end", input: Record<string, unknown> = {}) {
  return { id: randomUUID(), runId: run.id, callerId: run.callerId, type, idempotencyKey: `${type}-${randomUUID()}`, requestHash: sha256(randomUUID()), input };
}

async function harness(options: { runs?: number; browserLeaseSeconds?: number; faultOperationSeconds?: number; scenarioId?: string; expiresInMs?: number } = {}): Promise<Harness> {
  vi.useFakeTimers();
  const config: VoiceLabConfig = { ...testConfig(), browserLeaseSeconds: options.browserLeaseSeconds ?? 30, operationLeaseSeconds: 60, faultOperationSeconds: options.faultOperationSeconds ?? 300 };
  const ledger = new MemoryVoiceLabLedger("test");
  const driver = new PulseDriver();
  const logs: Array<Record<string, unknown>> = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => { logs.push(JSON.parse(line) as Record<string, unknown>); } });
  const worker = new VoiceLabWorker(WORKER_ID, ledger, config, audio, driver as unknown as VoiceBrowserDriver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), logger);
  const runs: RunRecord[] = [];
  for (let index = 0; index < (options.runs ?? 1); index += 1) {
    const run = testRun({
      scenarioId: options.scenarioId ?? "V-O01",
      expiresAt: new Date(Date.now() + (options.expiresInMs ?? 3_600_000)),
      capturePolicy: { rawAudio: false, screenshot: false, video: false, retentionHours: 24 },
    });
    await ledger.createRunWithOperation(run, newOperation(run, "start", { environment: run.environment }), { global: 10, caller: 10 });
    runs.push(run);
  }
  const h: Harness = {
    config, ledger, driver, worker, runs, logs, renewals: [], executing: [], iterations: [], samples: [],
    stall: { active: false, entered: [], open: () => undefined, promise: Promise.resolve() },
    running: null,
  };
  current = h;
  const heartbeat = ledger.heartbeatBrowserLease.bind(ledger);
  vi.spyOn(ledger, "heartbeatBrowserLease").mockImplementation(async (runId, workerId, epoch, seconds) => {
    const ok = await heartbeat(runId, workerId, epoch, seconds);
    h.renewals.push({ runId, epoch, at: Date.now(), ok });
    return ok;
  });
  const runOnce = worker.runOnce.bind(worker);
  vi.spyOn(worker, "runOnce").mockImplementation(async () => {
    const startedAt = Date.now();
    const worked = await runOnce();
    if (worked) h.iterations.push({ startedAt, returnedAt: Date.now() });
    return worked;
  });
  const markExecuting = ledger.markOperationExecuting.bind(ledger);
  vi.spyOn(ledger, "markOperationExecuting").mockImplementation(async (operationId, workerId, epoch) => {
    const executing = await markExecuting(operationId, workerId, epoch);
    h.executing.push({ operationId, at: Date.now() });
    return executing;
  });
  // A maintenance stage that does not answer, as retained recovery against a
  // hanging Gateway did in the #151 reproduction. It runs before the
  // active-lease step of every pass.
  const scheduleRetained = ledger.scheduleRetainedRecovery.bind(ledger);
  vi.spyOn(ledger, "scheduleRetainedRecovery").mockImplementation(async (limit) => {
    if (h.stall.active) {
      h.stall.entered.push(Date.now());
      while (h.stall.active) await h.stall.promise;
    }
    return scheduleRetained(limit);
  });
  return h;
}

function stallMaintenance(h: Harness): void {
  h.stall.active = true;
  h.stall.promise = new Promise((resolve) => { h.stall.open = resolve; });
}

function releaseMaintenance(h: Harness): number {
  h.stall.active = false;
  h.stall.open();
  return Date.now();
}

/** Advances the fake clock in steps, sampling every run's ledger lease after each step. */
async function advance(h: Harness, ms: number, step = 250): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed));
    for (const run of h.runs) {
      const lease = await h.ledger.getBrowserLease(run.id);
      h.samples.push({ runId: run.id, at: Date.now(), state: lease === null ? "absent" : lease.expiresAt.getTime() > Date.now() ? "live" : "expired" });
    }
  }
}

async function until(h: Harness, done: () => boolean, maxMs: number, step = 100): Promise<number> {
  const started = Date.now();
  while (!done() && Date.now() - started < maxMs) {
    await advance(h, step, step);
    await realTurn();
  }
  return Date.now() - started;
}

async function startWorker(h: Harness): Promise<void> {
  h.running = h.worker.run();
  await advance(h, 2_000);
  for (const run of h.runs) expect((await h.ledger.getRun(run.id))?.state).toBe("ready");
}

async function stopWorker(h: Harness): Promise<void> {
  h.worker.stop();
  releaseMaintenance(h);
  let stopped = false;
  void h.running?.then(() => { stopped = true; });
  await until(h, () => stopped, 120_000);
  expect(stopped).toBe(true);
}

function okRenewals(h: Harness, runId: string): number[] {
  return h.renewals.filter((call) => call.runId === runId && call.ok).map((call) => call.at);
}

function reads(h: Harness, runId: string, by?: "worker" | "driver"): number[] {
  return h.driver.reads.filter((read) => read.runId === runId && (by === undefined || read.by === by)).map((read) => read.at);
}

/** The longest interval inside [from, to] without one of `times`. */
function longestGap(times: number[], from: number, to: number): number {
  const points = [from, ...times.filter((at) => at > from && at < to).sort((a, b) => a - b), to];
  return Math.max(...points.slice(1).map((at, index) => at - points[index]!));
}

/** The loop iteration whose claimed operation held its run's turn at `at`. */
function holdAt(h: Harness, at: number): { startedAt: number; returnedAt: number } {
  const held = h.iterations.find((iteration) => iteration.startedAt <= at && iteration.returnedAt >= at);
  expect(held, "an operation held the run").toBeDefined();
  return held!;
}

/** When the run's terminal event was appended. */
async function terminalAt(h: Harness, runId: string, state: string): Promise<number> {
  const event = (await allEvents(h, runId)).find((candidate) => candidate.kind === `run.${state}`);
  expect(event, `run.${state} was appended`).toBeDefined();
  return event!.at.getTime();
}

function expiredSamples(h: Harness, runId: string, from: number, to: number): number[] {
  return h.samples.filter((sample) => sample.runId === runId && sample.at >= from && sample.at <= to && sample.state === "expired").map((sample) => sample.at);
}

async function allEvents(h: Harness, runId: string): Promise<Array<{ seq: number; kind: string; at: Date; payload: Record<string, unknown> }>> {
  const events: Array<{ seq: number; kind: string; at: Date; payload: Record<string, unknown> }> = [];
  for (let after = 0; ;) {
    const page = await h.ledger.listEvents(runId, after, 500);
    if (page.events.length === 0) return events;
    events.push(...page.events);
    after = page.events.at(-1)!.seq;
  }
}

async function persistedCensus(h: Harness, runId: string): Promise<{ ring: number[]; forwarded: number[] }> {
  const events = await allEvents(h, runId);
  const ring = events.filter((event) => event.kind === "harness.provider_frame_sent" || event.kind === "harness.input_frame_forwarded").map((event) => Number(event.payload.ring_seq));
  const forwarded = events.filter((event) => event.kind === "harness.input_frame_forwarded").map((event) => Number(event.payload.frame_seq));
  return { ring, forwarded };
}

/** No ring gap: every produced ring event and frame was persisted once, in order, and the page never overwrote an unread event. */
async function expectCompleteCensus(h: Harness, runId: string, minimumFrames: number): Promise<void> {
  const page = h.driver.pages.get(runId)!;
  const produced = page.produced();
  const { ring, forwarded } = await persistedCensus(h, runId);
  const firstGap = ring.findIndex((seq, index) => seq !== index);
  expect({ lost: page.lost, persisted: ring.length, firstGap }).toEqual({ lost: 0, persisted: produced, firstGap: -1 });
  expect(forwarded).toEqual(Array.from({ length: produced / 2 }, (_, index) => index));
  expect(produced / 2).toBeGreaterThanOrEqual(minimumFrames);
}

function errorLogs(h: Harness, message: string): Array<Record<string, unknown>> {
  return h.logs.filter((entry) => typeof entry.msg === "string" && entry.msg.includes(message));
}

const FULL_UTTERANCE_FRAMES = Math.floor(SPEECH_MS / 1_000 * FRAMES_PER_SECOND);

describe("#151 active-lease pulse: maintenance cannot starve a live run", () => {
  it("positive control: with healthy maintenance a 120 s utterance keeps its lease and a complete census", async () => {
    const h = await harness();
    const run = h.runs[0]!;
    await startWorker(h);
    const t0 = Date.now();
    h.driver.pages.get(run.id)!.startSpeech(SPEECH_MS);
    await advance(h, SPEECH_MS + 5_000);
    expect(expiredSamples(h, run.id, t0, Date.now())).toEqual([]);
    await expectCompleteCensus(h, run.id, FULL_UTTERANCE_FRAMES);
    expect(h.driver.overlaps).toBe(0);
    await stopWorker(h);
  }, 60_000);

  it("lease stall: maintenance stalled 125 s, the 30 s lease stays live and the census complete (pulse renews and drains)", async () => {
    const h = await harness();
    const run = h.runs[0]!;
    await startWorker(h);
    stallMaintenance(h);
    await advance(h, 500);
    expect(h.stall.entered.length).toBeGreaterThan(0);
    const t0 = Date.now();
    h.driver.pages.get(run.id)!.startSpeech(SPEECH_MS);
    await advance(h, SPEECH_MS + 5_000);
    const t1 = Date.now();
    expect(h.stall.active).toBe(true);
    expect(expiredSamples(h, run.id, t0, t1)).toEqual([]);
    expect(longestGap(okRenewals(h, run.id), t0, t1)).toBeLessThanOrEqual(5_000 + SLACK_MS);
    expect(longestGap(reads(h, run.id, "worker"), t0, t1)).toBeLessThanOrEqual(5_000 + SLACK_MS);
    await expectCompleteCensus(h, run.id, FULL_UTTERANCE_FRAMES);
    expect(h.driver.overlaps).toBe(0);
    expect((await h.ledger.getRun(run.id))?.state).toBe("ready");
    await stopWorker(h);
  }, 60_000);

  it("ring stall: with a 120 s lease and maintenance stalled 110 s the ring never overflows", async () => {
    const h = await harness({ browserLeaseSeconds: 120 });
    const run = h.runs[0]!;
    await startWorker(h);
    stallMaintenance(h);
    await advance(h, 500);
    const t0 = Date.now();
    h.driver.pages.get(run.id)!.startSpeech(SPEECH_MS);
    await advance(h, 110_000);
    releaseMaintenance(h);
    await advance(h, 15_000);
    expect(expiredSamples(h, run.id, t0, Date.now())).toEqual([]);
    await expectCompleteCensus(h, run.id, FULL_UTTERANCE_FRAMES);
    expect((await h.ledger.getRun(run.id))?.state).toBe("ready");
    await stopWorker(h);
  }, 60_000);

  it("pending operation: an operation queued during a 100 s stall is claimed within one maintenance pass after it and succeeds, never cancelled", async () => {
    const h = await harness();
    const run = h.runs[0]!;
    await startWorker(h);
    stallMaintenance(h);
    await advance(h, 500);
    h.driver.pages.get(run.id)!.startSpeech(SPEECH_MS);
    await advance(h, 20_000);
    const pending = newOperation(run, "force_socket_rotation", { expected_socket_epoch: 1 });
    await h.ledger.createOperation(pending);
    await advance(h, 80_000);
    expect((await h.ledger.getOperation(pending.id))?.state).toBe("queued");
    const releasedAt = releaseMaintenance(h);
    await advance(h, 3_000, 50);
    const claim = h.executing.find((entry) => entry.operationId === pending.id);
    expect(claim, "the queued operation was claimed after the stall").toBeDefined();
    expect(claim!.at - releasedAt).toBeLessThanOrEqual(h.config.workerPollMs + 250);
    expect((await h.ledger.getOperation(pending.id))?.state).toBe("succeeded");
    expect((await h.ledger.getRun(run.id))?.state).not.toMatch(/aborted|failed|cancelled/);
    await advance(h, 25_000);
    await expectCompleteCensus(h, run.id, FULL_UTTERANCE_FRAMES);
    await stopWorker(h);
  }, 60_000);

  it("maintenance stalled indefinitely: the pulse keeps renewing and draining every run that is not busy", async () => {
    const h = await harness({ runs: 2 });
    const [a, b] = h.runs as [RunRecord, RunRecord];
    await startWorker(h);
    stallMaintenance(h);
    await advance(h, 500);
    const t0 = Date.now();
    h.driver.pages.get(a.id)!.startSpeech(SPEECH_MS);
    await advance(h, 60_000);
    h.driver.pages.get(b.id)!.startSpeech(SPEECH_MS);
    await advance(h, 540_000, 1_000);
    const t1 = Date.now();
    expect(h.stall.active).toBe(true);
    for (const run of [a, b]) {
      expect(expiredSamples(h, run.id, t0, t1)).toEqual([]);
      expect(longestGap(okRenewals(h, run.id), t0, t1)).toBeLessThanOrEqual(5_000 + SLACK_MS);
      expect(longestGap(reads(h, run.id, "worker"), t0, t1)).toBeLessThanOrEqual(5_000 + SLACK_MS);
      await expectCompleteCensus(h, run.id, FULL_UTTERANCE_FRAMES);
    }
    expect(h.driver.overlaps).toBe(0);
    await stopWorker(h);
  }, 120_000);
});

describe("#151 one serialization point per run", () => {
  it("head of line: an operation holds run A for 120 s while the pulse renews and drains run B within every interval, and a maintenance pass skips A and still reaches B", async () => {
    const h = await harness({ runs: 2 });
    const [a, b] = h.runs as [RunRecord, RunRecord];
    await startWorker(h);
    h.driver.drainLatencyMs = 50;
    h.driver.rotateHoldMs.set(a.id, SPEECH_MS);
    h.driver.pages.get(a.id)!.startSpeech(SPEECH_MS);
    h.driver.pages.get(b.id)!.startSpeech(SPEECH_MS);
    const rotation = newOperation(a, "force_socket_rotation", { expected_socket_epoch: 1 });
    await h.ledger.createOperation(rotation);
    await advance(h, 1_000, 50);
    const claimed = h.executing.find((entry) => entry.operationId === rotation.id);
    expect(claimed).toBeDefined();
    const t0 = claimed!.at;

    await advance(h, 30_000);
    const passAt = Date.now();
    let passDone = false;
    void h.worker.maintainSessions().finally(() => { passDone = true; });
    await advance(h, 1_000, 50);
    expect(passDone, "a maintenance pass never waits on run A's turn").toBe(true);
    expect(h.driver.continueCalls.filter((call) => call.runId === b.id && call.at >= passAt).length).toBeGreaterThan(0);

    await until(h, () => !h.driver.inOperation.has(a.id), SPEECH_MS);
    await advance(h, 2_000);
    const t1 = Date.now();
    expect((await h.ledger.getOperation(rotation.id))?.state).toBe("succeeded");
    expect(t1 - t0).toBeGreaterThanOrEqual(SPEECH_MS);
    // Run A's holder renewed it and drained it for the whole hold; nothing else drained it.
    expect(h.driver.continueCalls.filter((call) => call.runId === a.id && call.at > t0 && call.at < t0 + SPEECH_MS)).toEqual([]);
    expect(h.driver.foreignWhileHeld.filter((call) => call.runId === a.id)).toEqual([]);
    expect(expiredSamples(h, a.id, t0, t1)).toEqual([]);
    expect(longestGap(okRenewals(h, a.id), t0, t0 + SPEECH_MS)).toBeLessThanOrEqual(5_000 + SLACK_MS);
    expect(longestGap(reads(h, a.id, "driver"), t0 + 100, t0 + SPEECH_MS)).toBeLessThanOrEqual(200);
    // Run B: the pulse alone (the loop is inside A's operation) within every interval.
    expect(expiredSamples(h, b.id, t0, t1)).toEqual([]);
    expect(longestGap(okRenewals(h, b.id), t0, t0 + SPEECH_MS)).toBeLessThanOrEqual(5_000 + SLACK_MS);
    expect(longestGap(reads(h, b.id, "worker"), t0, t0 + SPEECH_MS)).toBeLessThanOrEqual(5_000 + SLACK_MS);
    expect(h.driver.overlaps).toBe(0);
    await advance(h, 5_000);
    await expectCompleteCensus(h, a.id, FULL_UTTERANCE_FRAMES);
    await expectCompleteCensus(h, b.id, FULL_UTTERANCE_FRAMES);
    await stopWorker(h);
  }, 120_000);

  it("close() while an operation holds its run: stop, settle and cleanup never wait on the turn; afterwards no timer, handle or ledger call remains", async () => {
    const h = await harness({ runs: 2 });
    const [a, b] = h.runs as [RunRecord, RunRecord];
    await startWorker(h);
    h.driver.rotateHoldMs.set(a.id, Number.POSITIVE_INFINITY);
    h.driver.pages.get(a.id)!.startSpeech(SPEECH_MS);
    h.driver.pages.get(b.id)!.startSpeech(SPEECH_MS);
    const rotation = newOperation(a, "force_socket_rotation", { expected_socket_epoch: 1 });
    await h.ledger.createOperation(rotation);
    await advance(h, 20_000);
    expect(h.driver.inOperation.has(a.id)).toBe(true);

    const closeAt = Date.now();
    let closed = false;
    let closeError: unknown = null;
    void h.worker.close().then(() => { closed = true; }, (error: unknown) => { closeError = error; closed = true; });
    await until(h, () => closed, 60_000, 50);
    expect(closed).toBe(true);
    expect(closeError).toBeNull();
    const cancelA = h.driver.cancelCalls.find((call) => call.runId === a.id);
    expect(cancelA, "the held operation was cancelled by close()").toBeDefined();
    expect(cancelA!.at - closeAt, "settle never waited on run A's turn").toBeLessThan(1_000);
    expect(errorLogs(h, "active lease pulse work did not settle")).toEqual([]);
    expect((await h.ledger.getOperation(rotation.id))?.state).toMatch(/failed|timed_out|cancelled/);

    await h.running;
    const renewalsAfterClose = h.renewals.length;
    const readsAfterClose = h.driver.reads.length;
    const continuesAfterClose = h.driver.continueCalls.length;
    expect(vi.getTimerCount(), "no timer survives close()").toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.renewals.length).toBe(renewalsAfterClose);
    expect(h.driver.reads.length).toBe(readsAfterClose);
    expect(h.driver.continueCalls.length).toBe(continuesAfterClose);
  }, 120_000);

  it("a pulse capture read that outlives its lease (released while the read is held) writes nothing, and that lease is never renewed again", async () => {
    const h = await harness();
    const run = h.runs[0]!;
    await startWorker(h);
    stallMaintenance(h);
    await advance(h, 500);
    const epoch = (await h.ledger.getBrowserLease(run.id))!.leaseEpoch;
    h.driver.pages.get(run.id)!.startSpeech(SPEECH_MS);
    await advance(h, 10_000);
    let entered = false;
    let release!: () => void;
    h.driver.hold = { runId: run.id, entered: () => { entered = true; }, released: new Promise((resolve) => { release = resolve; }) };
    await until(h, () => entered, 10_000, 50);
    expect(entered, "a pulse read is held").toBe(true);

    // While the read is held, the exact lease is CAS-released: epoch N no longer owns the run.
    expect(await h.ledger.releaseBrowserLease(run.id, WORKER_ID, epoch)).toBe(true);
    expect(await h.ledger.getBrowserLease(run.id)).toBeNull();
    const releasedAt = Date.now();
    const before = await persistedCensus(h, run.id);
    const cursorBefore = (await h.ledger.getRun(run.id))!.latestCursor;
    release();
    await advance(h, 20_000);

    const after = await persistedCensus(h, run.id);
    expect(after.ring.length, "nothing read under the released lease was written").toBe(before.ring.length);
    const events = await allEvents(h, run.id);
    expect(events.filter((event) => event.seq > cursorBefore && event.kind.startsWith("harness."))).toEqual([]);
    const refusals = h.renewals.filter((call) => call.runId === run.id && call.epoch === epoch && !call.ok);
    expect(h.renewals.filter((call) => call.runId === run.id && call.ok && call.at >= releasedAt)).toEqual([]);
    expect(refusals.length).toBeLessThanOrEqual(1);
    if (refusals[0]) expect(h.renewals.filter((call) => call.runId === run.id && call.at > refusals[0]!.at)).toEqual([]);
    expect(h.driver.reads.filter((read) => read.runId === run.id && read.at > releasedAt + 1_000)).toEqual([]);
    expect((await h.ledger.getRun(run.id))?.state).toBe("aborted_driver_restart");
    await stopWorker(h);
  }, 60_000);
});

describe("#151 a refused lease is never renewed again", () => {
  it("free run: one refusal ends the pulse and takes the existing lease-loss handling once", async () => {
    const h = await harness();
    const run = h.runs[0]!;
    await startWorker(h);
    stallMaintenance(h);
    await advance(h, 500);
    h.driver.pages.get(run.id)!.startSpeech(SPEECH_MS);
    await advance(h, 20_000);
    const ledgerHeartbeat = MemoryVoiceLabLedger.prototype.heartbeatBrowserLease;
    let refused = false;
    // The ledger refuses once, then would accept again: nothing may ask it again.
    vi.mocked(h.ledger.heartbeatBrowserLease).mockImplementation(async (runId, workerId, epoch, seconds) => {
      const ok = refused ? await ledgerHeartbeat.call(h.ledger, runId, workerId, epoch, seconds) : false;
      refused = true;
      h.renewals.push({ runId, epoch, at: Date.now(), ok });
      return ok;
    });
    await advance(h, 30_000);
    const refusal = h.renewals.find((call) => call.runId === run.id && !call.ok);
    expect(refusal).toBeDefined();
    expect(h.renewals.filter((call) => call.runId === run.id && call.at > refusal!.at)).toEqual([]);
    expect(h.driver.reads.filter((read) => read.runId === run.id && read.at > refusal!.at + 1_000)).toEqual([]);
    const terminal = await h.ledger.getRun(run.id);
    expect(terminal).toMatchObject({ state: "aborted_driver_restart", terminalError: { code: "BROWSER_SESSION_LOST" } });
    await stopWorker(h);
  }, 60_000);

  it("busy run: a refusal while an operation holds the run is recorded once and neither the pulse nor the operation renews again", async () => {
    const h = await harness();
    const run = h.runs[0]!;
    await startWorker(h);
    h.driver.rotateHoldMs.set(run.id, 60_000);
    h.driver.pages.get(run.id)!.startSpeech(SPEECH_MS);
    const rotation = newOperation(run, "force_socket_rotation", { expected_socket_epoch: 1 });
    await h.ledger.createOperation(rotation);
    await advance(h, 20_000);
    expect(h.driver.inOperation.has(run.id)).toBe(true);
    const ledgerHeartbeat = MemoryVoiceLabLedger.prototype.heartbeatBrowserLease;
    let refused = false;
    vi.mocked(h.ledger.heartbeatBrowserLease).mockImplementation(async (runId, workerId, epoch, seconds) => {
      const ok = refused ? await ledgerHeartbeat.call(h.ledger, runId, workerId, epoch, seconds) : false;
      refused = true;
      h.renewals.push({ runId, epoch, at: Date.now(), ok });
      return ok;
    });
    await advance(h, 30_000);
    const refusal = h.renewals.find((call) => call.runId === run.id && !call.ok);
    expect(refusal).toBeDefined();
    expect(h.renewals.filter((call) => call.runId === run.id && call.at > refusal!.at)).toEqual([]);
    await stopWorker(h);
  }, 60_000);
});

describe("#151 every holder of a run renews and drains it while it holds the turn", () => {
  it("schedule, then the settlement wait and its error path: drains every 100 ms while waiting, and the lease stays live through a slow terminal cleanup", async () => {
    const h = await harness({ browserLeaseSeconds: 10 });
    const run = h.runs[0]!;
    await startWorker(h);
    const input = { fixture_id: "a02_short_command", _admission: { duration_ms: SPEECH_MS, bytes: 8_000_000 } };
    const first = newOperation(run, "speak", input);
    await h.ledger.createOperation(first);
    await advance(h, 1_000, 50);
    expect((await h.ledger.getOperation(first.id))?.state).toBe("succeeded");
    expect(h.driver.foreignWhileHeld).toEqual([]);
    h.driver.recoverDelayMs = 40_000;
    const second = newOperation(run, "speak", input);
    await h.ledger.createOperation(second);
    await advance(h, 1_000, 50);
    const claim = h.executing.find((entry) => entry.operationId === second.id);
    expect(claim).toBeDefined();
    const t0 = claim!.at;
    let state: string | undefined;
    while (state !== "failed" && Date.now() - t0 < 120_000) {
      await advance(h, 500);
      state = (await h.ledger.getOperation(second.id))?.state;
    }
    expect((await h.ledger.getOperation(second.id))?.error?.code).toBe("INPUT_OPERATION_SETTLEMENT_PENDING");
    await advance(h, 60_000);
    const terminal = await h.ledger.getRun(run.id);
    expect(terminal?.state).toBe("failed_harness");
    // The settlement wait drained every ~100 ms while it held the run.
    expect(longestGap(reads(h, run.id, "worker"), t0 + 500, t0 + 14_500)).toBeLessThanOrEqual(300);
    // The operation held the run through its 15 s wait and the 40 s terminal cleanup, renewing it throughout.
    const held = holdAt(h, t0);
    expect(held.returnedAt - t0).toBeGreaterThanOrEqual(55_000);
    expect(expiredSamples(h, run.id, t0, held.returnedAt)).toEqual([]);
    expect(longestGap(okRenewals(h, run.id), t0, held.returnedAt)).toBeLessThanOrEqual(3_334 + SLACK_MS);
    expect(h.driver.overlaps).toBe(0);
    await expectCompleteCensus(h, run.id, 1);
    await stopWorker(h);
  }, 120_000);

  it("end: the operation renews through the read-free grant refresh and finalization wait, and drains after its click", async () => {
    const h = await harness({ browserLeaseSeconds: 10 });
    const run = h.runs[0]!;
    await startWorker(h);
    h.driver.endHoldMs = 25_000;
    h.driver.pages.get(run.id)!.startSpeech(SPEECH_MS);
    await advance(h, 10_000);
    const ending = newOperation(run, "end");
    await h.ledger.createOperation(ending);
    await advance(h, 1_000, 50);
    const t0 = h.executing.find((entry) => entry.operationId === ending.id)!.at;
    await advance(h, 30_000);
    expect(h.driver.inOperation.has(run.id)).toBe(false);
    expect(h.driver.foreignWhileHeld).toEqual([]);
    expect(expiredSamples(h, run.id, t0, t0 + 25_000)).toEqual([]);
    expect(longestGap(okRenewals(h, run.id), t0, t0 + 25_000)).toBeLessThanOrEqual(3_334 + SLACK_MS);
    await expectCompleteCensus(h, run.id, 1);
    await stopWorker(h);
  }, 60_000);

  it("cancellation: an operation timed out and cancelled keeps its lease live through a slow terminal cleanup", async () => {
    const h = await harness({ browserLeaseSeconds: 10, faultOperationSeconds: 35 });
    const run = h.runs[0]!;
    await startWorker(h);
    h.driver.rotateHoldMs.set(run.id, Number.POSITIVE_INFINITY);
    h.driver.recoverDelayMs = 40_000;
    h.driver.pages.get(run.id)!.startSpeech(SPEECH_MS);
    const rotation = newOperation(run, "force_socket_rotation", { expected_socket_epoch: 1 });
    await h.ledger.createOperation(rotation);
    await advance(h, 1_000, 50);
    const t0 = h.executing.find((entry) => entry.operationId === rotation.id)!.at;
    await advance(h, 100_000);
    const cancelled = h.driver.cancelCalls.find((call) => call.runId === run.id);
    expect(cancelled, "the deadline cancelled the operation").toBeDefined();
    expect(cancelled!.at - t0).toBeGreaterThanOrEqual(35_000);
    expect((await h.ledger.getOperation(rotation.id))?.state).toBe("timed_out");
    // After its cancellation the operation still held the run through the 40 s recovery, and the lease never lapsed.
    const held = holdAt(h, t0);
    expect(held.returnedAt - cancelled!.at).toBeGreaterThanOrEqual(40_000);
    expect(expiredSamples(h, run.id, t0, held.returnedAt)).toEqual([]);
    expect(longestGap(okRenewals(h, run.id), cancelled!.at, held.returnedAt)).toBeLessThanOrEqual(3_334 + SLACK_MS);
    await stopWorker(h);
  }, 120_000);

  it("stop: close() cancels the held operation and, with the pulse off, the operation itself keeps the lease live through its cleanup", async () => {
    const h = await harness({ browserLeaseSeconds: 10 });
    const run = h.runs[0]!;
    await startWorker(h);
    h.driver.rotateHoldMs.set(run.id, Number.POSITIVE_INFINITY);
    h.driver.recoverDelayMs = 20_000;
    h.driver.pages.get(run.id)!.startSpeech(SPEECH_MS);
    const rotation = newOperation(run, "force_socket_rotation", { expected_socket_epoch: 1 });
    await h.ledger.createOperation(rotation);
    await advance(h, 5_000);
    expect(h.driver.inOperation.has(run.id)).toBe(true);
    const closeAt = Date.now();
    let closed = false;
    void h.worker.close().finally(() => { closed = true; });
    await until(h, () => closed, 90_000, 100);
    expect(closed).toBe(true);
    expect(h.driver.cancelCalls.find((call) => call.runId === run.id && call.at - closeAt < 1_000)).toBeDefined();
    expect((await h.ledger.getOperation(rotation.id))?.state).toBe("failed");
    // The cancelled operation held its run through a 20 s terminal recovery, then released it.
    const held = h.iterations.find((iteration) => iteration.startedAt < closeAt && iteration.returnedAt > closeAt)!;
    expect(held).toBeDefined();
    expect(held.returnedAt - closeAt).toBeGreaterThanOrEqual(20_000);
    expect(expiredSamples(h, run.id, closeAt, held.returnedAt)).toEqual([]);
    expect(longestGap(okRenewals(h, run.id), closeAt, held.returnedAt)).toBeLessThanOrEqual(3_334 + SLACK_MS);
  }, 120_000);

  it("maintenance holder: terminalizing an expired live run with a slow recovery keeps the lease live while maintenance holds the run", async () => {
    const h = await harness({ browserLeaseSeconds: 10, expiresInMs: 30_000 });
    const run = h.runs[0]!;
    await startWorker(h);
    h.driver.recoverDelayMs = 40_000;
    h.driver.pages.get(run.id)!.startSpeech(SPEECH_MS);
    await advance(h, 90_000);
    const terminal = await h.ledger.getRun(run.id);
    expect(terminal?.state).toBe("expired");
    // Maintenance held the run from the TTL to the terminal transition, through the 40 s recovery; the lease never lapsed.
    const expiredRunAt = terminal!.expiresAt.getTime();
    const terminalizedAt = await terminalAt(h, run.id, "expired");
    expect(terminalizedAt - expiredRunAt).toBeGreaterThanOrEqual(40_000);
    expect(expiredSamples(h, run.id, expiredRunAt, terminalizedAt)).toEqual([]);
    expect(longestGap(okRenewals(h, run.id), expiredRunAt, terminalizedAt)).toBeLessThanOrEqual(3_334 + SLACK_MS);
    await expectCompleteCensus(h, run.id, 1);
    await stopWorker(h);
  }, 120_000);
});

function signEnvelope(unsigned: Record<string, unknown>): Record<string, unknown> {
  const key = createPrivateKey({ key: Buffer.from(DEPLOYMENT_CONTROL_PRIVATE_KEY, "base64"), format: "der", type: "pkcs8" });
  return { ...unsigned, signature: sign(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), key).toString("base64url") };
}

/** The exact V-D02 source chain of d02-worker-shutdown.test.ts: local intent, Gateway freeze, signed command, global dispatch claim. */
async function armD02Shutdown(h: Harness, run: RunRecord, leaseEpoch: number): Promise<void> {
  const { config, ledger } = h;
  const binding = (await ledger.listEvents(run.id, 0, 500)).events.find((event) => event.kind === "harness.browser_context_bound")!;
  const gateway = new D02GatewayClient(config, async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ frozen: true, idempotent_replay: false, freeze_request_sha256: canonicalRequestHash(body) }), { status: 202 });
  });
  const service = new VoiceLabService(ledger, config, async () => [], undefined, undefined, gateway);
  const caller: AuthenticatedCaller = {
    subject: config.attestationAuthorities.deployment_control.subject,
    scopes: new Set(["voice_lab:attest", "voice_lab:attest:deployment_control"]),
    authorizationKind: "attestation",
  };
  const authority = config.attestationAuthorities.deployment_control;
  const terminationRequestId = randomUUID();
  const actionRequestSha256 = sha256(`render-action:${terminationRequestId}`);
  const evidence = {
    kind: "d02_browser_worker_termination_command",
    authority: "deployment_control",
    termination_request_id: terminationRequestId,
    run_id_sha256: sha256(run.id),
    cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
    worker_service_id_sha256: sha256("srv-voice-lab-worker"),
    provider_session_id_sha256: sha256(run.providerSessionId!),
    provider_admission_id_sha256: sha256("provider-admission-d02-pulse"),
    provider_connection_epoch: run.providerEpoch!,
    frozen_provider_connection_epochs: [run.providerEpoch!],
    browser_worker_id_sha256: sha256(WORKER_ID),
    browser_lease_epoch: leaseEpoch,
    browser_context_id_sha256: String(binding.payload.browser_context_id_sha256),
    before_worker_deploy_id_sha256: sha256("worker-deploy-before"),
    before_worker_instance_set_sha256: sha256("worker-instance-set-before"),
    before_worker_owner_instance_id_sha256: sha256(WORKER_ID),
    before_worker_owner_membership_count: 1,
    render_action_request_sha256: actionRequestSha256,
    requested_at: new Date().toISOString(),
    target_service: "sophia-voice-lab-worker",
    termination_mode: "render_service_restart_one_shot",
    worker_mutation_authorized: true,
    product_mutation_authorized: false,
    one_shot: true,
  };
  const attestationId = randomUUID();
  const signed = signEnvelope({
    schema: "sophia_voice_lab_external_attestation_v1",
    attestation_id: attestationId,
    run_id: run.id,
    test_run_id_sha256: sha256(run.testRunId),
    cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
    scenario_id: run.scenarioId,
    scenario_version: run.scenarioVersion,
    environment: run.environment,
    expected_deployment: run.target.expectedDeployment,
    issuer: authority.issuer,
    audience: "sophia-voice-lab-attestation",
    authority_key_id: authority.keyId,
    jti: attestationId,
    nonce: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    signature_algorithm: "ed25519-sha256-canonical-request-v1",
    evidence,
  });
  const attached = await service.attachExternalAttestation(caller, signed, { argumentHash: canonicalRequestHash(signed), requestIdHash: sha256(randomUUID()) });
  const command = (await ledger.listEvents(run.id, 0, 500)).events.find((event) => event.kind === "external.attestation.d02_browser_worker_termination_command")!;
  await service.claimD02RenderWorkerDispatch(caller, {
    schema: "sophia_voice_lab_d02_render_worker_dispatch_claim_request_v1",
    run_id: run.id,
    termination_request_id: terminationRequestId,
    command_attestation_id: String(signed.attestation_id),
    command_content_sha256: String(attached.data.content_sha256),
    command_event_seq: Number(attached.data.event_seq),
    worker_service_id_sha256: evidence.worker_service_id_sha256,
    action_request_sha256: actionRequestSha256,
    dispatch_attempt_id: randomUUID(),
    requested_at: new Date(command.at.getTime() + 1).toISOString(),
  });
}

describe("#151 D02: the pulse preserves ownership and never touches the frozen app", () => {
  it("an armed D02 run quiesced by maintenance through a slow product cleanup keeps its exact lease live while maintenance holds the run, and the pulse neither drains nor continues it", async () => {
    const h = await harness({ browserLeaseSeconds: 10, scenarioId: "V-D02", expiresInMs: 600_000 });
    const run = h.runs[0]!;
    await startWorker(h);
    const started = (await h.ledger.getRun(run.id))!;
    const ready = await h.ledger.updateRun(run.id, started.version, { providerSessionId: "provider-session-d02-pulse", providerEpoch: 7 });
    const leaseEpoch = (await h.ledger.getBrowserLease(run.id))!.leaseEpoch;
    h.driver.quiesceDelayMs = 14_000;
    h.driver.pages.get(run.id)!.startSpeech(SPEECH_MS);
    await advance(h, 10_000);
    await armD02Shutdown(h, ready, leaseEpoch);
    const armedAt = Date.now();
    const readsBefore = reads(h, run.id, "worker").length;
    await advance(h, 40_000);
    const terminal = await h.ledger.getRun(run.id);
    expect(terminal).toMatchObject({ state: "aborted_driver_restart", terminalError: { code: "BROWSER_SESSION_LOST" } });
    const events = (await allEvents(h, run.id));
    const intent = events.find((event) => event.kind === "product.d02_browser_worker_termination_freeze_pending")!;
    const observed = events.filter((event) => event.kind === "durability.browser_worker_shutdown_observed");
    expect(observed).toHaveLength(1);
    expect(await h.ledger.getBrowserLease(run.id)).toBeNull();
    // From the local freeze intent on, nothing read the frozen page or continued its session.
    expect(intent).toBeDefined();
    expect(reads(h, run.id, "worker").length).toBe(readsBefore);
    expect(h.driver.continueCalls.filter((call) => call.runId === run.id && call.at >= armedAt)).toEqual([]);
    // Until the source path released it, the exact lease never lapsed, through the 14 s product cleanup with a 10 s lease.
    expect(expiredSamples(h, run.id, armedAt, Date.now())).toEqual([]);
    await stopWorker(h);
  }, 120_000);
});

const LABELLED_CAPTURE = "root.capture.from_old_epoch";

/**
 * Holds the ledger write that carries the labelled capture event, whatever
 * method the worker uses for it, and snapshots the run's cursor and the
 * labelled rows right before the hold and right after the write returned.
 */
function holdLabelledCaptureWrite(h: Harness) {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let resume!: () => void;
  const resumed = new Promise<void>((resolve) => { resume = resolve; });
  const snapshot = { method: "", cursorBefore: -1, cursorAfter: -1, labelledAfter: -1, returned: false };
  const carries = (args: unknown[]) => args.some((arg) => arg === LABELLED_CAPTURE || (Array.isArray(arg) && arg.some((input) => (input as { kind?: string } | null)?.kind === LABELLED_CAPTURE)));
  const ledger = h.ledger as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const method of ["appendEvent", "appendEvents", "appendLeaseBoundEvents"]) {
    const original = ledger[method];
    if (typeof original !== "function") continue;
    vi.spyOn(ledger, method).mockImplementation(async (...args: unknown[]) => {
      if (!carries(args)) return original.apply(h.ledger, args);
      snapshot.method = method;
      snapshot.cursorBefore = (await h.ledger.getRun(String(args[0])))!.latestCursor;
      enter();
      await resumed;
      try { return await original.apply(h.ledger, args); }
      finally {
        snapshot.cursorAfter = (await h.ledger.getRun(String(args[0])))!.latestCursor;
        snapshot.labelledAfter = (await allEvents(h, String(args[0]))).filter((event) => event.kind === LABELLED_CAPTURE).length;
        snapshot.returned = true;
      }
    });
  }
  return { entered, resume, snapshot };
}

describe("#151 lease-bound capture persistence is atomic with the exact lease (root's interleaving)", () => {
  async function readyWithoutLoop(): Promise<{ h: Harness; run: RunRecord; epoch: number }> {
    const h = await harness();
    const run = h.runs[0]!;
    const started = h.worker.runOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await started).toBe(true);
    expect((await h.ledger.getRun(run.id))?.state).toBe("ready");
    return { h, run, epoch: (await h.ledger.getBrowserLease(run.id))!.leaseEpoch };
  }

  async function heldMaintenanceCapture(h: Harness, run: RunRecord) {
    h.driver.extra.set(run.id, [{ kind: LABELLED_CAPTURE, source: "browser", payload: { labelled: true }, dedupeKey: `labelled:${run.id}` }]);
    const gate = holdLabelledCaptureWrite(h);
    let settled = false;
    const pass = h.worker.maintainSessions().catch(() => undefined).finally(() => { settled = true; });
    let entered = false;
    void gate.entered.then(() => { entered = true; });
    for (let step = 0; step < 200 && !entered; step += 1) await vi.advanceTimersByTimeAsync(10);
    expect(entered, "maintenance reached the labelled capture write after renewing the lease").toBe(true);
    return { gate, finish: async () => { for (let step = 0; step < 2_000 && !settled; step += 1) await vi.advanceTimersByTimeAsync(10); await pass; } };
  }

  it("released: the exact lease is CAS-released while the capture write is held; the write lands nothing and moves no cursor", async () => {
    const { h, run, epoch } = await readyWithoutLoop();
    const { gate, finish } = await heldMaintenanceCapture(h, run);
    expect(await h.ledger.releaseBrowserLease(run.id, WORKER_ID, epoch)).toBe(true);
    expect(await h.ledger.getBrowserLease(run.id)).toBeNull();
    gate.resume();
    await finish();
    expect(gate.snapshot.returned).toBe(true);
    expect({ cursor: gate.snapshot.cursorAfter, labelled: gate.snapshot.labelledAfter }).toEqual({ cursor: gate.snapshot.cursorBefore, labelled: 0 });
    expect((await allEvents(h, run.id)).filter((event) => event.kind === LABELLED_CAPTURE)).toEqual([]);
  }, 60_000);

  it("expired: the lease expires while the capture write is held; the write lands nothing and moves no cursor", async () => {
    const { h, run } = await readyWithoutLoop();
    const { gate, finish } = await heldMaintenanceCapture(h, run);
    vi.setSystemTime(new Date(Date.now() + (h.config.browserLeaseSeconds + 1) * 1_000));
    const lease = await h.ledger.getBrowserLease(run.id);
    expect(lease!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    gate.resume();
    await finish();
    expect(gate.snapshot.returned).toBe(true);
    expect({ cursor: gate.snapshot.cursorAfter, labelled: gate.snapshot.labelledAfter }).toEqual({ cursor: gate.snapshot.cursorBefore, labelled: 0 });
    expect((await allEvents(h, run.id)).filter((event) => event.kind === LABELLED_CAPTURE)).toEqual([]);
  }, 60_000);

  it.each([
    ["JOIN_CORRELATION_CONFLICT", { canonicalSessionId: "session-of-record" }, { kind: "session.credentials_received", payload: { sessionId: "session-conflicting" } }],
    ["PROVIDER_EPOCH_REGRESSION", { providerEpoch: 7 }, { kind: "provider.connection_epoch", payload: { receipt: { providerConnectionEpoch: 3 } } }],
  ] as const)("%s from a lease-bound drain: the receipt that conflicts stays durable as evidence, no join is applied, and the run fails with it", async (code, runPatch, receipt) => {
    const { h, run } = await readyWithoutLoop();
    const ready = (await h.ledger.getRun(run.id))!;
    const before = await h.ledger.updateRun(run.id, ready.version, runPatch);
    h.driver.extra.set(run.id, [{ kind: receipt.kind, source: "browser", payload: receipt.payload, dedupeKey: `conflict:${run.id}` }]);
    const pass = h.worker.maintainSessions().catch(() => undefined);
    for (let step = 0; step < 500; step += 1) await vi.advanceTimersByTimeAsync(10);
    await pass;
    const events = await allEvents(h, run.id);
    expect(events.filter((event) => event.dedupeKey === `conflict:${run.id}`)).toHaveLength(1);
    const terminal = (await h.ledger.getRun(run.id))!;
    expect(terminal.terminalError?.code).toBe(code);
    expect({ canonicalSessionId: terminal.canonicalSessionId, providerEpoch: terminal.providerEpoch }).toEqual({ canonicalSessionId: before.canonicalSessionId, providerEpoch: before.providerEpoch });
  }, 60_000);

  it("control: with the lease live the held capture write commits the labelled event once", async () => {
    const { h, run } = await readyWithoutLoop();
    const { gate, finish } = await heldMaintenanceCapture(h, run);
    gate.resume();
    await finish();
    expect(gate.snapshot.labelledAfter).toBe(1);
    expect(gate.snapshot.cursorAfter).toBe(gate.snapshot.cursorBefore + 1);
  }, 60_000);
});

describe("#151 review: a claimed operation that waits for its run's turn", () => {
  it("waits with its deadline and execution heartbeat not started; past its operation lease no other worker can take a non-start, non-end operation, and it executes exactly once", async () => {
    const h = await harness();
    const run = h.runs[0]!;
    await startWorker(h);
    h.driver.pages.get(run.id)!.startSpeech(SPEECH_MS);
    let entered = false;
    let release!: () => void;
    h.driver.hold = { runId: run.id, entered: () => { entered = true; }, released: new Promise((resolve) => { release = resolve; }) };
    await until(h, () => entered, 10_000, 50);
    const rotation = newOperation(run, "force_socket_rotation", { expected_socket_epoch: 1 });
    await h.ledger.createOperation(rotation);
    await advance(h, 1_000, 50);
    const waiting = (await h.ledger.getOperation(rotation.id))!;
    expect(waiting.state).toBe("leased");
    expect(waiting.leaseOwner).toBe(WORKER_ID);
    expect(h.executing.filter((entry) => entry.operationId === rotation.id)).toEqual([]);
    await advance(h, 70_000);
    expect((await h.ledger.getOperation(rotation.id))!.leaseExpiresAt!.getTime()).toBeLessThan(Date.now());
    expect(h.executing.filter((entry) => entry.operationId === rotation.id)).toEqual([]);
    expect(await h.ledger.claimNextOperation("other-worker", 60)).toBeNull();
    release();
    await advance(h, 3_000, 50);
    expect(h.executing.filter((entry) => entry.operationId === rotation.id)).toHaveLength(1);
    expect((await h.ledger.getOperation(rotation.id))).toMatchObject({ state: "succeeded", attemptCount: 1 });
    await stopWorker(h);
  }, 60_000);

  it("an end operation of an ending run, claimable by any worker, taken over after its lease while it waited: the waiting worker never executes it (its claim epoch is fenced)", async () => {
    const h = await harness();
    const run = h.runs[0]!;
    await startWorker(h);
    const ready = (await h.ledger.getRun(run.id))!;
    await h.ledger.updateRun(run.id, ready.version, { state: "ending" });
    let entered = false;
    let release!: () => void;
    h.driver.hold = { runId: run.id, entered: () => { entered = true; }, released: new Promise((resolve) => { release = resolve; }) };
    await until(h, () => entered, 10_000, 50);
    const ending = newOperation(run, "end");
    await h.ledger.createOperation(ending);
    await advance(h, 1_000, 50);
    expect((await h.ledger.getOperation(ending.id))!.leaseOwner).toBe(WORKER_ID);
    await advance(h, 70_000);
    const takeover = await h.ledger.claimNextOperation("other-worker", 60);
    expect(takeover?.operation.id).toBe(ending.id);
    const endCalls = vi.spyOn(h.driver, "end");
    release();
    await advance(h, 3_000, 50);
    expect(h.executing.filter((entry) => entry.operationId === ending.id)).toEqual([]);
    expect(endCalls).not.toHaveBeenCalled();
    expect((await h.ledger.getOperation(ending.id))).toMatchObject({ state: "leased", leaseOwner: "other-worker" });
    await stopWorker(h);
  }, 60_000);
});
