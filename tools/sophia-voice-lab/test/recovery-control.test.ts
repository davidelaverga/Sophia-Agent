import { describe, expect, it } from "vitest";
import { decodeRecoveryControlBinding, projectRecoveryControlBinding, recoveryTransportBinding } from "../src/recovery-control.js";
import { testRun } from "./helpers.js";

const partition = `cp1:test:${"a".repeat(64)}`;
describe("content-free recovery control binding", () => {
  it("round-trips only immutable recovery inputs and excludes run content", () => {
    const run = testRun({ callerId: "RAW_OAUTH_SUBJECT", terminalError: { code: "ERR", message: "PRIVATE_TRANSCRIPT", category: "harness", retryable: false }, providerSessionId: "PRIVATE_PROVIDER_HANDLE", threadId: "PRIVATE_THREAD", traceId: "PRIVATE_TRACE" });
    const binding = projectRecoveryControlBinding(run, partition);
    const serialized = JSON.stringify(binding);
    expect(serialized).not.toMatch(/PRIVATE_|RAW_OAUTH/);
    expect(decodeRecoveryControlBinding(serialized)).toEqual(binding);
    expect(recoveryTransportBinding(binding)).toEqual({ id: run.id, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, target: { gatewayUrl: run.target.gatewayUrl } });
    expect(Object.keys(binding).sort()).toEqual(["schema", "runId", "testRunId", "cleanupObligationId", "callerPartitionId", "principalId", "environment", "scenarioId", "scenarioVersion", "gatewayOrigin", "expectedDeployment", "createdAt", "providerExpiresAt", "retentionHours"].sort());
  });

  it.each(["transcript", "artifacts", "terminalError", "operationInput", "providerSessionId", "grant", "d02UnverifiedPayload"])("rejects unknown persisted field %s", (key) => {
    const binding = projectRecoveryControlBinding(testRun(), partition);
    expect(() => decodeRecoveryControlBinding(JSON.stringify({ ...binding, [key]: "private" }))).toThrow();
  });

  it("rejects unknown nested deployment content", () => {
    const binding = projectRecoveryControlBinding(testRun(), partition);
    expect(() => decodeRecoveryControlBinding(JSON.stringify({ ...binding, expectedDeployment: { ...binding.expectedDeployment, transcript: "private" } }))).toThrow();
  });

  it.each(["https://gateway.test/?secret=value", "https://user:pass@gateway.test", "https://gateway.test/#private", "file:///private", "https://gateway.test/private"])("rejects non-origin recovery target %s", (gatewayUrl) => {
    const run = testRun();
    run.target.gatewayUrl = gatewayUrl;
    expect(() => projectRecoveryControlBinding(run, partition)).toThrow();
  });

  it("cannot extend the immutable provider deadline through retention metadata", () => {
    const run = testRun();
    run.expiresAt = new Date(run.createdAt.getTime() + 169 * 3_600_000);
    expect(() => projectRecoveryControlBinding(run, partition)).toThrow();
  });

  it("rejects raw caller identities and oversized persisted input", () => {
    expect(() => projectRecoveryControlBinding(testRun(), "raw-caller")).toThrow();
    expect(() => decodeRecoveryControlBinding(" ".repeat(4097))).toThrow(/size bound/);
  });
});
