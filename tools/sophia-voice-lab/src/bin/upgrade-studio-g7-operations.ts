import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { parseServiceFenceUpgradeIntent, upgradeStudioG7OperationsSchema } from "../service-fence-upgrade.js";

// Voice Lab schema v6 -> v7 (additive `studio_action` operation type).
// Same attested, quiescent, operator-approved path as the v5 -> v6 upgrade,
// under its own approval prefix: SOPHIA_VOICE_LAB_STUDIO_G7_OPERATIONS_UPGRADE_*.
let pool: pg.Pool | undefined;
try {
  if (process.argv.length !== 2) throw new Error("Arguments unsupported");
  const intent = parseServiceFenceUpgradeIntent(process.env, "SOPHIA_VOICE_LAB_STUDIO_G7_OPERATIONS_UPGRADE");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Database required");
  const read = (file: string) => readFile(path.resolve(process.cwd(), file));
  const [base, recovery, fence, fenceV2, studioOperations] = await Promise.all([read("../../backend/migrations/2026_08_23_sophia_voice_lab.sql"),
    read("migrations/004_recovery_controls.sql"), read("migrations/005_service_owner_fence.sql"), read("migrations/006_service_fence_v2.sql"),
    read("migrations/007_studio_g7_operations.sql")]);
  pool = new pg.Pool({ connectionString: databaseUrl, max: 1,
    connectionTimeoutMillis: 15_000, statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000,
    application_name: "sophia-voice-lab-studio-g7-operations-upgrade" });
  process.stdout.write(`${JSON.stringify(await upgradeStudioG7OperationsSchema(pool, intent, base!, recovery!, fence!, fenceV2!, studioOperations!))}\n`);
} catch {
  // A lost commit response is not rollback proof. Never print inputs or database errors.
  process.stderr.write(`${JSON.stringify({ schema: "sophia.voice-lab.studio-g7-operations-upgrade-error.v1",
    code: "STUDIO_G7_OPERATIONS_UPGRADE_FAILED", outcome: "unconfirmed", admissionAuthorized: false })}\n`);
  process.exitCode = 1;
} finally { await pool?.end(); }
