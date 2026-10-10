/**
 * One serialization point per run (#151, Codex r4077602539).
 *
 * The worker's operation path, its maintenance steps for a run and the
 * active-lease pulse each take this run's turn before they read a capture
 * cursor or persist what a read returned, so those reads and writes never
 * interleave for one run. Runs are independent: a slow step for one run never
 * delays another run's turn, which is what keeps the pulse of a live run
 * running while maintenance waits on some other run's recovery.
 *
 * Turns are not reentrant. Only top-level entry points take a turn; the
 * helpers they call never do.
 */
export class RunSerializer {
  readonly #tails = new Map<string, Promise<void>>();

  /** Waits for this run's turn, then runs `fn` exclusively for the run. */
  async run<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => turn);
    this.#tails.set(runId, tail);
    try {
      await previous;
      return await fn();
    } finally {
      release();
      if (this.#tails.get(runId) === tail) this.#tails.delete(runId);
    }
  }

  /** Runs `fn` only when nobody holds or awaits this run's turn; never waits. */
  async tryRun<T>(runId: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.#tails.has(runId)) return { ran: false };
    return { ran: true, value: await this.run(runId, fn) };
  }

  busy(runId: string): boolean {
    return this.#tails.has(runId);
  }
}
