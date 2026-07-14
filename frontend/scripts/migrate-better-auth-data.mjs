import { Pool } from "pg";
import { createHash } from "node:crypto";

const TABLES = ["user", "account", "session", "verification"];
const SOURCE_REF = "qtyqgvdkbhjfmnfkxyvm";
const TARGET_REF = "vlxnwmyvhchwbousrdzc";
const targetRef = process.env.BETTER_AUTH_EXPECTED_SUPABASE_PROJECT_REF?.trim().toLowerCase() ?? TARGET_REF;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function projectRef(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const direct = parsed.hostname.match(/^db\.([a-z0-9]+)\.supabase\.(?:co|com)$/i)?.[1];
  const pooler = parsed.hostname.includes(".pooler.supabase.")
    ? decodeURIComponent(parsed.username).split(".").at(-1)
    : undefined;
  return (direct ?? pooler)?.toLowerCase();
}

function stableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function rowsHash(rows) {
  const normalized = [...rows]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map(stableValue);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function pool(databaseUrl) {
  return new Pool({ connectionString: databaseUrl, max: 1, ssl: { rejectUnauthorized: false } });
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function copyTable(source, target, table, apply) {
  const where = table === "session" || table === "verification" ? ' WHERE "expiresAt" > now()' : "";
  const result = await source.query(`SELECT * FROM ${quoteIdentifier(table)}${where}`);
  if (apply && result.rows.length) {
    const columns = Object.keys(result.rows[0]);
    const quotedColumns = columns.map(quoteIdentifier);
    const updates = columns
      .filter((column) => column !== "id")
      .map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
      .join(", ");
    for (const row of result.rows) {
      const values = columns.map((column) => row[column]);
      const placeholders = values.map((_, index) => `$${index + 1}`);
      await target.query(
        `INSERT INTO ${quoteIdentifier(table)} (${quotedColumns.join(", ")}) VALUES (${placeholders.join(", ")}) ` +
          `ON CONFLICT ("id") DO UPDATE SET ${updates}`,
        values,
      );
    }
  }
  let verified = false;
  if (apply && result.rows.length) {
    const ids = result.rows.map((row) => row.id);
    const targetRows = await target.query(
      `SELECT * FROM ${quoteIdentifier(table)} WHERE "id" = ANY($1::text[])`,
      [ids],
    );
    verified = rowsHash(result.rows) === rowsHash(targetRows.rows);
    if (!verified) throw new Error(`Better Auth row verification failed for ${table}`);
  }
  const targetCount = await target.query(`SELECT count(*)::bigint AS count FROM ${quoteIdentifier(table)}`);
  console.log(
    `table=${table} source_rows=${result.rows.length} target_rows=${targetCount.rows[0].count} verified=${verified} applied=${apply}`,
  );
}

const sourceUrl = required("BETTER_AUTH_SOURCE_DATABASE_URL");
const targetUrl = required("BETTER_AUTH_TARGET_DATABASE_URL");
if (sourceUrl === targetUrl) throw new Error("Source and target Better Auth databases must differ.");
if (projectRef(sourceUrl) !== SOURCE_REF) throw new Error("Better Auth copy source is not the required source project.");
if (projectRef(targetUrl) !== targetRef || targetRef !== TARGET_REF) {
  throw new Error("Better Auth copy target is not the required production target project.");
}
const apply = process.argv.includes("--apply");
const source = pool(sourceUrl);
const target = pool(targetUrl);

try {
  await target.query("BEGIN");
  for (const table of TABLES) await copyTable(source, target, table, apply);
  if (apply) await target.query("COMMIT");
  else await target.query("ROLLBACK");
} catch (error) {
  await target.query("ROLLBACK");
  throw error;
} finally {
  await Promise.all([source.end(), target.end()]);
}
