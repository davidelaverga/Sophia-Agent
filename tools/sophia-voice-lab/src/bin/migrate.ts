import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { canonicalRequestHash } from "../security.js";
import { attestVoiceLabSchema, inspectMigrationPreflight, readVoiceLabCatalog, VOICE_LAB_MIGRATION_SHA256, VOICE_LAB_SCHEMA_VERSION, VOICE_LAB_TABLES, writeReleaseSchemaSeal } from "../schema-attestation.js";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required to migrate Sophia Voice Lab.");

const defaultPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../backend/migrations/2026_08_23_sophia_voice_lab.sql");
const configuredPath = process.env.SOPHIA_VOICE_LAB_MIGRATION_PATH?.trim();
if (configuredPath && process.env.NODE_ENV === "production" && await realpath(configuredPath) !== await realpath(defaultPath)) throw new Error("Production migration path must be the immutable bundled Voice Lab migration.");
const migrationPath = configuredPath || defaultPath;
const sqlBytes = await readFile(migrationPath);
const migrationSha256 = createHash("sha256").update(sqlBytes).digest("hex");
if (migrationSha256 !== VOICE_LAB_MIGRATION_SHA256) throw new Error("Voice Lab migration bytes do not match the compiled release checksum.");
const client = new Client({ connectionString: databaseUrl, application_name: "sophia-voice-lab-migrate" });
await client.connect();
let locked = false;
try {
  await client.query("select pg_advisory_lock(hashtext('sophia_voice_lab_schema_v3'))");
  locked = true;
  // Build the release expectation in a fresh isolated schema from the exact
  // checksum-pinned migration bytes. This is deliberately independent of the
  // target schema, so IF NOT EXISTS can never bless pre-existing drift.
  const expectedCatalogSha256 = await buildReferenceCatalog(client, sqlBytes.toString("utf8"));
  await inspectMigrationPreflight(client, expectedCatalogSha256);
  await client.query(sqlBytes.toString("utf8"));
  const catalogSha256 = canonicalRequestHash(await readVoiceLabCatalog(client));
  if (catalogSha256 !== expectedCatalogSha256) throw new Error("Voice Lab migration postflight differs from the release reference catalog.");
  const updated = await client.query(
    `update sophia_voice_lab.schema_metadata set schema_version=$1,migration_sha256=$2,catalog_sha256=$3,updated_at=now() where singleton=true returning singleton`,
    [VOICE_LAB_SCHEMA_VERSION, VOICE_LAB_MIGRATION_SHA256, expectedCatalogSha256],
  );
  if (updated.rowCount !== 1) throw new Error("Voice Lab schema metadata singleton was not updated.");
  const attestation = await attestVoiceLabSchema(client, true, expectedCatalogSha256);
  if (!attestation.ok) throw new Error(`Voice Lab migration postflight failed: ${attestation.detail}`);
  await writeReleaseSchemaSeal(expectedCatalogSha256);
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  if (locked) await client.query("select pg_advisory_unlock(hashtext('sophia_voice_lab_schema_v3'))").catch(() => undefined);
  await client.end();
}

async function buildReferenceCatalog(database: pg.Client, sourceSql: string): Promise<string> {
  const referenceSchema = `sophia_voice_lab_ref_${randomBytes(8).toString("hex")}`;
  const referenceSql = sourceSql.replace(/\bsophia_voice_lab\b/g, referenceSchema);
  try {
    await database.query(referenceSql);
    const catalog = await readVoiceLabCatalog(database, referenceSchema);
    const tableNames = (catalog.tables as Array<{ name: string }>).map((table) => table.name).sort();
    if (JSON.stringify(tableNames) !== JSON.stringify([...VOICE_LAB_TABLES].sort())) throw new Error("Voice Lab reference migration did not produce the exact table set.");
    return canonicalRequestHash(catalog);
  } catch (error) {
    await database.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await database.query(`drop schema if exists ${referenceSchema} cascade`).catch(() => undefined);
  }
}
