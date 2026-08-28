import pg from "pg";

const { Client } = pg;

export const MIGRATION_CONNECT_TIMEOUT_MS = 15_000;
export const MIGRATION_LOCK_WAIT_MS = 30_000;
export const MIGRATION_LOCK_POLL_MS = 250;
export const MIGRATION_DISCONNECT_TIMEOUT_MS = 5_000;

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

export async function closeMigrationClient(
  database: pg.Client,
  options: {
    timeoutMs?: number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? MIGRATION_DISCONNECT_TIMEOUT_MS;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let transportDestroyed = false;
  const destroyTransport = (): void => {
    if (transportDestroyed) return;
    transportDestroyed = true;
    database.connection.stream.destroy();
  };
  try {
    await Promise.race([
      database.end(),
      new Promise<void>((resolve) => {
        timer = setTimer(() => {
          // Supavisor can accept PostgreSQL's graceful termination packet yet
          // keep the TLS socket open. The advisory lock is session-scoped, so
          // destroying only this completed migration session is the safe,
          // bounded fallback and cannot release another process's lock.
          destroyTransport();
          resolve();
        }, timeoutMs);
      }),
    ]);
    // pg can resolve Client.end() after sending PostgreSQL's termination
    // packet even when a Supavisor TLS transport remains referenced. Finish
    // the already-completed migration session deterministically so a shell
    // start command can advance from migrate.js to the long-lived service.
    destroyTransport();
  } finally {
    if (timer) clearTimer(timer);
  }
}

export function logMigrationStage(stage: string): void {
  console.log(JSON.stringify({ event: "voice_lab_migration_stage", stage }));
}
