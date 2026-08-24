import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioResolver } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import type { WorkerHeartbeat } from "../src/ledger.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CapabilityCodec } from "../src/security.js";
import { VoiceLabWorker, WORKER_HEARTBEAT_BROWSER_READINESS_TIMEOUT_MS, WORKER_HEARTBEAT_INTERVAL_MS } from "../src/worker.js";
import { createWorkerBootIdentity } from "../src/worker-heartbeat.js";
import { testConfig } from "./helpers.js";

function heartbeatSequence(heartbeat: WorkerHeartbeat): number {
  return heartbeat.attestation?.heartbeat_sequence ?? 0;
}

async function flushAsyncWork(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function createHarness() {
  const config = testConfig();
  const ledger = new MemoryVoiceLabLedger("test");
  const audio = {
    readiness: () => ({ ok: true, detail: { status: "ready" } }),
    summaries: () => [{ id: "heartbeat-fixture" }],
  } as unknown as AudioResolver;
  const driver = {
    readiness: vi.fn(async () => ({ ok: true, detail: "ready", engine: "chromium", version: "test" })),
    close: vi.fn(async () => undefined),
  } as unknown as VoiceBrowserDriver;
  const worker = new VoiceLabWorker(
    "worker-process-heartbeat-test",
    ledger,
    config,
    audio,
    driver,
    new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds),
    pino({ level: "silent" }),
    fetch,
    async () => ({ ok: true, status: "test" }),
    createWorkerBootIdentity("worker-process-heartbeat-test", "worker-process-heartbeat-boot", new Date("2026-08-24T00:00:00.000Z")),
  );
  vi.spyOn(worker, "maintainSessions").mockResolvedValue();
  return { worker, ledger, driver };
}

function holdWorkerIteration(worker: VoiceLabWorker) {
  let release!: () => void;
  const longOperation = new Promise<boolean>((resolve) => { release = () => resolve(true); });
  const iteration = vi.spyOn(worker, "runOnce").mockImplementation(async () => longOperation);
  return { running: worker.run(), release, iteration };
}

describe("worker process heartbeat loop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps a fresh monotonic process heartbeat throughout a long claimed-operation iteration and stops cleanly", async () => {
    const { worker, ledger } = createHarness();
    const heartbeat = vi.spyOn(ledger, "heartbeatWorker");
    const { running, release } = holdWorkerIteration(worker);

    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS * 2);
    expect(heartbeat.mock.calls.slice(0, 3).map(([value]) => heartbeatSequence(value))).toEqual([1, 2, 3]);

    worker.stop();
    release();
    await running;
    const stoppedCount = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS * 3);
    expect(heartbeat).toHaveBeenCalledTimes(stoppedCount);
  });

  it("continues after a failed durable write without reusing an ambiguous heartbeat sequence", async () => {
    const { worker, ledger } = createHarness();
    const durableHeartbeat = ledger.heartbeatWorker.bind(ledger);
    const heartbeat = vi.spyOn(ledger, "heartbeatWorker")
      .mockRejectedValueOnce(new Error("transient heartbeat write failure"))
      .mockImplementation(durableHeartbeat);
    const { running, release } = holdWorkerIteration(worker);

    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS * 2);
    worker.stop();
    release();
    await running;

    expect(heartbeat.mock.calls.slice(0, 3).map(([value]) => heartbeatSequence(value))).toEqual([1, 2, 3]);
    const live = await ledger.listLiveWorkers(new Date(0));
    expect(live).toHaveLength(1);
    expect(heartbeatSequence(live[0]!)).toBeGreaterThanOrEqual(2);
  });

  it("bounds a hung browser probe and durably reports allocation readiness false before liveness expires", async () => {
    const { worker, ledger, driver } = createHarness();
    vi.mocked(driver.readiness).mockImplementation(async () => new Promise(() => undefined));
    const heartbeat = vi.spyOn(ledger, "heartbeatWorker");
    const { running, release } = holdWorkerIteration(worker);

    expect(WORKER_HEARTBEAT_BROWSER_READINESS_TIMEOUT_MS + WORKER_HEARTBEAT_INTERVAL_MS).toBeLessThan(10_000);
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_BROWSER_READINESS_TIMEOUT_MS - 1);
    expect(heartbeat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(heartbeat.mock.calls[0]![0]).toMatchObject({
      browserReady: false,
      detail: { browser: "chromium-readiness-timeout", fixtures_ready: true, tts_ready: true },
      attestation: { heartbeat_sequence: 1 },
    });

    worker.stop();
    release();
    await running;
  });

  it("serializes slow writes so timer ticks cannot overlap or duplicate a sequence", async () => {
    const { worker, ledger } = createHarness();
    const releases: Array<() => void> = [];
    const sequences: number[] = [];
    let inFlight = 0;
    let maximumInFlight = 0;
    vi.spyOn(ledger, "heartbeatWorker").mockImplementation(async (heartbeat) => {
      sequences.push(heartbeatSequence(heartbeat));
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise<void>((resolve) => releases.push(() => {
        inFlight -= 1;
        resolve();
      }));
    });
    const { running, release: releaseIteration, iteration } = holdWorkerIteration(worker);

    await flushAsyncWork();
    expect(releases).toHaveLength(1);
    expect(iteration).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS * 3);
    expect(sequences).toEqual([1]);
    releases.shift()!();
    await flushAsyncWork();
    expect(iteration).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
    expect(releases).toHaveLength(1);
    expect(sequences).toHaveLength(2);
    expect(maximumInFlight).toBe(1);
    expect(sequences).toEqual([1, 2]);

    worker.stop();
    releases.shift()!();
    releaseIteration();
    await running;
    expect(maximumInFlight).toBe(1);
    expect(sequences).toEqual([1, 2]);
  });

  it("lets close race run initialization, drains the in-flight heartbeat, and never begins an operation", async () => {
    const { worker, ledger, driver } = createHarness();
    const releases: Array<() => void> = [];
    const heartbeat = vi.spyOn(ledger, "heartbeatWorker").mockImplementation(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
    });
    const { running, iteration } = holdWorkerIteration(worker);

    let closeSettled = false;
    const closing = worker.close().finally(() => { closeSettled = true; });
    await flushAsyncWork();
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(releases).toHaveLength(1);
    expect(closeSettled).toBe(false);
    expect(iteration).not.toHaveBeenCalled();
    expect(driver.close).not.toHaveBeenCalled();

    releases.shift()!();
    await closing;
    await running;
    expect(iteration).not.toHaveBeenCalled();
    expect(driver.close).toHaveBeenCalledTimes(1);
  });
});
