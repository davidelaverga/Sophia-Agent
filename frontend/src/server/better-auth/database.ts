import { Pool, type PoolConfig } from "pg";

import { validateBetterAuthDatabaseProject } from "./project-ref";

type BetterAuthSslMode = "auto" | "disable" | "require" | "no-verify";

declare global {
  var __sophiaBetterAuthPool: Pool | undefined;
}

function getBetterAuthDatabaseUrl() {
  const databaseUrl = process.env.BETTER_AUTH_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "Better Auth requires BETTER_AUTH_DATABASE_URL or DATABASE_URL when auth bypass is disabled.",
    );
  }

  validateBetterAuthDatabaseProject(
    databaseUrl,
    process.env.BETTER_AUTH_DATABASE_URL ? process.env.DATABASE_URL : undefined,
    process.env.BETTER_AUTH_EXPECTED_SUPABASE_PROJECT_REF,
  );

  return databaseUrl;
}

function getBetterAuthSslMode(): BetterAuthSslMode {
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

export function applyBetterAuthSslModeToDatabaseUrl(
  databaseUrl: string,
  sslMode: BetterAuthSslMode,
) {
  if (sslMode !== "no-verify") {
    return databaseUrl;
  }

  const normalizedUrl = new URL(databaseUrl);

  // node-postgres reparses connectionString after the surrounding Pool config
  // and lets URL SSL parameters replace the explicit `ssl` object. Encode the
  // approved no-verify mode into the connection string as well so an existing
  // `sslmode=require` value cannot silently restore certificate validation.
  normalizedUrl.searchParams.delete("sslmode");
  normalizedUrl.searchParams.delete("sslcert");
  normalizedUrl.searchParams.delete("sslkey");
  normalizedUrl.searchParams.delete("sslrootcert");
  normalizedUrl.searchParams.set("ssl", "no-verify");

  return normalizedUrl.toString();
}

function isSupabaseHost(hostname: string) {
  return hostname.includes("supabase.co") || hostname.includes("supabase.com");
}

function getBetterAuthSslConfig(databaseUrl: string): PoolConfig["ssl"] {
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

function createBetterAuthPool() {
  const databaseUrl = getBetterAuthDatabaseUrl();
  const sslMode = getBetterAuthSslMode();
  const ssl = getBetterAuthSslConfig(databaseUrl);

  return new Pool({
    connectionString: applyBetterAuthSslModeToDatabaseUrl(databaseUrl, sslMode),
    max: getBetterAuthPoolMax(),
    // Explicit pg_temp placement matters: when it is omitted PostgreSQL searches
    // the temporary schema before the listed path, which would let Better Auth's
    // library-owned unqualified session/user queries resolve to a temp shadow.
    options: "-c search_path=pg_catalog,public,pg_temp",
    ...(ssl === undefined ? {} : { ssl }),
  });
}

export function getBetterAuthDatabase() {
  globalThis.__sophiaBetterAuthPool ??= createBetterAuthPool();
  return globalThis.__sophiaBetterAuthPool;
}
