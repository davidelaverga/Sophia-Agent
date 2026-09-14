import { describe, expect, it } from "vitest";
import { canonicalRequestHash, canonicalResponseHash } from "../src/security.js";

describe("bounded observation audit hashing", () => {
  it("preserves canonical digests and key ordering for existing envelopes", () => {
    const value = { data: { z: [1, "two", null], a: true }, status: "ok" };
    expect(canonicalResponseHash(value)).toBe(canonicalRequestHash(value));
    expect(canonicalResponseHash(value)).toBe(canonicalResponseHash({ status: "ok", data: { a: true, z: [1, "two", null] } }));
  });
  it("hashes a realistic 500-event response without widening request admission", () => {
    const value = { events: Array.from({ length: 500 }, (_, seq) => ({ seq, payload: { observation: "x".repeat(3000) } })) };
    expect(() => canonicalRequestHash(value)).toThrow();
    expect(canonicalResponseHash(value)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("retains response byte, UTF-8, depth and cycle limits", () => {
    for (const value of ["x".repeat(8_000_001), "界".repeat(3_000_000)]) {
      expect(() => canonicalResponseHash(value)).toThrow("bounded audit contract");
    }
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalResponseHash(cycle)).toThrow("bounded audit contract");
    let deep: unknown = null;
    for (let n = 0; n < 66; n++) deep = { child: deep };
    expect(() => canonicalResponseHash(deep)).toThrow("bounded audit contract");
  });
});
