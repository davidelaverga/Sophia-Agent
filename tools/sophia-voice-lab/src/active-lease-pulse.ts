import { AsyncResource } from "node:async_hooks";

/**
 * The independently scheduled active-lease pulse (#151, Codex r4077602539).
 *
 * A live run's browser lease used to be renewed, and its page capture
 * drained, only by the worker's maintenance pass. That pass runs every
 * independent recovery stage first, so a slow stage (for example retained
 * recovery against a Gateway that does not answer) starved the live run: its
 * lease expired while its owner was alive, and the 2,048-event page ring
 * overflowed. The pulse renews and drains each active lease on its own timer,
 * whatever maintenance costs.
 *
 * Lifecycle, one entry per run and lease epoch (owned by the VoiceLabWorker):
 * - start: when the run's browser lease becomes active, while the worker loop runs;
 * - each tick renews first. Renewal never waits on anything another holder
 *   owns, so it keeps its cadence whoever holds the run, and whatever a drain
 *   or maintenance is waiting on;
 * - after a renewal, the tick starts a drain unless one is already in flight
 *   for this entry. A drain never delays the next renewal;
 * - the next tick is armed only after the renewal settled (a setTimeout
 *   chain, never an interval), so renewals of one entry never overlap;
 * - end: when a renewal or a drain reports "end" (lease loss, terminal run,
 *   lease gone or replaced) or when the worker deactivates the lease. An
 *   entry that ended never re-arms, even when work in flight settles later;
 * - stopAll() is sticky: every pending timer is cleared at once, no tick
 *   starts or re-arms afterwards, and settle() awaits the work in flight.
 *
 * Every timer is created in the pulse's own async scope (captured when the
 * worker built it), never in the async context of whoever activated the
 * lease, such as a claimed operation.
 *
 * The pulse only schedules. What a renewal and a drain do (and how a drain is
 * serialized with the run's operations and maintenance) is the worker's.
 */
export type ActiveLeasePulseOutcome = "continue" | "end";
export type ActiveLeasePulseStep = (runId: string, epoch: number) => Promise<ActiveLeasePulseOutcome>;

export interface ActiveLeasePulseHandlers {
  /** Renews the lease. Must never wait on the run's turn or on maintenance. */
  readonly renew: ActiveLeasePulseStep;
  /** Drains the run's capture in the run's turn, or reports a busy run as "continue". */
  readonly drain: ActiveLeasePulseStep;
  readonly onError: (runId: string, error: unknown) => void;
}

/** Renew well inside the lease and drain far inside the page ring: at most every 5 s, at least three times per lease. */
export function activeLeasePulseIntervalMs(browserLeaseSeconds: number): number {
  return Math.max(1_000, Math.min(5_000, Math.floor(browserLeaseSeconds * 1_000 / 3)));
}

interface PulseEntry {
  readonly epoch: number;
  timer: ReturnType<typeof setTimeout> | null;
  draining: boolean;
  ended: boolean;
}

export class ActiveLeasePulse {
  readonly #entries = new Map<string, PulseEntry>();
  readonly #inFlight = new Set<Promise<void>>();
  readonly #scope = new AsyncResource("SophiaVoiceLabActiveLeasePulse");
  #enabled = false;
  #stopped = false;

  constructor(readonly intervalMs: number, readonly handlers: ActiveLeasePulseHandlers) {}

  /** Allows pulses to run (the worker loop is running). Never undoes stopAll(). */
  enable(): void {
    if (!this.#stopped) this.#enabled = true;
  }

  /** Starts the run's pulse for this lease epoch, replacing any earlier entry. */
  start(runId: string, epoch: number): void {
    if (!this.#enabled || this.#stopped) return;
    this.stop(runId);
    const entry: PulseEntry = { epoch, timer: null, draining: false, ended: false };
    this.#entries.set(runId, entry);
    this.#arm(runId, entry);
  }

  /** Ends the run's pulse. Work in flight finishes, but the entry never re-arms. */
  stop(runId: string): void {
    const entry = this.#entries.get(runId);
    if (entry) this.#end(runId, entry);
  }

  /** Sticky: clears every pending timer; nothing is armed or started afterwards. */
  stopAll(): void {
    this.#stopped = true;
    this.#enabled = false;
    for (const runId of [...this.#entries.keys()]) this.stop(runId);
  }

  /** Resolves once every renewal and drain in flight has settled. */
  async settle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight]);
  }

  active(runId: string, epoch: number): boolean {
    const entry = this.#entries.get(runId);
    return !this.#stopped && entry !== undefined && !entry.ended && entry.epoch === epoch;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  get pendingTimers(): number {
    return [...this.#entries.values()].filter((entry) => entry.timer !== null).length;
  }

  get inFlight(): number {
    return this.#inFlight.size;
  }

  #end(runId: string, entry: PulseEntry): void {
    entry.ended = true;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    if (this.#entries.get(runId) === entry) this.#entries.delete(runId);
  }

  #live(entry: PulseEntry): boolean {
    return !entry.ended && !this.#stopped;
  }

  #arm(runId: string, entry: PulseEntry): void {
    if (!this.#live(entry)) return;
    entry.timer = this.#scope.runInAsyncScope(() => setTimeout(() => {
      entry.timer = null;
      if (this.#live(entry)) this.#track(this.#tick(runId, entry));
    }, this.intervalMs));
    entry.timer.unref?.();
  }

  #track(work: Promise<void>): void {
    this.#inFlight.add(work);
    void work.finally(() => this.#inFlight.delete(work));
  }

  async #step(step: ActiveLeasePulseStep, runId: string, entry: PulseEntry): Promise<ActiveLeasePulseOutcome> {
    try { return await step(runId, entry.epoch); }
    catch (error) { this.handlers.onError(runId, error); return "continue"; }
  }

  async #tick(runId: string, entry: PulseEntry): Promise<void> {
    if ((await this.#step(this.handlers.renew, runId, entry)) === "end") {
      this.#end(runId, entry);
      return;
    }
    if (this.#live(entry) && !entry.draining) {
      entry.draining = true;
      this.#track(this.#drain(runId, entry));
    }
    this.#arm(runId, entry);
  }

  async #drain(runId: string, entry: PulseEntry): Promise<void> {
    try {
      if ((await this.#step(this.handlers.drain, runId, entry)) === "end") this.#end(runId, entry);
    } finally {
      entry.draining = false;
    }
  }
}
