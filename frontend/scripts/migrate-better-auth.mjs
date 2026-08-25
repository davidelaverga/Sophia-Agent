import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Pool } from "pg";

import { resolveDatabaseTls } from "../src/server/better-auth/database-tls.mjs";

function getBetterAuthDatabaseUrl() {
  const databaseUrl = process.env.BETTER_AUTH_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "Better Auth migration requires BETTER_AUTH_DATABASE_URL or DATABASE_URL.",
    );
  }

  const fallbackUrl = process.env.BETTER_AUTH_DATABASE_URL ? process.env.DATABASE_URL : undefined;
  if (fallbackUrl && databaseTargetIdentity(fallbackUrl) !== databaseTargetIdentity(databaseUrl)) {
    throw new Error("BETTER_AUTH_DATABASE_URL and DATABASE_URL must identify the same database.");
  }
  const expectedRef = process.env.BETTER_AUTH_EXPECTED_SUPABASE_PROJECT_REF?.trim().toLowerCase();
  if (expectedRef) {
    const parsed = new URL(databaseUrl);
    const directMatch = parsed.hostname.toLowerCase().match(/^db\.([a-z0-9]+)\.supabase\.(?:co|com)$/);
    const username = decodeURIComponent(parsed.username);
    const poolerRef = parsed.hostname.includes(".pooler.supabase.")
      ? username.slice(username.lastIndexOf(".") + 1).toLowerCase()
      : null;
    const actualRef = directMatch?.[1] ?? poolerRef;
    if (actualRef !== expectedRef) {
      throw new Error("Better Auth migration target does not match the expected Supabase project.");
    }
  }

  return databaseUrl;
}

function supabaseProjectRef(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const directMatch = parsed.hostname.toLowerCase().match(/^db\.([a-z0-9]+)\.supabase\.(?:co|com)$/);
  if (directMatch) return directMatch[1] ?? null;
  if (parsed.hostname.includes(".pooler.supabase.")) {
    const username = decodeURIComponent(parsed.username);
    return username.slice(username.lastIndexOf(".") + 1).toLowerCase();
  }
  return null;
}

function databaseTargetIdentity(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const projectRef = supabaseProjectRef(databaseUrl);
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (projectRef) return `supabase:${projectRef}:${database}`;
  const protocol = parsed.protocol === "postgresql:" ? "postgres:" : parsed.protocol;
  const port = parsed.port || "5432";
  return `${protocol}//${parsed.hostname.toLowerCase()}:${port}/${database}`;
}

function getBetterAuthPoolMax() {
  const poolMax = Number.parseInt(process.env.BETTER_AUTH_DATABASE_POOL_MAX ?? "", 10);

  if (Number.isInteger(poolMax) && poolMax > 0) {
    return poolMax;
  }

  return process.env.NODE_ENV === "production" ? 1 : 10;
}

const databaseUrl = getBetterAuthDatabaseUrl();
const tls = resolveDatabaseTls({
  databaseUrl,
  modeRaw: process.env.BETTER_AUTH_DATABASE_SSL_MODE,
  caPemRaw: process.env.BETTER_AUTH_DATABASE_SSL_CA,
  environmentRaw: process.env.NODE_ENV,
});
const pool = new Pool({
  connectionString: tls.connectionString,
  max: getBetterAuthPoolMax(),
  ...(tls.ssl === undefined ? {} : { ssl: tls.ssl }),
});

const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  database: pool,
});

try {
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);

  if (toBeCreated.length === 0 && toBeAdded.length === 0) {
    console.log("Better Auth schema already up to date.");
  } else {
    await runMigrations();
    console.log("Better Auth schema migrated successfully.");
  }
} finally {
  await pool.end();
}
