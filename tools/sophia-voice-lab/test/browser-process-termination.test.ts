import { expect, it } from "vitest";
import { BrowserProcessTerminationSchema, deriveBrowserProcessTermination } from "../src/browser-process-termination.js";
import { deriveExecutionOwnership } from "../src/execution-ownership.js";
import { deriveRecoveryAllocationFromOwnerHash, projectRecoveryControlBinding, type RecoveryControlRecord } from "../src/recovery-control.js";
import { testConfig, testRun } from "./helpers.js";
import { PlaywrightVoiceDriver } from "../src/browser-driver.js";
import { canonicalRequestHash } from "../src/security.js";
import { closed, ownership, WORKER } from "./execution-cleanup-fixture.js";

function fixture() {
  const run = testRun({ scenarioId: "V-O01", createdAt: new Date(0), expiresAt: new Date(60_000), providerSessionId: "provider-test", providerEpoch: 2 });
  const events = [...ownership(run), closed(run)];
  const control: RecoveryControlRecord = {
    binding: projectRecoveryControlBinding(run, `cp1:test:${"a".repeat(64)}`),
    browserAllocationEver: true, browserAllocationBinding: deriveRecoveryAllocationFromOwnerHash(run.id, WORKER, 7),
    executionOwnership: deriveExecutionOwnership(run, events), version: 1, liveCleanupComplete: false,
    retentionPurgeDueAt: null, remotePurgeComplete: false, contentPurgedAt: null,
  };
  return { run, events, control };
}
it("derives only exact process death, without claiming provider or resource zero", () => {
  const f = fixture();
  const result = deriveBrowserProcessTermination(f.run, f.control, f.events, false);
  expect(result).not.toBeNull();
  expect(BrowserProcessTerminationSchema.parse(result)).toMatchObject({ provider_connection_epoch: 2, process_closed_seq: 5 });
  expect(result).not.toHaveProperty("live_resources_zero");
  expect(result).not.toHaveProperty("websocket_close_observed");
});
it.each(["browser-live", "d02", "no-close", "wrong-process", "wrong-owner", "duplicate-seq", "foreign-run", "no-retained-owner"])("refuses %s", mode => {
  const f = fixture();
  if (mode === "d02") f.run.scenarioId = "V-D02";
  if (mode === "no-close") f.events.pop();
  if (mode === "wrong-process") f.events[2]!.payload.process_id_sha256 = "f".repeat(64);
  if (mode === "wrong-owner") f.control.browserAllocationBinding = deriveRecoveryAllocationFromOwnerHash(f.run.id, "f".repeat(64), 7);
  if (mode === "duplicate-seq") f.events.push(f.events[0]!);
  if (mode === "foreign-run") f.events[2]!.runId = testRun().id;
  if (mode === "no-retained-owner") delete f.control.executionOwnership;
  expect(deriveBrowserProcessTermination(f.run, f.control, f.events, mode === "browser-live")).toBeNull();
});

it.each(["accepted", "wrong-hash", "old-gateway", "network"])("private recovery transport %s never substitutes process proof for provider zero", async mode => {
  const f = fixture();
  const proof = deriveBrowserProcessTermination(f.run, f.control, f.events, false)!;
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const driver = new PlaywrightVoiceDriver(testConfig(), async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname.endsWith("/browser-process-closed")) {
      if (mode === "network") throw new Error("connection interrupted");
      return new Response(JSON.stringify({ accepted: true, receipt_sha256: proof.receipt_sha256,
        provider_settlement_sha256: mode === "wrong-hash" ? "f".repeat(64) : canonicalRequestHash({ basis: "browser_process_terminated", receipt: proof }),
        provider_cleanup_proven: false }), { status: mode === "old-gateway" ? 404 : 202 });
    }
    return new Response(JSON.stringify({ status: "pending" }), { status: 202 });
  });
  const result = await driver.recover(f.run, "test-recovery-capability", proof);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.init).toMatchObject({ method: "POST", redirect: "error", body: JSON.stringify(proof),
    headers: { "X-Sophia-Voice-Lab-Capability": "test-recovery-capability", "X-Sophia-Voice-Lab-Recovery-Auth": testConfig().recoveryInternalSecret } });
  expect(calls[1]!.url.pathname).toMatch(/\/recover$/);
  expect(calls[1]!.init?.body).toBeUndefined();
  expect(result.events[0]!.payload).toMatchObject({ accepted: mode === "accepted", provider_cleanup_proven: false });
  expect(result.events.some(event => event.kind === "cleanup.recovery" && event.payload.complete === true)).toBe(false);
});
