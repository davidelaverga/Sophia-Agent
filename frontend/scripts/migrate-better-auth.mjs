import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Pool } from "pg";

function getBetterAuthDatabaseUrl() {
  const databaseUrl = process.env.BETTER_AUTH_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "Better Auth migration requires BETTER_AUTH_DATABASE_URL or DATABASE_URL.",
    );
  }

  return databaseUrl;
}

function getBetterAuthSslMode() {
  const sslMode = process.env.BETTER_AUTH_DATABASE_SSL_MODE?.trim().toLowerCase();

  if (
    sslMode === "auto" ||
    sslMode === "disable" ||
    sslMode === "require" ||
    sslMode === "no-verify"
  ) {
    return sslMode;
  }

  return "auto";
}

function isSupabaseHost(hostname) {
  return hostname.includes("supabase.co") || hostname.includes("supabase.com");
}

function getBetterAuthSslConfig(databaseUrl) {
  const normalizedUrl = new URL(databaseUrl);
  const sslMode = getBetterAuthSslMode();
  const querySslMode = normalizedUrl.searchParams.get("sslmode")?.trim().toLowerCase();
  const explicitSsl = normalizedUrl.searchParams.get("ssl")?.trim().toLowerCase();

  if (sslMode === "disable" || querySslMode === "disable" || explicitSsl === "false") {
    return false;
  }

  if (sslMode === "require") {
    return { rejectUnauthorized: true };
  }

  if (sslMode === "no-verify") {
    return { rejectUnauthorized: false };
  }

  if (querySslMode === "require" || querySslMode === "verify-ca" || querySslMode === "verify-full") {
    return isSupabaseHost(normalizedUrl.hostname)
      ? { rejectUnauthorized: false }
      : { rejectUnauthorized: true };
  }

  if (explicitSsl === "true" || isSupabaseHost(normalizedUrl.hostname)) {
    return { rejectUnauthorized: false };
  }

  return undefined;
}

function getBetterAuthPoolMax() {
  const poolMax = Number.parseInt(process.env.BETTER_AUTH_DATABASE_POOL_MAX ?? "", 10);

  if (Number.isInteger(poolMax) && poolMax > 0) {
    return poolMax;
  }

  return process.env.NODE_ENV === "production" ? 1 : 10;
}

const databaseUrl = getBetterAuthDatabaseUrl();
const ssl = getBetterAuthSslConfig(databaseUrl);
const pool = new Pool({
  connectionString: databaseUrl,
  max: getBetterAuthPoolMax(),
  ...(ssl === undefined ? {} : { ssl }),
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