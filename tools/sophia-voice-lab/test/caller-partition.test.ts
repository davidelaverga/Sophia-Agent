import { describe, expect, it } from "vitest";

import { CallerPartitioner } from "../src/caller-partition.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { sha256 } from "../src/security.js";
import { testConfig } from "./helpers.js";

const RAW_CALLER = "oauth-operator-subject@example.invalid";
const OLD = "caller-partition-old-secret-000000000000001";
const CURRENT = "caller-partition-current-secret-0000000001";
const LIMITS = {
  windowSeconds: 8 * 86_400,
  global: { runStarts: 2, providerSeconds: 100, suites: 2, suiteChildren: 4, audioDurationMs: 1000, audioBytes: 1000 },
  caller: { runStarts: 1, providerSeconds: 100, suites: 1, suiteChildren: 2, audioDurationMs: 1000, audioBytes: 1000 },
};

describe("keyed caller control partitions", () => {
  it("keeps active-window identities queryable across key rotation without exposing the caller", () => {
    const oldOnly = new CallerPartitioner({ activeKeyId: "old", keys: { old: OLD } });
    const rotated = new CallerPartitioner({ activeKeyId: "current", keys: { current: CURRENT, old: OLD } });
    expect(rotated.callerIds(RAW_CALLER)).toContain(oldOnly.activeCallerId(RAW_CALLER));
    expect(rotated.oauthSubjectIds(RAW_CALLER)).toContain(oldOnly.activeOAuthSubjectId(RAW_CALLER));
    expect(rotated.activeOAuthSubjectId(RAW_CALLER)).not.toBe(rotated.activeCallerId(RAW_CALLER));
    expect(rotated.reservationKeys(sha256("reservation"))).toContain(oldOnly.activeReservationKey(sha256("reservation")));
    expect(JSON.stringify(rotated.callerIds(RAW_CALLER))).not.toContain(RAW_CALLER);
    expect(() => rotated.assertLivePartitionIds(oldOnly.callerIds(RAW_CALLER))).not.toThrow();
    expect(() => new CallerPartitioner({ activeKeyId: "current", keys: { current: CURRENT } }).assertLivePartitionIds(oldOnly.callerIds(RAW_CALLER))).toThrow(/unconfigured verification key/i);
    expect(() => rotated.assertLivePartitionIds(["cp1:malformed"])).toThrow(/unconfigured verification key/i);
  });

  it("requires a separately keyed, bounded key ring", () => {
    expect(() => testConfig({ SOPHIA_VOICE_LAB_CALLER_PARTITION_KEYS_JSON: JSON.stringify({ active_key_id: "bad", keys: { bad: "base-bearer-credential-0000000000000001" } }) })).toThrow(/distinct/i);
    expect(() => testConfig({ SOPHIA_VOICE_LAB_CALLER_PARTITION_KEYS_JSON: JSON.stringify({ active_key_id: "missing", keys: { current: CURRENT } }) })).toThrow(/invalid/i);
  });

  it("stores no raw caller in global audits and preserves quota/idempotency for eight days", async () => {
    const ledger = new MemoryVoiceLabLedger("test", { activeKeyId: "current", keys: { current: CURRENT, old: OLD } });
    const observedAt = new Date("2026-08-23T12:00:00.000Z");
    const reservation = { reservationKey: sha256("same-key"), requestHash: sha256("same-request"), callerId: RAW_CALLER, environment: "production" as const, kind: "run" as const, runStarts: 1, providerSeconds: 10, suites: 0, suiteChildren: 0, audioDurationMs: 0, audioBytes: 0, observedAt };
    expect((await ledger.reserveRollingAdmission(reservation, LIMITS)).replay).toBe(false);
    expect((await ledger.reserveRollingAdmission(reservation, LIMITS)).replay).toBe(true);
    await expect(ledger.reserveRollingAdmission({ ...reservation, reservationKey: sha256("second-key"), requestHash: sha256("second-request") }, LIMITS)).rejects.toMatchObject({ detail: { code: "ROLLING_RUN_STARTS_LIMIT" } });

    await ledger.recordAuthAudit({ runId: null, callerId: RAW_CALLER, action: "mcp.body", argumentHash: sha256("body"), outcome: "denied", detail: {}, observedAt });
    const global = await ledger.listAuthAudit(null);
    expect(global).toHaveLength(1);
    expect(global[0]?.callerId).toMatch(/^cp1:current:[a-f0-9]{64}$/);
    expect(JSON.stringify(global)).not.toContain(RAW_CALLER);
    expect(await ledger.listAuthAuditByArgumentHashes(RAW_CALLER, [sha256("body")], new Date(0))).toHaveLength(1);

    // Control partitions intentionally outlive a one-hour synthetic run so
    // rolling quota/replay cannot be bypassed, while the raw subject does not.
    await ledger.purgeExpiredRetention(new Date(observedAt.getTime() + 2 * 3_600_000), 10);
    expect((await ledger.reserveRollingAdmission(reservation, LIMITS)).replay).toBe(true);
    expect(JSON.stringify(await ledger.listAuthAudit(null))).not.toContain(RAW_CALLER);
  });
});
