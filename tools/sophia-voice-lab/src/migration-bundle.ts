import { createHash } from "node:crypto";

export const BASE_MIGRATION_SHA256 = "9396354e67e47fc304cd9af1ff2d782f3fc6ba9c953e37475efe4965b57873a6";
export const RECOVERY_MIGRATION_SHA256 = "35540a1e16c18cfda38e8916b809c76c0b57c26fc4a8b8ea3e44dbe932fc83ff";

/** Retain the historical source bytes/checksum, but place the extension inside
 * the same transaction rather than committing a half-upgraded fresh schema. */
export function composeVoiceLabMigration(base: Buffer, recovery: Buffer): Buffer {
  for (const [bytes, expected] of [[base, BASE_MIGRATION_SHA256], [recovery, RECOVERY_MIGRATION_SHA256]] as const) {
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Voice Lab migration source does not match its compiled checksum");
  }
  const source = base.toString("utf8");
  if ((source.match(/^begin;$/gm) ?? []).length !== 1 || (source.match(/^commit;$/gm) ?? []).length !== 1 || !/\ncommit;\s*$/.test(source)) throw new Error("Voice Lab base transaction envelope changed");
  return Buffer.from(`begin;\n${source.replace(/^begin;\n/m, "").replace(/\ncommit;\s*$/, "")}\n${recovery.toString("utf8")}\ncommit;\n`);
}
