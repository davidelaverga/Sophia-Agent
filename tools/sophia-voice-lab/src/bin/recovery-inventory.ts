import pg from "pg";
import { CallerPartitioner } from "../caller-partition.js";
import { parseCallerPartitionKeys } from "../config.js";
import { inventoryHistoricalRecovery } from "../recovery-backfill-inventory.js";
import { inventoryHistoricalQuarantine } from "../historical-quarantine-inventory.js";

let pool: pg.Pool | undefined;
try {
  // Secrets belong in the service environment, never positional arguments.
  if (process.argv.length !== 2) throw new Error("Arguments unsupported");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Database configuration missing");
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Database URL invalid");
  // Require the real configured key ring even under NODE_ENV=test. An audit
  // must not silently repartition history using a fallback test secret.
  const mode = process.env.SOPHIA_VOICE_LAB_RECOVERY_INVENTORY_MODE ?? "historical";
  if (!["historical", "quarantine"].includes(mode)) throw new Error("Inventory mode invalid");
  const partitions = mode === "historical"
    ? new CallerPartitioner(parseCallerPartitionKeys(process.env.SOPHIA_VOICE_LAB_CALLER_PARTITION_KEYS_JSON, "production")) : undefined;
  pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 15_000,
    application_name: "sophia-voice-lab-recovery-inventory" });
  const report = mode === "quarantine" ? await inventoryHistoricalQuarantine(pool) : await inventoryHistoricalRecovery(pool, partitions!);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.enumerationComplete) process.exitCode = 2;
} catch {
  // Database errors can contain URLs, usernames, SQL values or credentials.
  // Do not serialize the original exception, including its stack/cause.
  process.stderr.write(`${JSON.stringify({ schema: "sophia.voice-lab.recovery-inventory-error.v1", code: "HISTORICAL_INVENTORY_FAILED", upgradeAuthorized: false })}\n`);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
