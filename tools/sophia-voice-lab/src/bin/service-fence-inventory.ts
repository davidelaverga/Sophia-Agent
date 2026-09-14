import pg from "pg";
import { readServiceFenceUpgradeInventory } from "../service-fence-upgrade.js";

let pool: pg.Pool | undefined;
try {
  if (process.argv.length !== 2) throw new Error("Arguments unsupported");
  const expected = process.env.SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_EXPECTED_COMMIT;
  if (!expected || !/^[a-f0-9]{40}$/.test(expected) || (process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA) !== expected)
    throw new Error("Exact operator release required");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Database required");
  pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000, application_name: "sophia-voice-lab-service-fence-inventory" });
  process.stdout.write(`${JSON.stringify({ ...await readServiceFenceUpgradeInventory(pool), releaseCommit: expected })}\n`);
} catch {
  process.stderr.write(`${JSON.stringify({ schema: "sophia.voice-lab.service-fence-inventory-error.v1",
    code: "SERVICE_FENCE_INVENTORY_FAILED", upgradeAuthorized: false, cleanupProven: false })}\n`);
  process.exitCode = 1;
} finally { await pool?.end(); }
