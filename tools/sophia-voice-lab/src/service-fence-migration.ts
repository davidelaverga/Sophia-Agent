import { createHash } from "node:crypto";
import { composeVoiceLabMigration } from "./migration-bundle.js";

export const SERVICE_FENCE_MIGRATION_SHA256 = "e00e529697bfb951e8c1d6464d2936d1cf5551939ea2fc20de9dcd7cbf03a955";
export const SERVICE_FENCE_SCHEMA_VERSION = 5;
export const SERVICE_FENCE_BUNDLE_SHA256 = "2bf482062671be20224d442f69c16f7478f035c622e57bf67fe4ec40a550e8b2";
export const SERVICE_FENCE_SOURCE_BUNDLE_SHA256 = "9407b1e0e881e9e497bb97e711067f304b3c323a50bf2b2302293b25561d5932";

/** Build a fresh reference schema with the additive proof constraint inside
 * the same transaction. Historical v3/v4 source bytes stay unchanged. This
 * helper does not execute DDL or change any deployed release metadata. */
export function composeServiceFenceMigration(base: Buffer, recovery: Buffer, fence: Buffer): Buffer {
  const historical = composeVoiceLabMigration(base, recovery).toString("utf8");
  if (createHash("sha256").update(fence).digest("hex") !== SERVICE_FENCE_MIGRATION_SHA256) throw new Error("SERVICE_FENCE_MIGRATION_CHECKSUM_INVALID");
  if (!/\ncommit;\s*$/.test(historical)) throw new Error("SERVICE_FENCE_MIGRATION_ENVELOPE_INVALID");
  return Buffer.from(`${historical.replace(/\ncommit;\s*$/, "")}\n${fence.toString("utf8")}\ncommit;\n`);
}
