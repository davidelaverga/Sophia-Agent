import { Pool, type PoolConfig } from "pg";

import { resolveDatabaseTls } from "./database-tls.mjs";
import { validateBetterAuthDatabaseProject } from "./project-ref";

export {
  normalizeDatabaseUrlForExplicitTls,
  resolveDatabaseTls,
} from "./database-tls.mjs";

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

function getBetterAuthPoolMax() {
  const poolMax = Number.parseInt(process.env.BETTER_AUTH_DATABASE_POOL_MAX ?? "", 10);

  if (Number.isInteger(poolMax) && poolMax > 0) {
    return poolMax;
  }

  return process.env.NODE_ENV === "production" ? 1 : 10;
}

function createBetterAuthPool() {
  const databaseUrl = getBetterAuthDatabaseUrl();
  const tls = resolveDatabaseTls({
    databaseUrl,
    modeRaw: process.env.BETTER_AUTH_DATABASE_SSL_MODE,
    caPemRaw: process.env.BETTER_AUTH_DATABASE_SSL_CA,
    environmentRaw: process.env.NODE_ENV,
  });

  return new Pool({
    connectionString: tls.connectionString,
    max: getBetterAuthPoolMax(),
    // Explicit pg_temp placement matters: when it is omitted PostgreSQL searches
    // the temporary schema before the listed path, which would let Better Auth's
    // library-owned unqualified session/user queries resolve to a temp shadow.
    options: "-c search_path=pg_catalog,public,pg_temp",
    ...(tls.ssl === undefined ? {} : { ssl: tls.ssl as PoolConfig["ssl"] }),
  });
}

export function getBetterAuthDatabase() {
  globalThis.__sophiaBetterAuthPool ??= createBetterAuthPool();
  return globalThis.__sophiaBetterAuthPool;
}
