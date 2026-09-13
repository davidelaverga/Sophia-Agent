import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
describe("read-only inventory command configuration", () => {
  it.each([
    { DATABASE_URL: "" },
    { DATABASE_URL: "postgresql://private-user:private-password@127.0.0.1:1/database", SOPHIA_VOICE_LAB_RECOVERY_INVENTORY_MODE: "private-invalid-mode" },
    { DATABASE_URL: "postgresql://private-user:private-password@127.0.0.1:1/database", SOPHIA_VOICE_LAB_RECOVERY_INVENTORY_MODE: "quarantine" },
    { DATABASE_URL: "https://private-user:private-password@example.invalid/database" },
    { DATABASE_URL: "postgresql://private-user:private-password@127.0.0.1:1/database", NODE_ENV: "test" },
    { DATABASE_URL: "postgresql://private-user:private-password@127.0.0.1:1/database", SOPHIA_VOICE_LAB_CALLER_PARTITION_KEYS_JSON: "private-malformed-key" },
  ])("refuses invalid/missing configuration without exposing values %#", async environment => {
    const result = await execute(process.execPath, ["--import", "tsx", "src/bin/recovery-inventory.ts"], { env: { PATH: process.env.PATH, ...environment }, timeout: 10_000 }).then(() => null, error => error);
    expect(result).not.toBeNull();
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ schema: "sophia.voice-lab.recovery-inventory-error.v1", code: "HISTORICAL_INVENTORY_FAILED", upgradeAuthorized: false });
    expect(result.stdout + result.stderr).not.toMatch(/private-|postgresql:|https:/);
  });
});
