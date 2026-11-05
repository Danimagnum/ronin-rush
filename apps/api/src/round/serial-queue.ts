/**
 * Runs async tasks strictly one after another. Every mutation of round state (bets,
 * cash-outs, phase transitions) goes through it, so an await on the ledger can never
 * interleave with a timer-driven transition. Timing correctness does not depend on
 * queueing delay: decisions use the receive timestamp captured before enqueueing.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(task: () => Promise<T> | T): Promise<T> {
    this.pending++;
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined).finally(() => this.pending--);
    return result;
  }

  get size(): number {
    return this.pending;
  }
}
