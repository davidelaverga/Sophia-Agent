import { randomUUID } from "node:crypto";

import pino from "pino";
import { expect, it } from "vitest";

import { AudioResolver } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import type { RunRecord } from "../src/domain.js";
import type { VoiceLabLedger } from "../src/ledger.js";
import { CapabilityCodec, sha256 } from "../src/security.js";
import { VoiceLabWorker } from "../src/worker.js";
import { testConfig, testRun } from "./helpers.js";

/**
 * #151 (root's P3 on ba2f81c0): the capture join rules are looked up by the
 * captured event's kind, which the browser supplies. A kind that is no join
 * rule, including every member Object.prototype carries (`__proto__`,
 * `constructor`, `toString`, `hasOwnProperty`, `valueOf`), is persisted as a
 * receipt and ignored by the join derivation, as before the split; the known
 * joins apply exactly as before. Real worker and real ledger (memory or
 * PostgreSQL); only the browser is a fixture that hands the worker's capture
 * read the events under test.
 */

type CapturedFixture = { kind: string; source: "browser" | "canonical" | "product"; payload: Record<string, unknown>; dedupeKey: string };

const WORKER = "capture-join-worker";
const JOIN_FIELDS = ["canonicalSessionId", "threadId", "providerSessionId", "traceId", "providerEpoch", "turnId"] as const;
const joins = (run: RunRecord) => Object.fromEntries(JOIN_FIELDS.map((field) => [field, run[field]]));

/** A browser that starts at once and returns `next` from the worker's next capture read. */
class CaptureFixtureDriver {
  readonly live = new Set<string>();
  next: CapturedFixture[] = [];
  hasSession = (runId: string) => this.live.has(runId);
  start = async (run: RunRecord, _capability: string, binding?: unknown) => {
    this.live.add(run.id);
    return { observedDeployment: run.target.expectedDeployment, events: [], browserContextBinding: binding };
  };
  readiness = async () => ({ ok: true, detail: "fixture", engine: "chromium", version: "fixture" });
  continueSession = async () => [];
  drain = async (runId: string) => {
    if (!this.live.has(runId)) throw new Error("Browser session is not live.");
    const events = this.next;
    this.next = [];
    return events;
  };
  cancel = async (runId: string) => { this.live.delete(runId); };
  close = async () => { this.live.clear(); };
}

let audio: AudioResolver | null = null;

/** A ready run started by a real worker on `ledger`, with that worker's live browser lease. */
async function readyRun(ledger: VoiceLabLedger) {
  const config = { ...testConfig(), browserLeaseSeconds: 30, operationLeaseSeconds: 60 };
  if (!audio) { audio = new AudioResolver(testConfig()); await audio.initialize(); }
  const driver = new CaptureFixtureDriver();
  const worker = new VoiceLabWorker(`${WORKER}-${randomUUID().slice(0, 8)}`, ledger, config, audio, driver as unknown as VoiceBrowserDriver,
    new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
  const run = testRun({ scenarioId: "V-O01", expiresAt: new Date(Date.now() + 3_600_000), capturePolicy: { rawAudio: false, screenshot: false, video: false, retentionHours: 24 } });
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: `start-${randomUUID()}`, requestHash: sha256(randomUUID()), input: { environment: run.environment } }, { global: 100, caller: 100 });
  // Setup, not the behaviour under test: a failure here is a harness error, never an assertion.
  if (!await worker.runOnce()) throw new Error("harness: the worker claimed no start operation");
  const ready = (await ledger.getRun(run.id))!;
  if (ready.state !== "ready") throw new Error(`harness: the run under test is ${ready.state}, not ready, after its start (another run's operation was claimed first?)`);
  return { worker, driver, run: ready };
}

/** One maintenance pass that reads `events` from the browser and persists them under the live lease. */
async function captured(ledger: VoiceLabLedger, events: (run: RunRecord) => CapturedFixture[]) {
  const { worker, driver, run } = await readyRun(ledger);
  const fixtures = events(run);
  driver.next = fixtures;
  await worker.maintainSessions();
  const after = (await ledger.getRun(run.id))!;
  const durable = (await ledger.listEvents(run.id, 0, 1_000)).events;
  const receipts = fixtures.map((fixture) => durable.filter((event) => event.dedupeKey === fixture.dedupeKey).length);
  worker.stop();
  return { before: run, after, receipts };
}

function productBinding(run: RunRecord): Record<string, unknown> {
  return {
    app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), principal_id_sha256: sha256(run.principalId),
    environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours,
    provider_expires_at: run.expiresAt.toISOString(), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
  };
}

export function captureJoinWorkerContract(store: () => VoiceLabLedger): void {
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])("a capture event of kind %s, a member Object.prototype carries, is persisted and ignored by the joins: the ready run stays ready", async (kind) => {
    const ledger = store();
    const { before, after, receipts } = await captured(ledger, (run) => [{ kind, source: "browser", payload: { probe: kind }, dedupeKey: `probe:${run.id}:${kind}` }]);
    expect({ state: after.state, terminalError: after.terminalError, receipts, joins: joins(after) })
      .toEqual({ state: "ready", terminalError: null, receipts: [1], joins: joins(before) });
  }, 30_000);

  it("control: an ordinary unknown extension kind is persisted and ignored the same way", async () => {
    const ledger = store();
    const { before, after, receipts } = await captured(ledger, (run) => [{ kind: "harness.extension_probe", source: "browser", payload: { probe: true }, dedupeKey: `probe:${run.id}:extension` }]);
    expect({ state: after.state, terminalError: after.terminalError, receipts, joins: joins(after) })
      .toEqual({ state: "ready", terminalError: null, receipts: [1], joins: joins(before) });
  }, 30_000);

  it("control: the known joins (credentials, provider epoch, snapshot, canonical finalization, product turn) apply exactly as before", async () => {
    const ledger = store();
    const { before, after, receipts } = await captured(ledger, (run) => [
      { kind: "session.credentials_received", source: "browser", payload: { sessionId: "session-1", voiceAgentSessionId: "provider-session-1", langsmithTraceId: "trace-1", providerConnectionEpoch: 2 }, dedupeKey: `join:${run.id}:credentials` },
      { kind: "provider.connection_epoch", source: "browser", payload: { sessionId: "session-1", voiceAgentSessionId: "provider-session-1", receipt: { langsmithTraceId: "trace-1", providerConnectionEpoch: 3 } }, dedupeKey: `join:${run.id}:epoch` },
      { kind: "capture.snapshot", source: "browser", payload: { snapshot: { session: { sessionId: "session-1", threadId: "thread-1" } } }, dedupeKey: `join:${run.id}:snapshot` },
      { kind: "session.finalized", source: "canonical", payload: { receipt: { canonical_transcript: { session_id: "session-1", thread_id: "thread-1" } } }, dedupeKey: `join:${run.id}:finalized` },
      { kind: "product.sophia.turn", source: "product", payload: { _app_synthetic_binding: productBinding(run), data: { turn_id: "turn-1" } }, dedupeKey: `join:${run.id}:turn` },
    ]);
    expect(joins(before)).toEqual({ canonicalSessionId: null, threadId: null, providerSessionId: null, traceId: null, providerEpoch: null, turnId: null });
    expect({ state: after.state, terminalError: after.terminalError, receipts, joins: joins(after), version: after.version }).toEqual({
      state: "ready", terminalError: null, receipts: [1, 1, 1, 1, 1], version: before.version + 1,
      joins: { canonicalSessionId: "session-1", threadId: "thread-1", providerSessionId: "provider-session-1", traceId: "trace-1", providerEpoch: 3, turnId: "turn-1" },
    });
  }, 30_000);
}
