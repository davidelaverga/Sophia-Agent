import { expect, it } from "vitest";
import { resolveWorkerIdentity, renderInventoryInstanceId } from "../src/worker-identity.js";

it("projects the observed Render inventory ID without rewriting ownership", () => {
  const full = "srv-da6uiqfavr4c739mtbo0-54b9b6c74d-dkgqg";
  expect(resolveWorkerIdentity("production", { RENDER_INSTANCE_ID: full })).toBe(full);
  expect(renderInventoryInstanceId(full)).toBe("srv-da6uiqfavr4c739mtbo0-dkgqg");
  expect(renderInventoryInstanceId("srv-da6uiqfavr4c739mtbo0-dkgqg")).toBe("srv-da6uiqfavr4c739mtbo0-dkgqg");
});
it.each(["worker-local", "srv-da6uiqfavr4c739mtbo0-nothex-dkgqg", "srv-da6uiqfavr4c739mtbo0-54b9b6c74d-dkgqg-extra", " srv-da6uiqfavr4c739mtbo0-dkgqg"])("rejects ambiguous Render inventory projection: %s", value => {
  expect(renderInventoryInstanceId(value)).toBeNull();
});

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
