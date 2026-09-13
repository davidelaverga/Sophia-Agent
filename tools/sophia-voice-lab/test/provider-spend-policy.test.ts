import { describe, expect, it } from "vitest";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { sha256 } from "../src/security.js";
import { testConfig } from "./helpers.js";

describe("operator-selected unlimited aggregate provider spend", () => {
  it("requires explicit unlimited and leaves per-run/resource limits unchanged", () => {
    const baseline = testConfig();
    const config = testConfig({
      SOPHIA_VOICE_LAB_MAX_ROLLING_PROVIDER_SECONDS: "unlimited",
      SOPHIA_VOICE_LAB_MAX_ROLLING_PROVIDER_SECONDS_PER_CALLER: "unlimited",
    });
    expect(config.maxRollingProviderSeconds).toBeNull();
    expect(config.maxRollingProviderSecondsPerCaller).toBeNull();
    for (const key of ["maxRunSeconds", "maxConcurrentRuns", "maxRunsPerCaller", "maxAudioBytes", "maxUtterancesPerRun"] as const) {
      expect(config[key]).toBe(baseline[key]);
    }
    expect(baseline.maxRollingProviderSeconds).toBe(144_000);
  });
  it.each(["0", "-1", "Infinity", "45000oops", "UNLIMITED", ""])("rejects ambiguous policy %j", (value) => {
    expect(() => testConfig({ SOPHIA_VOICE_LAB_MAX_ROLLING_PROVIDER_SECONDS: value })).toThrow();
  });
  it("keeps accounting, replay, other caps, and independently configured caller/global caps", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const cap = { runStarts: 1, providerSeconds: null, suites: 1, suiteChildren: 20, audioDurationMs: 1000, audioBytes: 1000 };
    const limits = { windowSeconds: 86400, global: cap, caller: cap };
    const reservation = { reservationKey: sha256("spend-1"), requestHash: sha256("request-1"), callerId: "operator", environment: "production" as const, kind: "run" as const, runStarts: 1, providerSeconds: 1_000_000, suites: 0, suiteChildren: 0, audioDurationMs: 0, audioBytes: 0, observedAt: new Date() };
    const result = await ledger.reserveRollingAdmission(reservation, limits);
    expect(result.remaining.global.providerSeconds).toBeNull();
    expect(result.remaining.caller.providerSeconds).toBeNull();
    expect(result.remaining.global.runStarts).toBe(0);
    expect((await ledger.reserveRollingAdmission(reservation, limits)).replay).toBe(true);
    await expect(ledger.reserveRollingAdmission({ ...reservation, providerSeconds: 0 }, limits)).rejects.toMatchObject({ detail: { code: "IDEMPOTENCY_CONFLICT" } });
    const next = { ...reservation, reservationKey: sha256("spend-2"), requestHash: sha256("request-2") };
    await expect(ledger.reserveRollingAdmission(next, limits)).rejects.toMatchObject({ detail: { code: "ROLLING_RUN_STARTS_LIMIT" } });
    for (const side of ["global", "caller"] as const) {
      const bounded = { global: { ...cap, runStarts: 5 }, caller: { ...cap, runStarts: 5 }, windowSeconds: 86400 };
      const mixed = { ...bounded, [side]: { ...bounded[side], providerSeconds: 1_000_001 } };
      await expect(ledger.reserveRollingAdmission(next, mixed)).rejects.toMatchObject({ detail: { code: "ROLLING_PROVIDER_SECONDS_LIMIT" } });
    }
  });
});
