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

export const SERVICE_FENCE_V2_MIGRATION_SHA256 = "08fa36efea28c22f26784933b2f36f03441153fa435bb676e55105fe8e20598f";
export const SERVICE_FENCE_V2_SCHEMA_VERSION = 6;
export const SERVICE_FENCE_V2_BUNDLE_SHA256 = "bc47d257ab1ebfced5708b0255a9e215085410337172632e62f97b422e798b67";

/** v6 release bytes: the exact v5 bundle plus the additive v2 proof shape in
 * the same transaction. The v5 source bundle (and 005) stays byte-identical. */
export function composeServiceFenceV2Migration(base: Buffer, recovery: Buffer, fence: Buffer, fenceV2: Buffer): Buffer {
  const v5 = composeServiceFenceMigration(base, recovery, fence).toString("utf8");
  if (createHash("sha256").update(fenceV2).digest("hex") !== SERVICE_FENCE_V2_MIGRATION_SHA256) throw new Error("SERVICE_FENCE_V2_MIGRATION_CHECKSUM_INVALID");
  return Buffer.from(`${v5.replace(/\ncommit;\s*$/, "")}\n${fenceV2.toString("utf8")}\ncommit;\n`);
}
