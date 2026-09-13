import { randomBytes } from "node:crypto";
import type pg from "pg";
import { CallerPartitioner } from "./caller-partition.js";
import { parseCallerPartitionKeys } from "./config.js";
import { BASE_MIGRATION_SHA256, composeVoiceLabMigration } from "./migration-bundle.js";
import { upgradeHistoricalRecovery } from "./recovery-upgrade.js";
import { readVoiceLabCatalog } from "./schema-attestation.js";
import { canonicalRequestHash } from "./security.js";

/** Configuration is explicit operator intent, not an external gate attestation. */
export function parseRecoveryUpgradeOperator(env: NodeJS.ProcessEnv) {
  const expectedCommit = env.SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_EXPECTED_COMMIT;
  const runningCommit = env.RENDER_GIT_COMMIT || env.COMMIT_SHA;
  const inventory = env.SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_INVENTORY_SHA256;
  const authorization = env.SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_AUTHORIZATION_SHA256;
  if (env.SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_APPROVED !== "YES"
    || env.SOPHIA_VOICE_LAB_KILL_SWITCH !== "true"
    || !expectedCommit || !/^[a-f0-9]{40}$/.test(expectedCommit) || runningCommit !== expectedCommit
    || !inventory || !/^[a-f0-9]{64}$/.test(inventory)
    || (authorization !== undefined && !/^[a-f0-9]{64}$/.test(authorization))) throw new Error("UPGRADE_OPERATOR_CONFIGURATION_INVALID");
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl || !["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol)) throw new Error("UPGRADE_OPERATOR_DATABASE_INVALID");
  return { databaseUrl, expectedCommit,
    partitions: new CallerPartitioner(parseCallerPartitionKeys(env.SOPHIA_VOICE_LAB_CALLER_PARTITION_KEYS_JSON, "production")),
    quarantine: { expectedInventorySha256: inventory,
      ...(authorization === undefined ? {} : { admissionExceptionAuthorizationSha256: authorization }) } };
}

/** Each reference schema exists only in a rolled-back transaction. No host seal
 * or target metadata is written here. Source checksum validation precedes DDL. */
async function referenceCatalog(client: pg.PoolClient, bytes: Buffer): Promise<string> {
  const schema = `sophia_voice_lab_ref_${randomBytes(8).toString("hex")}`;
  const sql = bytes.toString("utf8");
  if ((sql.match(/^begin;$/gm) ?? []).length !== 1 || (sql.match(/^commit;$/gm) ?? []).length !== 1
    || !/^begin;\n/.test(sql) && !/\nbegin;\n/.test(sql) || !/\ncommit;\s*$/.test(sql)) throw new Error("UPGRADE_REFERENCE_ENVELOPE_INVALID");
  await client.query("begin");
  try {
    await client.query("set local statement_timeout='30s'");
    await client.query("set local lock_timeout='5s'");
    await client.query(sql.replace(/^begin;\n/m, "").replace(/\ncommit;\s*$/, "").replace(/\bsophia_voice_lab\b/g, schema));
    return canonicalRequestHash(await readVoiceLabCatalog(client, schema));
  } finally { await client.query("rollback"); }
}

export async function runRecoveryUpgradeOperator(pool: pg.Pool,
  configuration: ReturnType<typeof parseRecoveryUpgradeOperator>, base: Buffer, extension: Buffer) {
  // Validates both immutable input checksums before touching the database.
  const composed = composeVoiceLabMigration(base, extension);
  const client = await pool.connect();
  let sourceCatalog: string;
  let targetCatalog: string;
  try {
    // Refuse an unrelated/missing target before even temporary reference DDL.
    const metadata = await client.query("select schema_version,migration_sha256 from sophia_voice_lab.schema_metadata where singleton=true");
    if (metadata.rows.length !== 1 || Number(metadata.rows[0].schema_version) !== 3
      || metadata.rows[0].migration_sha256 !== BASE_MIGRATION_SHA256) throw new Error("UPGRADE_OPERATOR_SOURCE_INVALID");
    sourceCatalog = await referenceCatalog(client, base);
    targetCatalog = await referenceCatalog(client, composed);
  } finally { client.release(); }
  // The existing transactional primitive rechecks exact source catalog, locks
  // every source table, refuses recent workers/pending operations, rebinds the
  // full inventory and verifies the resulting catalog before its only commit.
  const result = await upgradeHistoricalRecovery(pool, configuration.partitions, extension,
    sourceCatalog, targetCatalog, configuration.quarantine);
  return { ...result, releaseCommit: configuration.expectedCommit, hostSealWritten: false,
    externalGatesChanged: false, admissionAuthorized: false };
}
