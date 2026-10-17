import assert from "node:assert/strict"
import test from "node:test"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"

import {
  cleanupVoiceDirectory,
  runWhisperCli,
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
    Effect.acquireUseRelease(
      Effect.void,
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
    Effect.acquireUseRelease(
      Effect.void,
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
