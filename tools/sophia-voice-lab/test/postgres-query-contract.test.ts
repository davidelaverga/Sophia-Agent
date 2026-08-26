import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const POSTGRES_LEDGER_PATH = fileURLToPath(new URL("../src/postgres-ledger.ts", import.meta.url));

describe("PostgreSQL query contracts", () => {
  it("types timestamp parameters before retention interval arithmetic", async () => {
    const source = await readFile(POSTGRES_LEDGER_PATH, "utf8");

    expect(source).toContain("observed_at < $1::timestamptz - interval '1 hour'");
    expect(source).toContain("audit.observed_at < $1::timestamptz - interval '7 days'");
    expect(source).toContain("observed_at < $1::timestamptz - interval '8 days'");
    expect(source).toContain("$4::timestamptz+interval '30 days'");
    expect(source).not.toMatch(/observed_at\s*<\s*\$1\s*-\s*interval/);
    expect(source).not.toContain("$4,$4+interval '30 days'");
  });
});
