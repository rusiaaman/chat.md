/**
 * Simple mutual exclusion lock with promise-based async interface
 */
export class Lock {
  private isLocked: boolean = false;
  private queue: Array<() => void> = [];

  /**
   * Acquire the lock - will wait if already locked
   * Returns Promise that resolves when lock is acquired
   */
  public async acquire(): Promise<void> {
    if (!this.isLocked) {
      this.isLocked = true;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Release the lock and notify next waiter if any
   */
  public release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.isLocked = false;
    }
  }
}
