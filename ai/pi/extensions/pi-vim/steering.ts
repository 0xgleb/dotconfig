export interface SteeringCancellation {
  cancel(): void;
}

export interface SteeringScheduler {
  schedule(callback: () => void, delayMs: number): SteeringCancellation;
}

export interface DoubleEnterSteeringOptions {
  readonly windowMs: number;
  readonly scheduler?: SteeringScheduler;
  readonly onSubmit: (text: string) => void;
  readonly onImmediate: (text: string) => void;
  readonly hasQueuedMessages?: () => boolean;
  readonly onQueuedImmediate?: () => void;
}

export type SteeringEnterResult = "pass" | "deferred" | "immediate";

interface PendingSteering {
  readonly text: string;
  readonly cancellation: SteeringCancellation;
  readonly token: object;
}

const defaultScheduler: SteeringScheduler = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timer) };
  },
};

export const isSlashCommandInput = (text: string): boolean => text.trimStart().startsWith("/");

export const shouldSubmitWhileWaitingForSubagent = (
  text: string,
  isStreaming: boolean,
  isWaitingForSubagent: boolean,
): boolean =>
  text.trim().length > 0 &&
  !isSlashCommandInput(text) &&
  isStreaming &&
  isWaitingForSubagent;

export class DoubleEnterSteering {
  private readonly options: DoubleEnterSteeringOptions;
  private readonly scheduler: SteeringScheduler;
  private pending?: PendingSteering;
  private queuedEnter?: PendingSteering;

  constructor(options: DoubleEnterSteeringOptions) {
    if (!Number.isFinite(options.windowMs) || options.windowMs < 100 || options.windowMs > 1_000) {
      throw new Error("Double-enter window must be between 100 and 1,000 milliseconds.");
    }
    this.options = options;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  handleEnter(text: string, isStreaming: boolean): SteeringEnterResult {
    if (this.pending) {
      if (isStreaming && text.trim() === "") {
        const pending = this.takePending();
        if (!pending) return "pass";
        this.options.onImmediate(pending.text);
        return "immediate";
      }
      this.flushPending();
    }

    const steeringText = text.trim();
    if (!isStreaming) return "pass";
    if (steeringText.length === 0) {
      if (!this.options.hasQueuedMessages?.()) return "pass";
      if (this.queuedEnter) {
        this.takeQueuedEnter();
        this.options.onQueuedImmediate?.();
        return "immediate";
      }
      const token = {};
      const cancellation = this.scheduler.schedule(() => {
        if (this.queuedEnter?.token === token) this.queuedEnter = undefined;
      }, this.options.windowMs);
      this.queuedEnter = { text: "", cancellation, token };
      return "deferred";
    }
    this.takeQueuedEnter();

    const token = {};
    const cancellation = this.scheduler.schedule(() => {
      if (this.pending?.token !== token) return;
      const pending = this.pending;
      this.pending = undefined;
      this.options.onSubmit(pending.text);
    }, this.options.windowMs);
    this.pending = { text: steeringText, cancellation, token };
    return "deferred";
  }

  dispose(): void {
    this.flushPending();
    this.takeQueuedEnter();
  }

  private takeQueuedEnter(): PendingSteering | undefined {
    const pending = this.queuedEnter;
    if (!pending) return undefined;
    this.queuedEnter = undefined;
    pending.cancellation.cancel();
    return pending;
  }

  private takePending(): PendingSteering | undefined {
    const pending = this.pending;
    if (!pending) return undefined;
    this.pending = undefined;
    pending.cancellation.cancel();
    return pending;
  }

  private flushPending(): void {
    const pending = this.takePending();
    if (pending) this.options.onSubmit(pending.text);
  }
}
