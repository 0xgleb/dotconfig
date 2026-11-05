import assert from "node:assert/strict"
import test from "node:test"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"

import { VoiceTranscriptionError } from "./voice.ts"

import {
  cleanupVoiceDirectory,
  runWhisperCli,
  withVoiceDirectory,
  VOICE_CLEANUP_ATTEMPTS,
  WHISPER_TERMINATION_GRACE_MS,
  WHISPER_TIMEOUT_MS,
} from "./voice-process.ts"

test("Whisper timeout waits for close and escalates before cleanup can begin", async () => {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = []
  const kills: string[] = []
  let onClose: ((code: number | null) => void) | undefined
  let cleanupBegan = false
  let settled = false

  const whisper = runWhisperCli(["safe"], {
    start: (_args, callbacks) => {
      onClose = callbacks.onClose
      return {
        kill: signal => {
          kills.push(signal)
          return true
        },
      }
    },
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs })
      return callback
    },
    cancel: () => {},
  })
  const running = Effect.runPromise(
    withVoiceDirectory(
      Effect.succeed("/owned/voice"),
      () => whisper,
      () =>
        Effect.sync(() => {
          cleanupBegan = true
        }),
    ),
  ).finally(() => {
    settled = true
  })

  assert.equal(scheduled[0]?.delayMs, WHISPER_TIMEOUT_MS)
  scheduled[0]?.callback()
  await Promise.resolve()
  assert.deepEqual(kills, ["SIGTERM"])
  assert.equal(settled, false)
  assert.equal(cleanupBegan, false)
  assert.equal(scheduled[1]?.delayMs, WHISPER_TERMINATION_GRACE_MS)

  scheduled[1]?.callback()
  await Promise.resolve()
  assert.deepEqual(kills, ["SIGTERM", "SIGKILL"])
  assert.equal(settled, false)
  assert.equal(cleanupBegan, false)

  onClose?.(null)
  await assert.rejects(running, /Voice transcription process failed/)
  assert.equal(cleanupBegan, true)
})

test("Whisper process errors also await close before release", async () => {
  let callbacks:
    | {
        readonly onError: () => void
        readonly onClose: (code: number | null) => void
      }
    | undefined
  let released = false
  const running = Effect.runPromise(
    withVoiceDirectory(
      Effect.succeed("/owned/voice"),
      () =>
        runWhisperCli([], {
          start: (_args, registered) => {
            callbacks = registered
            return { kill: () => true }
          },
          schedule: () => undefined,
          cancel: () => {},
        }),
      () =>
        Effect.sync(() => {
          released = true
        }),
    ),
  )
  callbacks?.onError()
  await Promise.resolve()
  assert.equal(released, false)
  callbacks?.onClose(null)
  await assert.rejects(running, /Voice transcription process failed/)
  assert.equal(released, true)
})

test("workspace ownership returns the transcript and cleans exactly the acquired directory", async () => {
  const directories: string[] = []
  const result = await Effect.runPromise(
    withVoiceDirectory(
      Effect.succeed("/owned/voice"),
      directory => {
        assert.equal(directory, "/owned/voice")
        return Effect.succeed("transcript")
      },
      directory =>
        Effect.sync(() => {
          directories.push(directory)
        }),
    ),
  )
  assert.equal(result, "transcript")
  assert.deepEqual(directories, ["/owned/voice"])
})

test("failed workspace acquisition neither starts transcription nor releases unowned storage", async () => {
  const acquisitionError = new VoiceTranscriptionError({
    message: "acquisition failed",
  })
  let uses = 0
  let cleanups = 0
  const result = await Effect.runPromise(
    Effect.either(
      withVoiceDirectory(
        Effect.fail(acquisitionError),
        () =>
          Effect.sync(() => {
            uses += 1
          }),
        () =>
          Effect.sync(() => {
            cleanups += 1
          }),
      ),
    ),
  )
  assert.ok(Either.isLeft(result))
  assert.strictEqual(result.left, acquisitionError)
  assert.equal(uses, 0)
  assert.equal(cleanups, 0)
})

test("workspace cleanup failure remains typed after successful transcription", async () => {
  const removed: string[] = []
  const sleeps: number[] = []
  const result = await Effect.runPromise(
    Effect.exit(
      withVoiceDirectory(
        Effect.succeed("/owned/voice"),
        () => Effect.succeed("transcript"),
        directory =>
          cleanupVoiceDirectory(directory, {
            remove: async path => {
              removed.push(path)
              return Promise.reject(new Error("busy"))
            },
            sleep: async delay => {
              sleeps.push(delay)
            },
          }),
      ),
    ),
  )
  assert.ok(Exit.isFailure(result))
  const failures = Array.from(Cause.failures(result.cause))
  assert.equal(failures.length, 1)
  assert.equal(
    failures[0]?.message,
    "Voice transcription workspace cleanup failed",
  )
  assert.deepEqual(
    removed,
    Array.from({ length: VOICE_CLEANUP_ATTEMPTS }, () => "/owned/voice"),
  )
  assert.deepEqual(sleeps, [50, 50])
})

test("workspace use and cleanup failures retain their ordered causes", async () => {
  const useError = new VoiceTranscriptionError({
    message: "transcription failed",
  })
  const cleanupError = new VoiceTranscriptionError({
    message: "cleanup failed",
  })
  const result = await Effect.runPromise(
    Effect.exit(
      withVoiceDirectory(
        Effect.succeed("/owned/voice"),
        () => Effect.fail(useError),
        () => Effect.fail(cleanupError),
      ),
    ),
  )
  assert.ok(Exit.isFailure(result))
  assert.deepEqual(
    result.cause,
    Cause.sequential(Cause.fail(useError), Cause.fail(cleanupError)),
  )
})

test(
  "workspace cancellation waits for process close and retains cleanup failure",
  { timeout: 2_000 },
  async () => {
    const started = Effect.runSync(Deferred.make<void>())
    const scheduled: Array<{ callback: () => void; delayMs: number }> = []
    const kills: string[] = []
    let onClose: ((code: number | null) => void) | undefined
    let cleanupBegan = false
    const cleanupError = new VoiceTranscriptionError({
      message: "cleanup failed",
    })
    const fiber = Effect.runFork(
      withVoiceDirectory(
        Effect.succeed("/owned/voice"),
        () =>
          runWhisperCli([], {
            start: (_args, callbacks) => {
              onClose = callbacks.onClose
              Effect.runSync(Deferred.succeed(started, undefined))
              return {
                kill: signal => {
                  kills.push(signal)
                  return true
                },
              }
            },
            schedule: (callback, delayMs) => {
              scheduled.push({ callback, delayMs })
              return callback
            },
            cancel: () => {},
          }),
        () =>
          Effect.sync(() => {
            cleanupBegan = true
          }).pipe(Effect.zipRight(Effect.fail(cleanupError))),
      ),
    )
    await Effect.runPromise(Deferred.await(started))
    await Effect.runPromise(Fiber.interruptFork(fiber))
    assert.equal(cleanupBegan, false)
    const timeout = scheduled[0]
    assert.ok(timeout)
    timeout.callback()
    assert.deepEqual(kills, ["SIGTERM"])
    const escalation = scheduled[1]
    assert.ok(escalation)
    escalation.callback()
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"])
    assert.equal(cleanupBegan, false)
    assert.ok(onClose)
    onClose(null)
    const result = await Effect.runPromise(Fiber.await(fiber))
    assert.ok(Exit.isFailure(result))
    assert.equal(cleanupBegan, true)
    assert.ok(Cause.isInterrupted(result.cause))
    assert.ok(Array.from(Cause.failures(result.cause)).includes(cleanupError))
  },
)

test(
  "workspace cancellation during acquisition cleans the acquired directory without starting use",
  { timeout: 2_000 },
  async () => {
    const started = Effect.runSync(Deferred.make<void>())
    const acquired = Effect.runSync(Deferred.make<string>())
    const cleaned: string[] = []
    let uses = 0
    const fiber = Effect.runFork(
      withVoiceDirectory(
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Deferred.await(acquired)),
        ),
        () =>
          Effect.sync(() => {
            uses += 1
          }),
        directory =>
          Effect.sync(() => {
            cleaned.push(directory)
          }),
      ),
    )
    await Effect.runPromise(Deferred.await(started))
    await Effect.runPromise(Fiber.interruptFork(fiber))
    assert.deepEqual(cleaned, [])
    Effect.runSync(Deferred.succeed(acquired, "/owned/voice"))
    const result = await Effect.runPromise(Fiber.await(fiber))
    assert.ok(Exit.isFailure(result))
    assert.ok(Cause.isInterrupted(result.cause))
    assert.deepEqual(cleaned, ["/owned/voice"])
    assert.equal(uses, 0)
  },
)

test("voice cleanup retries transient failures and propagates terminal failure", async () => {
  let attempts = 0
  const sleeps: number[] = []
  await Effect.runPromise(
    cleanupVoiceDirectory("/owned/voice", {
      remove: async () => {
        attempts += 1
        if (attempts < VOICE_CLEANUP_ATTEMPTS) throw new Error("busy")
      },
      sleep: async delayMs => {
        sleeps.push(delayMs)
      },
    }),
  )
  assert.equal(attempts, VOICE_CLEANUP_ATTEMPTS)
  assert.deepEqual(sleeps, [50, 50])

  const failed = await Effect.runPromise(
    Effect.either(
      cleanupVoiceDirectory("/owned/voice", {
        remove: async () => {
          throw new Error("still busy")
        },
        sleep: async () => {},
      }),
    ),
  )
  assert.equal(Either.isLeft(failed), true)
  if (Either.isLeft(failed))
    assert.equal(failed.left._tag, "VoiceTranscriptionError")
})
