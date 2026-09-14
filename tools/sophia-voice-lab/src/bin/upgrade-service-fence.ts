import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { parseServiceFenceUpgradeIntent, upgradeServiceFenceSchema } from "../service-fence-upgrade.js";

let pool: pg.Pool | undefined;
try {
  if (process.argv.length !== 2) throw new Error("Arguments unsupported");
  const intent = parseServiceFenceUpgradeIntent(process.env);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Database required");
  const base = await readFile(path.resolve(process.cwd(), "../../backend/migrations/2026_08_23_sophia_voice_lab.sql"));
  const recovery = await readFile(path.resolve(process.cwd(), "migrations/004_recovery_controls.sql"));
  const fence = await readFile(path.resolve(process.cwd(), "migrations/005_service_owner_fence.sql"));
  pool = new pg.Pool({ connectionString: databaseUrl, max: 1,
    connectionTimeoutMillis: 15_000, statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000,
    application_name: "sophia-voice-lab-service-fence-upgrade" });
  process.stdout.write(`${JSON.stringify(await upgradeServiceFenceSchema(pool, intent, base, recovery, fence))}\n`);
} catch {
  // A lost commit response is not rollback proof. Never print inputs or database errors.
  process.stderr.write(`${JSON.stringify({ schema: "sophia.voice-lab.service-fence-upgrade-error.v1",
    code: "SERVICE_FENCE_UPGRADE_FAILED", outcome: "unconfirmed", admissionAuthorized: false })}\n`);
  process.exitCode = 1;
} finally { await pool?.end(); }
