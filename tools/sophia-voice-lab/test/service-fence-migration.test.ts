import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { composeVoiceLabMigration } from "../src/migration-bundle.js";
import { composeServiceFenceMigration, composeServiceFenceV2Migration } from "../src/service-fence-migration.js";
import { SERVICE_FENCE_BUNDLE_SHA256, SERVICE_FENCE_V2_BUNDLE_SHA256, SERVICE_FENCE_V2_SCHEMA_VERSION } from "../src/service-fence-migration.js";
import { createHash } from "node:crypto";
import { VOICE_LAB_SCHEMA_VERSION, VOICE_LAB_MIGRATION_SHA256, VOICE_LAB_SCHEMA_SEAL_PATH } from "../src/schema-attestation.js";

async function source() {
  return Promise.all([
    readFile(new URL("../../../backend/migrations/2026_08_23_sophia_voice_lab.sql", import.meta.url)),
    readFile(new URL("../migrations/004_recovery_controls.sql", import.meta.url)),
    readFile(new URL("../migrations/005_service_owner_fence.sql", import.meta.url)),
    readFile(new URL("../migrations/006_service_fence_v2.sql", import.meta.url)),
  ]);
}
it("binds current startup metadata and seal to the v6 bundle", () => {
  expect(VOICE_LAB_SCHEMA_VERSION).toBe(SERVICE_FENCE_V2_SCHEMA_VERSION);
  expect(VOICE_LAB_MIGRATION_SHA256).toBe(SERVICE_FENCE_V2_BUNDLE_SHA256);
  expect(VOICE_LAB_SCHEMA_SEAL_PATH).toMatch(/schema-v6\.attestation\.json$/);
});
it("extends the unchanged v5 bundle with the additive v2 proof shape in one transaction", async () => {
  const [base, recovery, fence, fenceV2] = await source();
  const v5 = composeServiceFenceMigration(base!, recovery!, fence!);
  expect(createHash("sha256").update(v5).digest("hex")).toBe(SERVICE_FENCE_BUNDLE_SHA256);
  const result = composeServiceFenceV2Migration(base!, recovery!, fence!, fenceV2!).toString("utf8");
  expect(result.startsWith(v5.toString("utf8").replace(/\ncommit;\s*$/, ""))).toBe(true);
  expect(result.match(/^begin;$/gm)).toHaveLength(1);
  expect(result.match(/^commit;$/gm)).toHaveLength(1);
  expect(result).toContain("sophia.voice-lab.verified-service-owner-fence.v2");
  expect(fenceV2!.toString("utf8")).toContain("or generic_owner_loss->>'originalOwnerPreAction' = 'absent'");
});
it("composes the additive constraint into one transaction without rewriting historical sources", async () => {
  const [base, recovery, fence] = await source();
  const historical = composeVoiceLabMigration(base!, recovery!).toString("utf8");
  const result = composeServiceFenceMigration(base!, recovery!, fence!).toString("utf8");
  expect(result.startsWith(historical.replace(/\ncommit;\s*$/, ""))).toBe(true);
  expect(result.match(/^begin;$/gm)).toHaveLength(1);
  expect(result.match(/^commit;$/gm)).toHaveLength(1);
  expect(result).toContain("sophia.voice-lab.verified-service-owner-fence.v1");
  expect(result).toContain("and binding->>'scenarioId' is distinct from 'V-D02'");
});
it("rejects altered source bytes in every migration before any database work", async () => {
  const bytes = await source();
  for (let i = 0; i < 3; i++) {
    const changed = [...bytes]; changed[i] = Buffer.concat([changed[i]!, Buffer.from("\n")]);
    expect(() => composeServiceFenceMigration(changed[0]!, changed[1]!, changed[2]!)).toThrow();
  }
  for (let i = 0; i < 4; i++) {
    const changed = [...bytes]; changed[i] = Buffer.concat([changed[i]!, Buffer.from("\n")]);
    expect(() => composeServiceFenceV2Migration(changed[0]!, changed[1]!, changed[2]!, changed[3]!)).toThrow();
  }
});
