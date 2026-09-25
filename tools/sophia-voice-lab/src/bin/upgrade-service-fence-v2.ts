import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { parseServiceFenceUpgradeIntent, upgradeServiceFenceV2Schema } from "../service-fence-upgrade.js";

let pool: pg.Pool | undefined;
try {
  if (process.argv.length !== 2) throw new Error("Arguments unsupported");
  const intent = parseServiceFenceUpgradeIntent(process.env, "SOPHIA_VOICE_LAB_SERVICE_FENCE_V2_UPGRADE");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Database required");
  const read = (file: string) => readFile(path.resolve(process.cwd(), file));
  const [base, recovery, fence, fenceV2] = await Promise.all([read("../../backend/migrations/2026_08_23_sophia_voice_lab.sql"),
    read("migrations/004_recovery_controls.sql"), read("migrations/005_service_owner_fence.sql"), read("migrations/006_service_fence_v2.sql")]);
  pool = new pg.Pool({ connectionString: databaseUrl, max: 1,
    connectionTimeoutMillis: 15_000, statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000,
    application_name: "sophia-voice-lab-service-fence-v2-upgrade" });
  process.stdout.write(`${JSON.stringify(await upgradeServiceFenceV2Schema(pool, intent, base!, recovery!, fence!, fenceV2!))}\n`);
} catch {
  // A lost commit response is not rollback proof. Never print inputs or database errors.
  process.stderr.write(`${JSON.stringify({ schema: "sophia.voice-lab.service-fence-v2-upgrade-error.v1",
    code: "SERVICE_FENCE_V2_UPGRADE_FAILED", outcome: "unconfirmed", admissionAuthorized: false })}\n`);
  process.exitCode = 1;
} finally { await pool?.end(); }
