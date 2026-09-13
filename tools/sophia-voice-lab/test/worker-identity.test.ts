import { expect, it } from "vitest";
import { resolveWorkerIdentity } from "../src/worker-identity.js";

it("preserves the exact platform owner for controller inventory correlation", () => {
  expect(resolveWorkerIdentity("production", { RENDER_INSTANCE_ID: "srv-example-worker-0123" })).toBe("srv-example-worker-0123");
});
it.each(["production", "staging", "unknown"])("refuses missing platform ownership in %s", environment => {
  expect(() => resolveWorkerIdentity(environment, {})).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "WORKER_INSTANCE_ID_REQUIRED" }) }));
});
it.each(["", " ", "short", " owner-012345 ", "owner/012345", "a".repeat(129), "owner\n012345"])("rejects malformed platform identity without leaking it", value => {
  try {
    resolveWorkerIdentity("production", { RENDER_INSTANCE_ID: value });
    expect.unreachable();
  } catch (error) {
    expect(error).toMatchObject({ detail: { code: "WORKER_INSTANCE_ID_INVALID" } });
    if (value.length > 2) expect(JSON.stringify(error)).not.toContain(value);
  }
});
it("limits generated non-platform identities to explicit local/test operation", () => {
  expect(resolveWorkerIdentity("test", {})).toMatch(/^worker-[a-f0-9-]{36}$/);
  expect(resolveWorkerIdentity("development", {})).not.toBe(resolveWorkerIdentity("development", {}));
});
