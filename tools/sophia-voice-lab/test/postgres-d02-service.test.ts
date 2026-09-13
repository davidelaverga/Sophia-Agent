import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresVoiceLabLedger } from "../src/postgres-ledger.js";
import { composeVoiceLabMigration } from "../src/migration-bundle.js";
import { verifyD02ServiceIngestion } from "./d02-service-ingestion-helper.js";
import { verifyRestartRecoverySchedule } from "./recovery-schedule-helper.js";
import { RETAINED_RECOVERY_RETRY_MS } from "../src/recovery-control.js";

const url = process.env.SOPHIA_VOICE_LAB_SERVICE_TEST_DATABASE_URL ?? "";
const selected = url ? describe : describe.skip;
let ledger: PostgresVoiceLabLedger;
selected("real PostgreSQL authenticated D02 service", () => {
  it("preserves recovery scheduling across worker and connection restarts", async () => {
    await verifyRestartRecoverySchedule(ledger, async () => {
      await ledger.close();
      ledger = new PostgresVoiceLabLedger(url, 4, "synthetic-service-retention-key-000000000001");
      return ledger;
    }, async () => { await new Promise(resolve => setTimeout(resolve, RETAINED_RECOVERY_RETRY_MS + 100)); });
  }, 45_000);
  beforeEach(async () => {
    const parsed = new URL(url);
    if (!/^\/voice_lab_test_c4_service_[a-z0-9_]+$/.test(parsed.pathname)
      || process.env.SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED !== "YES") throw new Error("Dedicated service-test database/reset approval required");
    ledger = new PostgresVoiceLabLedger(url, 4, "synthetic-service-retention-key-000000000001");
    expect((await ledger.pool.query("select current_database() as name")).rows[0].name).toBe(parsed.pathname.slice(1));
    await ledger.pool.query("drop schema if exists sophia_voice_lab cascade");
    await ledger.pool.query(composeVoiceLabMigration(
      await readFile("../../backend/migrations/2026_08_23_sophia_voice_lab.sql"),
      await readFile("migrations/004_recovery_controls.sql"),
    ).toString("utf8"));
  });
  afterEach(async () => {
    if (!ledger) return;
    try { await ledger.pool.query("drop schema if exists sophia_voice_lab cascade"); }
    finally { await ledger.close(); }
  });
  it("preserves signed owner/provider proofs before service acknowledgement and through retention", async () => {
    await verifyD02ServiceIngestion(ledger);
  }, 30_000);
  it.each(["before_owner", "after_owner"] as const)("preserves incomplete owner-only recovery across %s retention", async (cut) => {
    await verifyD02ServiceIngestion(ledger, cut);
  }, 30_000);
  it("recovers a committed Gateway receipt after local write loss and raw retention", async () => {
    await verifyD02ServiceIngestion(ledger, "after_gateway_commit");
  }, 30_000);
});
