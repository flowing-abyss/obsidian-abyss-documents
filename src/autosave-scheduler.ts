export type SaveReason = 'autosave' | 'maximum-latency' | 'manual' | 'retry';

export interface AutosaveSchedulerOptions {
  readonly idleDelay?: number;
  readonly maximumLatency?: number;
  readonly onFailure?: (cause: unknown, generation: number, reason: SaveReason) => void;
  readonly shouldDeferAutomaticSave?: (reason: 'autosave' | 'maximum-latency') => boolean;
  readonly window?: Pick<Window, 'setTimeout' | 'clearTimeout'>;
}

export interface AutosaveLifecycleSnapshot {
  readonly inFlight: boolean;
  readonly newestGeneration: number;
  readonly paused: boolean;
  readonly savedGeneration: number;
}

type SaveCallback = (generation: number, reason: SaveReason) => Promise<void>;

export class AutosaveScheduler {
  private readonly owner: Pick<Window, 'setTimeout' | 'clearTimeout'>;
  private readonly idleDelay: number;
  private readonly maximumLatency: number;
  private idleTimer: number | null = null;
  private maximumTimer: number | null = null;
  private newestGeneration = 0;
  private savedGeneration = 0;
  private inFlight: Promise<void> | null = null;
  private paused = false;
  private pausedAtGeneration: number | null = null;
  private destroyed = false;

  constructor(
    private readonly save: SaveCallback,
    private readonly options: AutosaveSchedulerOptions = {},
  ) {
    this.owner = options.window ?? window;
    this.idleDelay = options.idleDelay ?? 750;
    this.maximumLatency = options.maximumLatency ?? 5000;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  lifecycleSnapshot(): AutosaveLifecycleSnapshot {
    return {
      inFlight: this.inFlight !== null,
      newestGeneration: this.newestGeneration,
      paused: this.paused,
      savedGeneration: this.savedGeneration,
    };
  }

  markDirty(generation: number): void {
    if (this.destroyed || !Number.isSafeInteger(generation) || generation <= 0) return;
    this.newestGeneration = Math.max(this.newestGeneration, generation);
    if (this.paused) return;
    this.scheduleAutomaticSave();
  }

  private scheduleAutomaticSave(): void {
    if (this.destroyed || this.paused || this.newestGeneration <= this.savedGeneration) return;
    this.clearIdle();
    this.idleTimer = this.owner.setTimeout(() => {
      this.idleTimer = null;
      void this.run('autosave').catch(() => undefined);
    }, this.idleDelay);
    this.maximumTimer ??= this.owner.setTimeout(() => {
      this.maximumTimer = null;
      void this.run('maximum-latency').catch(() => undefined);
    }, this.maximumLatency);
  }

  flush(): Promise<void> {
    return this.run('manual');
  }

  resumeAutomaticSave(): Promise<void> {
    if (this.destroyed || this.paused) return Promise.resolve();
    return this.run('autosave');
  }

  retry(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.paused = false;
    this.pausedAtGeneration = null;
    return this.run('retry');
  }

  pauseForFailure(cause: unknown, generation: number): void {
    if (this.destroyed) return;
    this.newestGeneration = Math.max(this.newestGeneration, generation);
    this.paused = true;
    this.pausedAtGeneration = Math.max(this.pausedAtGeneration ?? 0, generation);
    this.clearTimers();
    this.options.onFailure?.(cause, generation, 'autosave');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimers();
  }

  private run(reason: SaveReason): Promise<void> {
    if (this.destroyed || this.newestGeneration <= this.savedGeneration) {
      return this.inFlight ?? Promise.resolve();
    }
    if (this.paused && reason !== 'retry') {
      return Promise.reject(new DOMException('PDF autosave is paused.', 'InvalidStateError'));
    }
    if (this.shouldDefer(reason)) {
      this.scheduleAutomaticSave();
      return Promise.resolve();
    }
    this.clearTimers();
    if (this.inFlight !== null) {
      return this.inFlight.then(() => this.run(reason));
    }
    const generation = this.newestGeneration;
    const operation = this.save(generation, reason).then(
      () => {
        this.savedGeneration = Math.max(this.savedGeneration, generation);
        if (this.pausedAtGeneration !== null && this.savedGeneration >= this.pausedAtGeneration) {
          this.paused = false;
          this.pausedAtGeneration = null;
        }
      },
      (cause: unknown) => {
        if (!this.destroyed) {
          this.paused = true;
          this.pausedAtGeneration = Math.max(this.pausedAtGeneration ?? 0, generation);
          this.options.onFailure?.(cause, generation, reason);
        }
        throw cause;
      },
    );
    this.inFlight = operation.finally(() => {
      this.inFlight = null;
    });
    return this.inFlight.then(() => {
      if (this.newestGeneration > this.savedGeneration) return this.run(reason);
      return undefined;
    });
  }

  private shouldDefer(reason: SaveReason): boolean {
    return (
      (reason === 'autosave' || reason === 'maximum-latency') &&
      this.options.shouldDeferAutomaticSave?.(reason) === true
    );
  }

  private clearTimers(): void {
    this.clearIdle();
    if (this.maximumTimer !== null) this.owner.clearTimeout(this.maximumTimer);
    this.maximumTimer = null;
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) this.owner.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
