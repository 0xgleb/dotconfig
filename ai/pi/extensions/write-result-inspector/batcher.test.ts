import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import {
  createMutationBatcher,
  type BatchScheduler,
  type MutationBatcherOptions,
} from "./batcher.ts"
import type { MutationDelta } from "./core.ts"

const makeBatcher = <Result>(options: MutationBatcherOptions<Result>) =>
  Effect.runSync(createMutationBatcher(options))

const delta = (toolCallId: string, text: string): MutationDelta => ({
  toolCallId,
  path: "src/value.ts",
  language: "typescript",
  exactChangedText: text,
  resultingChangedText: text,
  inspectors: ["idiomatic-typescript"],
})

const controlledScheduler = () => {
  const callbacks: Array<() => void> = []
  const scheduler: BatchScheduler = callback => {
    callbacks.push(callback)
    return () => {
      const index = callbacks.indexOf(callback)
      if (index >= 0) callbacks.splice(index, 1)
    }
  }
  return { callbacks, scheduler }
}

test("sibling mutations produce one inspection and only the leader patches", async () => {
  const { callbacks, scheduler } = controlledScheduler()
  const runs: MutationDelta[][] = []
  const batcher = makeBatcher({
    scheduler,
    windowMs: 150,
    inspect: async deltas => {
      runs.push([...deltas])
      return { status: "clean" as const }
    },
  })

  const first = batcher.enqueue(delta("first", "one"))
  const second = batcher.enqueue(delta("second", "two"))
  assert.equal(callbacks.length, 1)
  const flush = callbacks.at(0)
  assert.ok(flush)
  flush()

  assert.deepEqual(await first, {
    leader: true,
    result: { status: "clean" },
  })
  assert.deepEqual(await second, {
    leader: false,
    result: { status: "clean" },
  })
  assert.equal(runs.length, 1)
  const run = runs.at(0)
  assert.ok(run)
  assert.deepEqual(
    run.map(item => item.toolCallId),
    ["first", "second"],
  )
})

test("session cancellation resolves queued handlers without running inspection", async () => {
  const { callbacks, scheduler } = controlledScheduler()
  let runs = 0
  const batcher = makeBatcher<
    | { readonly status: "clean" }
    | { readonly status: "skipped"; readonly reason: "cancelled" }
  >({
    scheduler,
    windowMs: 150,
    inspect: async () => {
      runs += 1
      return { status: "clean" as const }
    },
  })
  const pending = batcher.enqueue(delta("first", "one"))
  batcher.cancel({ status: "skipped" as const, reason: "cancelled" as const })
  assert.deepEqual(await pending, {
    leader: true,
    result: { status: "skipped", reason: "cancelled" },
  })
  assert.equal(callbacks.length, 0)
  assert.equal(runs, 0)
})

test("mutations arriving after a flush form a new batch", async () => {
  const { callbacks, scheduler } = controlledScheduler()
  let runs = 0
  const batcher = makeBatcher({
    scheduler,
    windowMs: 150,
    inspect: async () => ({ status: "run" as const, run: ++runs }),
  })
  const first = batcher.enqueue(delta("first", "one"))
  const firstFlush = callbacks.at(0)
  assert.ok(firstFlush)
  firstFlush()
  assert.equal((await first).result.run, 1)

  const second = batcher.enqueue(delta("second", "two"))
  const secondFlush = callbacks.at(0)
  assert.ok(secondFlush)
  secondFlush()
  assert.equal((await second).result.run, 2)
})
