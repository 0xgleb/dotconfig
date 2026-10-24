import { Data, Effect } from "effect"
import type { MutationDelta } from "./core.ts"

export type BatchScheduler = (
  callback: () => void,
  delayMs: number,
) => () => void

export interface BatchDelivery<Result> {
  readonly leader: boolean
  readonly result: Result
}

interface BatchWaiter<Result> {
  readonly leader: boolean
  readonly resolve: (delivery: BatchDelivery<Result>) => void
  readonly reject: (error: unknown) => void
}

interface PendingBatch<Result> {
  readonly deltas: MutationDelta[]
  readonly waiters: BatchWaiter<Result>[]
  cancelTimer: () => void
}

export class MutationBatcherError extends Data.TaggedError(
  "MutationBatcherError",
)<{
  readonly message: string
}> {}

export interface MutationBatcherOptions<Result> {
  readonly scheduler: BatchScheduler
  readonly windowMs: number
  readonly inspect: (deltas: readonly MutationDelta[]) => Promise<Result>
}

const defaultScheduler: BatchScheduler = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}

export class MutationBatcher<Result> {
  private readonly scheduler: BatchScheduler
  private readonly windowMs: number
  private readonly inspect: (
    deltas: readonly MutationDelta[],
  ) => Promise<Result>
  private pending: PendingBatch<Result> | undefined
  private terminal: { readonly result: Result } | undefined

  private constructor(options: MutationBatcherOptions<Result>) {
    this.scheduler = options.scheduler
    this.windowMs = options.windowMs
    this.inspect = options.inspect
  }

  static create<Result>(
    options: MutationBatcherOptions<Result>,
  ): Effect.Effect<MutationBatcher<Result>, MutationBatcherError> {
    return !Number.isSafeInteger(options.windowMs) || options.windowMs < 0
      ? Effect.fail(
          new MutationBatcherError({
            message: "Mutation batch window must be a non-negative integer",
          }),
        )
      : Effect.succeed(new MutationBatcher(options))
  }

  enqueue(delta: MutationDelta): Promise<BatchDelivery<Result>> {
    if (this.terminal)
      return Promise.resolve({ leader: true, result: this.terminal.result })
    const leader = this.pending === undefined
    return new Promise((resolve, reject) => {
      if (!this.pending) {
        this.pending = {
          deltas: [],
          waiters: [],
          cancelTimer: () => {},
        }
      } else {
        this.pending.cancelTimer()
      }
      this.pending.deltas.push(delta)
      this.pending.waiters.push({ leader, resolve, reject })
      this.pending.cancelTimer = this.scheduler(
        () => void this.flush(),
        this.windowMs,
      )
    })
  }

  cancel(result: Result): void {
    this.terminal = { result }
    const pending = this.pending
    this.pending = undefined
    if (!pending) return
    pending.cancelTimer()
    for (const waiter of pending.waiters)
      waiter.resolve({ leader: waiter.leader, result })
  }

  private async flush(): Promise<void> {
    const pending = this.pending
    this.pending = undefined
    if (!pending) return
    pending.cancelTimer()
    try {
      const result = await this.inspect(pending.deltas)
      for (const waiter of pending.waiters)
        waiter.resolve({ leader: waiter.leader, result })
    } catch (error) {
      for (const waiter of pending.waiters) waiter.reject(error)
    }
  }
}

export const createMutationBatcher = <Result>(
  options: Omit<MutationBatcherOptions<Result>, "scheduler"> & {
    readonly scheduler?: BatchScheduler
  },
): Effect.Effect<MutationBatcher<Result>, MutationBatcherError> =>
  MutationBatcher.create({
    ...options,
    scheduler: options.scheduler ?? defaultScheduler,
  })
