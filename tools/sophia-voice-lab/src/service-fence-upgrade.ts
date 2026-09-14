import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { composeVoiceLabMigration } from "./migration-bundle.js";
import { composeServiceFenceMigration, SERVICE_FENCE_BUNDLE_SHA256, SERVICE_FENCE_SOURCE_BUNDLE_SHA256, SERVICE_FENCE_SCHEMA_VERSION } from "./service-fence-migration.js";
import { readVoiceLabCatalog, VOICE_LAB_TABLES } from "./schema-attestation.js";
import { canonicalRequestHash } from "./security.js";

export function parseServiceFenceUpgradeIntent(env: NodeJS.ProcessEnv) {
  const commit = env.SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_EXPECTED_COMMIT;
  const inventory = env.SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_INVENTORY_SHA256;
  if (env.SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_APPROVED !== "YES" || env.SOPHIA_VOICE_LAB_KILL_SWITCH !== "true"
    || !commit || !/^[a-f0-9]{40}$/.test(commit) || (env.RENDER_GIT_COMMIT || env.COMMIT_SHA) !== commit
    || !inventory || !/^[a-f0-9]{64}$/.test(inventory)) throw new Error("SERVICE_FENCE_UPGRADE_INTENT_INVALID");
  return { commit, inventorySha256: inventory };
}

/** Content-free commitment to every durable ownership and historical exception
 * row. Sorting by exact serialized row makes pagination/order irrelevant. */
export async function serviceFenceInventory(client: pg.PoolClient) {
  const hashes: Record<string, string> = {};
  for (const table of ["recovery_controls", "browser_leases", "historical_quarantine", "historical_admission_exceptions", "retention_tombstones"] as const) {
    const rows = await client.query<{ value: string }>(`select row_to_json(t)::text as value from sophia_voice_lab.${table} t order by row_to_json(t)::text limit 10001`);
    if (rows.rows.length > 10000) throw new Error("SERVICE_FENCE_UPGRADE_INVENTORY_BOUND");
    const digest = createHash("sha256"); let bytes = 0;
    for (const row of rows.rows) {
      bytes += Buffer.byteLength(row.value);
      if (bytes > 50_000_000) throw new Error("SERVICE_FENCE_UPGRADE_INVENTORY_BOUND");
      digest.update(String(Buffer.byteLength(row.value))).update(":").update(row.value);
    }
    hashes[table] = digest.digest("hex");
  }
  return canonicalRequestHash(hashes);
}

async function reference(client: pg.PoolClient, bytes: Buffer) {
  const name = `sophia_voice_lab_ref_${randomBytes(8).toString("hex")}`;
  const sql = bytes.toString("utf8");
  if (!/^begin;\n/.test(sql) || !/\ncommit;\s*$/.test(sql)) throw new Error("SERVICE_FENCE_REFERENCE_ENVELOPE_INVALID");
  await client.query("begin");
  try {
    await client.query("set local statement_timeout='30s'");
    await client.query(sql.replace(/^begin;\n/, "").replace(/\ncommit;\s*$/, "").replace(/\bsophia_voice_lab\b/g, name));
    return canonicalRequestHash(await readVoiceLabCatalog(client, name));
  } finally { await client.query("rollback"); }
}

/** Consistent read-only operator snapshot. Matching metadata is not a release
 * attestation; the upgrade independently derives and checks both catalogs. */
export async function readServiceFenceUpgradeInventory(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    await client.query("set local statement_timeout='30s'");
    const metadata = await client.query("select schema_version,migration_sha256,catalog_sha256 from sophia_voice_lab.schema_metadata where singleton=true");
    if (metadata.rows.length !== 1) throw new Error("SERVICE_FENCE_INVENTORY_METADATA_INVALID");
    const row = metadata.rows[0];
    if (![4, 5].includes(Number(row.schema_version)) || !/^[a-f0-9]{64}$/.test(row.migration_sha256)
      || !/^[a-f0-9]{64}$/.test(row.catalog_sha256)) throw new Error("SERVICE_FENCE_INVENTORY_METADATA_INVALID");
    const catalogSha256 = canonicalRequestHash(await readVoiceLabCatalog(client));
    const inventorySha256 = await serviceFenceInventory(client);
    await client.query("commit");
    return { schema: "sophia.voice-lab.service-fence-inventory.v1", schemaVersion: Number(row.schema_version),
      migrationSha256: row.migration_sha256 as string, catalogSha256, metadataCatalogSha256: row.catalog_sha256 as string,
      catalogMatchesMetadata: catalogSha256 === row.catalog_sha256, inventorySha256,
      upgradeAuthorized: false, cleanupProven: false };
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
  finally { client.release(); }
}

/** No startup invocation, no host seal, no new admission, no row backfill.
 * External deployment control must close gates and stop workers first. */
export async function upgradeServiceFenceSchema(pool: pg.Pool, intent: ReturnType<typeof parseServiceFenceUpgradeIntent>, base: Buffer, recovery: Buffer, fence: Buffer) {
  if (!/^[a-f0-9]{40}$/.test(intent.commit) || !/^[a-f0-9]{64}$/.test(intent.inventorySha256)) throw new Error("SERVICE_FENCE_UPGRADE_INTENT_INVALID");
  const source = composeVoiceLabMigration(base, recovery);
  const target = composeServiceFenceMigration(base, recovery, fence);
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  if (hash(source) !== SERVICE_FENCE_SOURCE_BUNDLE_SHA256 || hash(target) !== SERVICE_FENCE_BUNDLE_SHA256) throw new Error("SERVICE_FENCE_UPGRADE_BUNDLE_INVALID");
  const client = await pool.connect();
  try {
    const metadata = await client.query("select schema_version,migration_sha256 from sophia_voice_lab.schema_metadata where singleton=true");
    const row = metadata.rows[0];
    if (metadata.rows.length !== 1 || !((Number(row.schema_version) === 4 && row.migration_sha256 === SERVICE_FENCE_SOURCE_BUNDLE_SHA256)
      || (Number(row.schema_version) === SERVICE_FENCE_SCHEMA_VERSION && row.migration_sha256 === SERVICE_FENCE_BUNDLE_SHA256))) throw new Error("SERVICE_FENCE_UPGRADE_SOURCE_INVALID");
    const sourceCatalog = await reference(client, source), targetCatalog = await reference(client, target);
    await client.query("begin");
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='30s'");
    await client.query("select pg_advisory_xact_lock(hashtext('sophia_voice_lab_schema_v3'))");
    await client.query(`lock table ${VOICE_LAB_TABLES.map(t => `sophia_voice_lab.${t}`).join(",")} in access exclusive mode`);
    const current = await client.query("select schema_version,migration_sha256,catalog_sha256 from sophia_voice_lab.schema_metadata where singleton=true");
    const actual = canonicalRequestHash(await readVoiceLabCatalog(client));
    if (current.rows.length !== 1) throw new Error("SERVICE_FENCE_UPGRADE_SOURCE_INVALID");
    const state = current.rows[0];
    const replay = Number(state.schema_version) === SERVICE_FENCE_SCHEMA_VERSION && state.migration_sha256 === SERVICE_FENCE_BUNDLE_SHA256 && state.catalog_sha256 === targetCatalog && actual === targetCatalog;
    if (!replay && !(Number(state.schema_version) === 4 && state.migration_sha256 === SERVICE_FENCE_SOURCE_BUNDLE_SHA256 && state.catalog_sha256 === sourceCatalog && actual === sourceCatalog)) throw new Error("SERVICE_FENCE_UPGRADE_CATALOG_DRIFT");
    const quiet = await client.query(`select exists(select 1 from sophia_voice_lab.worker_heartbeats where observed_at>clock_timestamp()-interval '30 seconds') as workers,
      exists(select 1 from sophia_voice_lab.operations where state in ('accepted','queued','leased','executing')) as operations`);
    if (quiet.rows[0].workers || quiet.rows[0].operations) throw new Error("SERVICE_FENCE_UPGRADE_NOT_QUIESCENT");
    const before = await serviceFenceInventory(client);
    if (before !== intent.inventorySha256) throw new Error("SERVICE_FENCE_UPGRADE_INVENTORY_DRIFT");
    if (!replay) {
      await client.query(fence.toString("utf8"));
      if (canonicalRequestHash(await readVoiceLabCatalog(client)) !== targetCatalog || await serviceFenceInventory(client) !== before) throw new Error("SERVICE_FENCE_UPGRADE_POSTFLIGHT_DRIFT");
      const updated = await client.query("update sophia_voice_lab.schema_metadata set schema_version=$1,migration_sha256=$2,catalog_sha256=$3,updated_at=now() where singleton=true", [SERVICE_FENCE_SCHEMA_VERSION, SERVICE_FENCE_BUNDLE_SHA256, targetCatalog]);
      if (updated.rowCount !== 1) throw new Error("SERVICE_FENCE_UPGRADE_METADATA_INVALID");
    }
    await client.query("commit");
    return { schema: "sophia.voice-lab.service-fence-upgrade.v1", replay, releaseCommit: intent.commit, catalogSha256: targetCatalog,
      inventorySha256: before, retainedObligationsChanged: false, hostSealWritten: false, admissionAuthorized: false };
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
  finally { client.release(); }
}
