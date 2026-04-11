import { Pool, type PoolConfig } from "pg";

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
  const ssl = getBetterAuthSslConfig(databaseUrl);

  return new Pool({
    connectionString: databaseUrl,
    max: getBetterAuthPoolMax(),
    ...(ssl === undefined ? {} : { ssl }),
  });
}

export function getBetterAuthDatabase() {
  globalThis.__sophiaBetterAuthPool ??= createBetterAuthPool();
  return globalThis.__sophiaBetterAuthPool;
}