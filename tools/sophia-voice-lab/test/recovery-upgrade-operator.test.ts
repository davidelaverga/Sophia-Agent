import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { parseRecoveryUpgradeOperator, runRecoveryUpgradeOperator } from "../src/recovery-upgrade-operator.js";

const execute = promisify(execFile);
const valid = () => ({ DATABASE_URL: "postgresql://private-user:private-password@127.0.0.1:1/database",
  COMMIT_SHA: "a".repeat(40), SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_EXPECTED_COMMIT: "a".repeat(40),
  SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_APPROVED: "YES", SOPHIA_VOICE_LAB_KILL_SWITCH: "true",
  SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_INVENTORY_SHA256: "b".repeat(64),
  SOPHIA_VOICE_LAB_CALLER_PARTITION_KEYS_JSON: JSON.stringify({ active_key_id: "test",
    keys: { test: "synthetic-upgrade-test-secret-000000000000" } }) });

it("requires an explicit release/inventory binding without silently accepting history", () => {
  expect(parseRecoveryUpgradeOperator(valid()).quarantine).toEqual({ expectedInventorySha256: "b".repeat(64) });
  expect(parseRecoveryUpgradeOperator({ ...valid(), SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_AUTHORIZATION_SHA256: "c".repeat(64) }).quarantine)
    .toEqual({ expectedInventorySha256: "b".repeat(64), admissionExceptionAuthorizationSha256: "c".repeat(64) });
});

it.each([
  { SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_APPROVED: "" }, { SOPHIA_VOICE_LAB_KILL_SWITCH: "false" },
  { SOPHIA_VOICE_LAB_KILL_SWITCH: "" }, { COMMIT_SHA: "d".repeat(40) }, { RENDER_GIT_COMMIT: "d".repeat(40) },
  { SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_EXPECTED_COMMIT: "development" },
  { SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_INVENTORY_SHA256: "" },
  { SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_AUTHORIZATION_SHA256: "private-invalid" },
  { DATABASE_URL: "" }, { DATABASE_URL: "https://private-user:private-password@example.invalid" },
  { SOPHIA_VOICE_LAB_CALLER_PARTITION_KEYS_JSON: "", NODE_ENV: "test" },
])("refuses missing or drifted operator configuration %#", delta => {
  expect(() => parseRecoveryUpgradeOperator({ ...valid(), ...delta })).toThrow();
});

it("validates immutable migration bytes before any database connection", async () => {
  const connect = vi.fn();
  const base = await readFile("../../backend/migrations/2026_08_23_sophia_voice_lab.sql");
  await expect(runRecoveryUpgradeOperator({ connect } as any, parseRecoveryUpgradeOperator(valid()), base, Buffer.from("drift"))).rejects.toThrow("compiled checksum");
  expect(connect).not.toHaveBeenCalled();
});

it.each([{ args: [] }, { args: ["private-argument"] }])("sanitizes command failures and never asserts rollback %#", async ({ args }) => {
  const result = await execute(process.execPath, ["--import", "tsx", "src/bin/upgrade-recovery.ts", ...args],
    { env: { PATH: process.env.PATH, ...valid() }, timeout: 10_000 }).then(() => null, error => error);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual({ schema: "sophia.voice-lab.recovery-upgrade-error.v1",
    code: "RECOVERY_UPGRADE_FAILED", outcome: "unconfirmed", admissionAuthorized: false });
  expect(result.stdout + result.stderr).not.toMatch(/private-|postgresql:|synthetic-upgrade-test-secret/);
});
