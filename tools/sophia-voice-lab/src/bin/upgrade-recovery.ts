import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { parseRecoveryUpgradeOperator, runRecoveryUpgradeOperator } from "../recovery-upgrade-operator.js";

let pool: pg.Pool | undefined;
try {
  if (process.argv.length !== 2) throw new Error("Arguments unsupported");
  const configuration = parseRecoveryUpgradeOperator(process.env);
  const base = await readFile(path.resolve(process.cwd(), "../../backend/migrations/2026_08_23_sophia_voice_lab.sql"));
  const extension = await readFile(path.resolve(process.cwd(), "migrations/004_recovery_controls.sql"));
  pool = new pg.Pool({ connectionString: configuration.databaseUrl, max: 1,
    connectionTimeoutMillis: 15_000, statement_timeout: 30_000, idle_in_transaction_session_timeout: 60_000,
    application_name: "sophia-voice-lab-recovery-upgrade" });
  const result = await runRecoveryUpgradeOperator(pool, configuration, base, extension);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  // A lost commit response is not rollback proof: inspect schema and inventory
  // read-only before any retry. Never print database errors, inputs or stacks.
  process.stderr.write(`${JSON.stringify({ schema: "sophia.voice-lab.recovery-upgrade-error.v1",
    code: "RECOVERY_UPGRADE_FAILED", outcome: "unconfirmed", admissionAuthorized: false })}\n`);
  process.exitCode = 1;
} finally { await pool?.end(); }
