import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalRequestHash } from "../src/security.js";
import { attestVoiceLabSchema, inspectMigrationPreflight, readReleaseSchemaSeal, readVoiceLabCatalog, VOICE_LAB_MIGRATION_SHA256, VOICE_LAB_SCHEMA_VERSION, VOICE_LAB_TABLES, writeReleaseSchemaSeal } from "../src/schema-attestation.js";

class CatalogDatabase {
  catalogHash: string | null = null;
  privileges = true;
  foreignAcl = false;
  missingTable: string | null = null;
  schemaExists = true;
  metadataExists = true;
  empty = false;
  columnType = "text";
  columnAcl = "";
  schemaOwner = "runtime";
  tableOwner = "runtime";
  functionOwner = "runtime";
  sequenceOwner = "runtime";
  schemaAcl: unknown[] = [{ grantee: "owner", grantor: "owner", privilege: "USAGE", grantable: false }];
  tableAcl: unknown[] = [{ grantee: "owner", grantor: "owner", privilege: "SELECT", grantable: false }];
  functionAcl: unknown[] = [{ grantee: "owner", grantor: "owner", privilege: "EXECUTE", grantable: false }];
  sequenceAcl: unknown[] = [{ grantee: "owner", grantor: "owner", privilege: "USAGE", grantable: false }];
  constraintDefinition = "CHECK ((id <> ''::text))";
  indexDefinition = "CREATE INDEX fixture_idx ON <voice_lab_schema>.runs USING btree (id)";

  async query<T = any>(sql: string, _params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    const compact = sql.replace(/\s+/g, " ");
    let rows: any[] = [];
    if (compact.includes("as schema_exists") && compact.includes("as metadata_exists")) rows = [{ schema_exists: this.schemaExists, metadata_exists: this.metadataExists }];
    else if (compact.includes("select schema_version,migration_sha256,catalog_sha256")) rows = [{ schema_version: VOICE_LAB_SCHEMA_VERSION, migration_sha256: VOICE_LAB_MIGRATION_SHA256, catalog_sha256: this.catalogHash }];
    else if (compact.includes("from pg_namespace n where")) rows = [{ schema_name: "sophia_voice_lab", owner: this.schemaOwner, normalized_acl: this.schemaAcl }];
    else if (compact.includes("c.relkind in ('r','p') order by c.relname")) rows = this.empty ? [] : VOICE_LAB_TABLES.filter((name) => name !== this.missingTable).map((name) => ({ name, relkind: "r", relpersistence: "p", relrowsecurity: false, relforcerowsecurity: false, owner: this.tableOwner, normalized_acl: this.tableAcl }));
    else if (compact.includes("from pg_attribute a") && !compact.includes("as columns_ready")) rows = this.empty ? [] : VOICE_LAB_TABLES.filter((name) => name !== this.missingTable).map((table_name) => ({ table_name, attnum: 1, column_name: "id", data_type: this.columnType, attnotnull: true, column_default: "", attidentity: "", attgenerated: "", column_acl: this.columnAcl }));
    else if (compact.includes("from pg_constraint con")) rows = this.empty ? [] : [{ table_name: "runs", conname: "fixture_check", contype: "c", definition: this.constraintDefinition }];
    else if (compact.includes("from pg_indexes")) rows = this.empty ? [] : [{ tablename: "runs", indexname: "fixture_idx", indexdef: this.indexDefinition }];
    else if (compact.includes("as schema_usage")) rows = [{ schema_usage: this.privileges, tables_ready: this.privileges, columns_ready: this.privileges, sequences_ready: this.privileges, functions_ready: this.privileges, public_schema: false, public_tables: false, public_columns: false, public_sequences: false, public_functions: false, foreign_acl: this.foreignAcl }];
    else if (compact.includes("from pg_proc p")) rows = this.empty ? [] : [{ proname: "fixture_fn", arguments: "", result: "trigger", provolatile: "v", prosecdef: false, proleakproof: false, proparallel: "u", definition: "CREATE FUNCTION sophia_voice_lab.fixture_fn() RETURNS trigger LANGUAGE plpgsql AS $$ begin return new; end $$", owner: this.functionOwner, normalized_acl: this.functionAcl }];
    else if (compact.includes("from pg_trigger t")) rows = [];
    else if (compact.includes("join pg_sequence")) rows = this.empty ? [] : [{ name: "fixture_seq", data_type: "bigint", seqstart: "1", seqincrement: "1", seqmax: "9223372036854775807", seqmin: "1", seqcache: "1", seqcycle: false, owner: this.sequenceOwner, normalized_acl: this.sequenceAcl, owned_by: "auth_audit.id" }];
    else if (compact.includes("c.relkind in ('v','m','f','c')")) rows = [];
    else if (compact.includes("from pg_type t")) rows = [];
    else if (compact.includes("from pg_policy p")) rows = [];
    else if (compact.includes("from pg_operator o")) rows = [];
    else if (compact.includes("from pg_collation c")) rows = [];
    else if (compact.includes("from pg_conversion c")) rows = [];
    else if (compact.startsWith("insert into sophia_voice_lab.auth_audit")) rows = [{ id: 1 }];
    return { rows: rows as T[], rowCount: rows.length };
  }
}

class SingleFlightCatalogDatabase extends CatalogDatabase {
  activeQueries = 0;
  overlappingQueries = 0;

  override async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    if (this.activeQueries !== 0) {
      this.overlappingQueries += 1;
      throw new Error("query overlap on a single PostgreSQL client");
    }
    this.activeQueries += 1;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return await super.query<T>(sql, params);
    } finally {
      this.activeQueries -= 1;
    }
  }
}

class PostgreSql17NullColumnAclDatabase extends CatalogDatabase {
  override async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    const compact = sql.replace(/\s+/g, " ");
    if (compact.includes("as schema_usage")
      && (compact.includes("aclexplode(coalesce(a.attacl,'{}'::aclitem[]))")
        || compact.includes("aclexplode(coalesce(at.attacl,'{}'::aclitem[]))"))) {
      const error = new Error("invalid empty ACL array");
      Object.assign(error, { code: "22023", routine: "check_acl" });
      throw error;
    }
    return super.query<T>(sql, params);
  }
}

class PhaseFailureDatabase extends CatalogDatabase {
  failSqlIncludes: string | null = null;

  override async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    if (this.failSqlIncludes && sql.replace(/\s+/g, " ").includes(this.failSqlIncludes)) {
      throw new Error("secret database host and query detail must not escape");
    }
    return super.query<T>(sql, params);
  }
}

describe("pinned PostgreSQL schema attestation", () => {
  it("serializes the catalog sweep for a checked-out PostgreSQL client", async () => {
    const database = new SingleFlightCatalogDatabase();
    const expected = canonicalRequestHash(await readVoiceLabCatalog(database as any));
    database.catalogHash = expected;
    await expect(attestVoiceLabSchema(database as any, true, expected)).resolves.toMatchObject({ ok: true, detail: "schema-attested" });
    expect(database.overlappingQueries).toBe(0);
    expect(database.activeQueries).toBe(0);
  });

  it("treats null PostgreSQL 17 column ACLs as zero grants without constructing an invalid empty ACL", async () => {
    const database = new PostgreSql17NullColumnAclDatabase();
    const expected = canonicalRequestHash(await readVoiceLabCatalog(database as any));
    database.catalogHash = expected;
    await expect(attestVoiceLabSchema(database as any, true, expected)).resolves.toMatchObject({ ok: true, detail: "schema-attested" });
  });

  it("reports bounded phase diagnostics without exposing database error values", async () => {
    const reference = new CatalogDatabase();
    const expected = canonicalRequestHash(await readVoiceLabCatalog(reference as any));
    for (const [sql, detail] of [
      ["select schema_version,migration_sha256,catalog_sha256", "schema-attestation-unavailable:metadata:database-query-failed"],
      ["from pg_indexes", "schema-attestation-unavailable:catalog:database-query-failed"],
      ["as schema_usage", "schema-attestation-unavailable:privileges:database-query-failed"],
      ["begin", "schema-attestation-unavailable:dml-begin:database-query-failed"],
      ["select singleton from sophia_voice_lab.schema_metadata", "schema-attestation-unavailable:dml-select:database-query-failed"],
      ["insert into sophia_voice_lab.auth_audit", "schema-attestation-unavailable:dml-insert:database-query-failed"],
      ["delete from sophia_voice_lab.auth_audit", "schema-attestation-unavailable:dml-delete:database-query-failed"],
      ["rollback", "schema-attestation-unavailable:dml-rollback:database-query-failed"],
    ] as const) {
      const database = new PhaseFailureDatabase();
      database.catalogHash = expected;
      database.failSqlIncludes = sql;
      const attestation = await attestVoiceLabSchema(database as any, true, expected);
      expect(attestation).toMatchObject({ ok: false, detail });
      expect(attestation.detail).not.toContain("secret");
    }
  });

  it("binds runtime readiness to an independently supplied release catalog and positive role privileges", async () => {
    const reference = new CatalogDatabase();
    const expected = canonicalRequestHash(await readVoiceLabCatalog(reference as any));
    const database = new CatalogDatabase();
    database.catalogHash = expected;
    await expect(attestVoiceLabSchema(database as any, true, expected)).resolves.toMatchObject({ ok: true, detail: "schema-attested", catalogSha256: expected });
    database.privileges = false;
    await expect(attestVoiceLabSchema(database as any, false, expected)).resolves.toMatchObject({ ok: false, detail: "schema-privilege-mismatch" });
  });

  it("fails closed on a missing table, wrong column/constraint/index, or foreign ACL", async () => {
    const reference = new CatalogDatabase();
    const expected = canonicalRequestHash(await readVoiceLabCatalog(reference as any));
    for (const mutate of [
      (database: CatalogDatabase) => { database.missingTable = "oauth_refresh_tokens"; },
      (database: CatalogDatabase) => { database.columnType = "integer"; },
      (database: CatalogDatabase) => { database.columnAcl = "{=r/public}"; },
      (database: CatalogDatabase) => { database.constraintDefinition = "CHECK ((id IS NOT NULL))"; },
      (database: CatalogDatabase) => { database.indexDefinition = "CREATE INDEX fixture_idx ON <voice_lab_schema>.runs USING hash (id)"; },
      (database: CatalogDatabase) => { database.schemaOwner = "foreign:42"; },
      (database: CatalogDatabase) => { database.tableOwner = "foreign:42"; },
      (database: CatalogDatabase) => { database.functionOwner = "foreign:42"; },
      (database: CatalogDatabase) => { database.sequenceOwner = "foreign:42"; },
      (database: CatalogDatabase) => { database.tableAcl = [...database.tableAcl, { grantee: "foreign:42", grantor: "owner", privilege: "SELECT", grantable: false }]; },
    ]) {
      const database = new CatalogDatabase();
      database.catalogHash = expected;
      mutate(database);
      const attestation = await attestVoiceLabSchema(database as any, false, expected);
      expect(attestation.ok).toBe(false);
      expect(["schema-table-set-mismatch", "schema-catalog-drift"]).toContain(attestation.detail);
    }
    const database = new CatalogDatabase();
    database.catalogHash = expected;
    database.foreignAcl = true;
    await expect(attestVoiceLabSchema(database as any, false, expected)).resolves.toMatchObject({ ok: false, detail: "schema-privilege-mismatch" });
  });

  it("allows only an absent/empty first install or an exactly attested rerun", async () => {
    const reference = new CatalogDatabase();
    const expected = canonicalRequestHash(await readVoiceLabCatalog(reference as any));
    const absent = new CatalogDatabase();
    absent.schemaExists = false;
    absent.metadataExists = false;
    await expect(inspectMigrationPreflight(absent as any, expected)).resolves.toBe("fresh");
    const empty = new CatalogDatabase();
    empty.metadataExists = false;
    empty.empty = true;
    await expect(inspectMigrationPreflight(empty as any, expected)).resolves.toBe("fresh");
    const partial = new CatalogDatabase();
    partial.metadataExists = false;
    await expect(inspectMigrationPreflight(partial as any, expected)).rejects.toThrow("partial pre-existing schema");
    const rerun = new CatalogDatabase();
    rerun.catalogHash = expected;
    await expect(inspectMigrationPreflight(rerun as any, expected)).resolves.toBe("rerun");
    const legacyMetadata = new CatalogDatabase();
    legacyMetadata.catalogHash = "0".repeat(64);
    await expect(inspectMigrationPreflight(legacyMetadata as any, expected)).resolves.toBe("rerun");
    rerun.columnType = "integer";
    await expect(inspectMigrationPreflight(rerun as any, expected)).rejects.toThrow("pre-existing schema drift");
  });

  it("pins the immutable centralized migration bytes and rejects a one-byte mutation", async () => {
    const migration = await readFile(path.resolve(process.cwd(), "../../backend/migrations/2026_08_23_sophia_voice_lab.sql"));
    expect(createHash("sha256").update(migration).digest("hex")).toBe(VOICE_LAB_MIGRATION_SHA256);
    expect(createHash("sha256").update(Buffer.concat([migration, Buffer.from("\n-- tampered")])).digest("hex")).not.toBe(VOICE_LAB_MIGRATION_SHA256);
  });

  it("writes and strictly reads the release catalog seal used by web and worker startup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "voice-lab-schema-seal-"));
    const sealPath = path.join(directory, "seal.json");
    try {
      const expected = "a".repeat(64);
      await writeReleaseSchemaSeal(expected, sealPath);
      await expect(readReleaseSchemaSeal(sealPath)).resolves.toEqual({ schema_version: VOICE_LAB_SCHEMA_VERSION, migration_sha256: VOICE_LAB_MIGRATION_SHA256, catalog_sha256: expected });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
