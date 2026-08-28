import { describe, expect, it, vi } from "vitest";

import { acquireMigrationLock, closeMigrationClient, configureMigrationSession, createMigrationClient, MIGRATION_CONNECT_TIMEOUT_MS } from "../src/migration-runtime.js";

describe("migration runtime", () => {
  it("pins a bounded database connection timeout", () => {
    const client = createMigrationClient("postgresql://example.invalid/test");
    expect((client as unknown as { _connectionTimeoutMillis: number })._connectionTimeoutMillis).toBe(MIGRATION_CONNECT_TIMEOUT_MS);
  });

  it("sets bounded statement, lock, and idle-transaction deadlines", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await configureMigrationSession({ query } as never);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "set statement_timeout = '120s'",
      "set lock_timeout = '15s'",
      "set idle_in_transaction_session_timeout = '120s'",
    ]);
  });

  it("polls without blocking until the advisory lock is acquired", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ locked: false }] })
      .mockResolvedValueOnce({ rows: [{ locked: true }] });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await acquireMigrationLock({ query } as never, { maxWaitMs: 100, pollMs: 1, sleep });
    expect(query).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1);
  });

  it("fails closed when the advisory lock deadline expires", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ locked: false }] });
    let clock = 0;
    await expect(acquireMigrationLock({ query } as never, {
      maxWaitMs: 10,
      now: () => clock,
      sleep: async () => { clock = 10; },
    })).rejects.toThrow("Timed out waiting for the Sophia Voice Lab schema migration lock.");
  });

  it("closes a completed migration connection and its settled transport", async () => {
    const destroy = vi.fn();
    const end = vi.fn().mockResolvedValue(undefined);
    await closeMigrationClient({ end, connection: { stream: { destroy } } } as never);
    expect(end).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys only the migration socket when graceful disconnect stalls", async () => {
    const destroy = vi.fn();
    const end = vi.fn(() => new Promise<void>(() => undefined));
    const clearTimer = vi.fn();
    await closeMigrationClient(
      { end, connection: { stream: { destroy } } } as never,
      {
        setTimer: ((callback: () => void) => {
          queueMicrotask(callback);
          return 1 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout,
        clearTimer: clearTimer as typeof clearTimeout,
      },
    );
    expect(end).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });
});
