import type { OAuthLedgerStore } from "./oauth.js";

export interface OAuthMaintenanceSnapshot {
  ready: boolean;
  running: boolean;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_deleted_count: number;
  consecutive_failures: number;
  error: string | null;
}

/**
 * Bounded OAuth control-ledger maintenance. It is independent of public OAuth
 * traffic and remains active while the Voice Lab mutation kill switch is on.
 */
export class OAuthMaintenanceLoop {
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;
  #closed = false;
  #lastAttemptAt: Date | null = null;
  #lastSuccessAt: Date | null = null;
  #lastDeletedCount = 0;
  #consecutiveFailures = 0;
  #error: string | null = null;

  constructor(
    readonly store: Pick<OAuthLedgerStore, "purgeExpired">,
    readonly batchSize: number,
    readonly intervalMs = 60_000,
    readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new Error("OAuth maintenance batch size is invalid");
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 3_600_000) throw new Error("OAuth maintenance interval is invalid");
  }

  start(): void {
    if (this.#closed || this.#timer || this.#inFlight) return;
    void this.runOnce();
  }

  async runOnce(): Promise<void> {
    if (this.#closed) return;
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = (async () => {
      const attemptedAt = this.now();
      this.#lastAttemptAt = attemptedAt;
      try {
        this.#lastDeletedCount = await this.store.purgeExpired(Math.floor(attemptedAt.getTime() / 1_000), this.batchSize);
        this.#lastSuccessAt = this.now();
        this.#consecutiveFailures = 0;
        this.#error = null;
      } catch (error) {
        this.#consecutiveFailures += 1;
        this.#error = error instanceof Error ? error.name : "OAuthMaintenanceError";
      } finally {
        this.#inFlight = null;
        if (!this.#closed) {
          this.#timer = setTimeout(() => {
            this.#timer = null;
            void this.runOnce();
          }, this.intervalMs);
          this.#timer.unref();
        }
      }
    })();
    return this.#inFlight;
  }

  readiness(): OAuthMaintenanceSnapshot {
    const successAge = this.#lastSuccessAt === null ? Number.POSITIVE_INFINITY : this.now().getTime() - this.#lastSuccessAt.getTime();
    return {
      ready: !this.#closed && this.#consecutiveFailures === 0 && successAge <= this.intervalMs * 2,
      running: !this.#closed,
      last_attempt_at: this.#lastAttemptAt?.toISOString() ?? null,
      last_success_at: this.#lastSuccessAt?.toISOString() ?? null,
      last_deleted_count: this.#lastDeletedCount,
      consecutive_failures: this.#consecutiveFailures,
      error: this.#error,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#inFlight;
  }
}
