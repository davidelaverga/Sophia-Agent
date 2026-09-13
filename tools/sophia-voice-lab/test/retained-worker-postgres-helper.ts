import pino from "pino";
import { expect, vi } from "vitest";
import type { AudioResolver } from "../src/audio.js";
import type { PostgresVoiceLabLedger } from "../src/postgres-ledger.js";
import type { RecoveryControlRecord } from "../src/recovery-control.js";
import { PlaywrightVoiceDriver } from "../src/browser-driver.js";
import { VoiceLabWorker } from "../src/worker.js";
import { CapabilityCodec, sha256 } from "../src/security.js";
import { recoveryAttemptIdentity } from "../src/recovery-attempt.js";
import { recoveryAttemptAuditHash } from "../src/retained-d02-recovery.js";
import { combinedRecoveryFixture } from "./retained-d02-recovery-helper.js";
import { testConfig } from "./helpers.js";

/** Real worker + real recovery transport + real PG; only Gateway HTTP response
 * is synthetic. No browser/provider execution and not a live voice certificate. */
export async function verifyRetainedWorkerPostgres(ledger: PostgresVoiceLabLedger, control: RecoveryControlRecord, settled: boolean) {
  const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
  const codec = new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds);
  const b = control.binding, browser = control.browserContextBinding!;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(`${b.gatewayOrigin}${config.recoveryPathPrefix}/${b.testRunId}/recover`);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Sophia-Voice-Lab-Recovery-Auth")).toBe(config.recoveryInternalSecret);
    const claims = codec.verify(headers.get("X-Sophia-Voice-Lab-Capability")!, {
      audience: "sophia-voice-lab-recovery", operation: "session:recover", principalId: b.principalId,
      testRunId: b.testRunId, cleanupObligationId: b.cleanupObligationId, environment: b.environment,
      retentionHours: b.retentionHours, providerExpiresAt: b.providerExpiresAt, expectedDeployment: b.expectedDeployment,
      scenarioId: b.scenarioId, scenarioVersion: b.scenarioVersion, voiceLabRunIdSha256: browser.voice_lab_run_id_sha256,
      browserWorkerIdSha256: browser.browser_worker_id_sha256, browserLeaseEpoch: browser.browser_lease_epoch,
      browserContextIdSha256: browser.browser_context_id_sha256,
    });
    expect(claims.allowed_ops).toEqual(["session:recover"]);
    const attempt = recoveryAttemptIdentity(claims);
    const audit = await ledger.pool.query("select count(*)::int as n from sophia_voice_lab.auth_audit where argument_hash=$1 and capability_jti_hash=$2 and outcome='allowed'", [recoveryAttemptAuditHash(control, attempt), sha256(claims.jti)]);
    expect(audit.rows[0].n).toBe(1);
    const { event } = combinedRecoveryFixture(control, claims.iat);
    return new Response(JSON.stringify({ ...event.payload.receipt, ok: true, cleanup_obligation_id: b.cleanupObligationId,
      recovery_id: attempt.recoveryId, attempt_id: attempt.attemptId, attempt_issued_at: claims.iat, recovered_at: new Date().toISOString() }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const launch = vi.fn(async () => { throw new Error("RECOVERY_MUST_NOT_LAUNCH_BROWSER"); });
  const driver = new PlaywrightVoiceDriver(config, fetchImpl, launch, undefined, launch);
  const start = vi.spyOn(driver, "start");
  const allocate = vi.spyOn(ledger, "upsertBrowserLease");
  const settlement = vi.spyOn(ledger, "settleRecoveryControl");
  try {
    const worker = new VoiceLabWorker("replacement-worker", ledger, config, {} as AudioResolver, driver, codec, pino({ level: "silent" }));
    await worker.maintainSessions();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(settlement).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(allocate).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(await ledger.getRun(b.runId)).toBeNull();
    expect((await ledger.getRecoveryControl(b.runId))!.liveCleanupComplete).toBe(settled);
    const call = settlement.mock.calls[0]!;
    expect(call[3]).toBeDefined();
    return { event: call[2], attempt: call[3]! };
  } finally { start.mockRestore(); allocate.mockRestore(); settlement.mockRestore(); }
}
