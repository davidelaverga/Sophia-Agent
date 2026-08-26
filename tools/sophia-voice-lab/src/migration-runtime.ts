import pg from "pg";

const { Client } = pg;

export const MIGRATION_CONNECT_TIMEOUT_MS = 15_000;
export const MIGRATION_LOCK_WAIT_MS = 30_000;
export const MIGRATION_LOCK_POLL_MS = 250;

type Queryable = Pick<pg.Client, "query">;

export function createMigrationClient(databaseUrl: string): pg.Client {
  return new Client({
    connectionString: databaseUrl,
    application_name: "sophia-voice-lab-migrate",
    connectionTimeoutMillis: MIGRATION_CONNECT_TIMEOUT_MS,
  });
}

export async function configureMigrationSession(database: Queryable): Promise<void> {
  await database.query("set statement_timeout = '120s'");
  await database.query("set lock_timeout = '15s'");
  await database.query("set idle_in_transaction_session_timeout = '120s'");
}

export async function acquireMigrationLock(
  database: Queryable,
  options: {
    maxWaitMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  const maxWaitMs = options.maxWaitMs ?? MIGRATION_LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? MIGRATION_LOCK_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  for (;;) {
    const result = await database.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtext('sophia_voice_lab_schema_v3')) as locked");
    if (result.rows[0]?.locked === true) return;
    if (now() - startedAt >= maxWaitMs) throw new Error("Timed out waiting for the Sophia Voice Lab schema migration lock.");
    await sleep(pollMs);
  }
}

export function logMigrationStage(stage: string): void {
  console.log(JSON.stringify({ event: "voice_lab_migration_stage", stage }));
}
