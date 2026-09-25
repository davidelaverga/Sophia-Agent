import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("fails closed without approval and suppresses credential-bearing diagnostics", async () => {
  const execute = promisify(execFile);
  const result = await execute(process.execPath, ["--import", "tsx", "src/bin/upgrade-service-fence.ts"], {
    env: { ...process.env, SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_APPROVED: "NO",
      DATABASE_URL: "postgresql://synthetic:never-print-this@127.0.0.1:1/invalid" }, timeout: 15_000,
  }).then(() => { throw new Error("Unexpected success"); }, error => error);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual({ schema: "sophia.voice-lab.service-fence-upgrade-error.v1",
    code: "SERVICE_FENCE_UPGRADE_FAILED", outcome: "unconfirmed", admissionAuthorized: false });
  expect(result.stderr).not.toContain("never-print-this");
});

it("fails the v5->v6 step closed without its own approval and suppresses diagnostics", async () => {
  const execute = promisify(execFile);
  const result = await execute(process.execPath, ["--import", "tsx", "src/bin/upgrade-service-fence-v2.ts"], {
    env: { ...process.env, SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_APPROVED: "YES", SOPHIA_VOICE_LAB_SERVICE_FENCE_V2_UPGRADE_APPROVED: "NO",
      DATABASE_URL: "postgresql://synthetic:never-print-this@127.0.0.1:1/invalid" }, timeout: 15_000,
  }).then(() => { throw new Error("Unexpected success"); }, error => error);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual({ schema: "sophia.voice-lab.service-fence-v2-upgrade-error.v1",
    code: "SERVICE_FENCE_V2_UPGRADE_FAILED", outcome: "unconfirmed", admissionAuthorized: false });
  expect(result.stderr).not.toContain("never-print-this");
});
