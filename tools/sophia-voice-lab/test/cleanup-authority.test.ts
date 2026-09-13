import { expect, it } from "vitest";
import { authoritativeLiveCleanupComplete } from "../src/execution-cleanup.js";
import { testRun } from "./helpers.js";
import { recovery } from "./execution-cleanup-fixture.js";

it("accepts only exact-run canonical recovery with every resource component terminal", () => {
  const run = testRun();
  const valid = recovery(run);
  valid.payload.http_status = 200;
  expect(authoritativeLiveCleanupComplete([valid], run)).toBe(true);
  const wrongRun = testRun();
  expect(authoritativeLiveCleanupComplete([recovery(wrongRun)], run)).toBe(false);
  for (const mutate of [
    (e: typeof valid) => { e.source = "product"; },
    (e: typeof valid) => { e.payload.http_status = 503; },
    (e: typeof valid) => { (e.payload.receipt as any).cleanup_obligation_id_sha256 = "a".repeat(64); },
    (e: typeof valid) => { (e.payload.receipt as any).test_run_id = wrongRun.testRunId; },
    (e: typeof valid) => { (e.payload.receipt as any).components.voice_provider.status = "failed"; },
    (e: typeof valid) => { delete (e.payload.receipt as any).components.auth_sessions; },
  ]) {
    const altered = structuredClone(valid);
    mutate(altered);
    expect(authoritativeLiveCleanupComplete([altered], run)).toBe(false);
  }
});
