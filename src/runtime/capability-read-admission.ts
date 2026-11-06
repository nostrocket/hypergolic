export class CapabilityReadBusy extends Error {}

type WaitingRead = Readonly<{start(): void; cancel(): void}>;
const activeLimit = 2;
const waitingLimit = 2;

export class CapabilityReadAdmission {
  private readonly active = new Set<AbortController>();
  private readonly waiting = new Set<WaitingRead>();

  get size(): number {return this.active.size;}

  async run<T>(assertActive: () => void, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    assertActive();
    const controller = new AbortController();
    this.active.add(controller);
    const watcher = setInterval(() => {try {assertActive();} catch {controller.abort();}}, 25);
    try {return await read(controller.signal);}
    finally {
      clearInterval(watcher);
      this.active.delete(controller);
      this.drain();
    }
  }

  schedule<T>(assertActive: () => void, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.waiting.size && this.size < activeLimit) return this.run(assertActive, read);
    if (this.waiting.size >= waitingLimit) return Promise.reject(new CapabilityReadBusy());
    return new Promise((resolve, reject) => {
      const job: WaitingRead = {
        start: () => {clearInterval(watcher); void this.run(assertActive, read).then(resolve, reject);},
        cancel: () => {clearInterval(watcher); reject(new Error('Capability read expired or revoked'));},
      };
      const watcher = setInterval(() => {
        try {assertActive();}
        catch {this.waiting.delete(job); job.cancel();}
      }, 25);
      this.waiting.add(job);
      this.drain();
    });
  }

  revoke(): void {
    for (const job of this.waiting) job.cancel();
    this.waiting.clear();
    for (const read of this.active) read.abort();
    this.active.clear();
  }

  private drain(): void {
    for (const job of this.waiting) {
      if (this.size >= activeLimit) break;
      this.waiting.delete(job);
      job.start();
    }
  }
}
