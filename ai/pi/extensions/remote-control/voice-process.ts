import { spawn } from "node:child_process"
import { rm } from "node:fs/promises"
import * as Effect from "effect/Effect"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"

import { VoiceTranscriptionError } from "./voice.ts"

export const WHISPER_TIMEOUT_MS = 120_000
export const WHISPER_TERMINATION_GRACE_MS = 5_000
export const VOICE_CLEANUP_ATTEMPTS = 3

interface VoiceProcessCallbacks {
  readonly onError: () => void
  readonly onClose: (code: number | null) => void
}

interface VoiceProcessHandle {
  kill(signal: "SIGTERM" | "SIGKILL"): boolean
}

interface VoiceProcessDependencies {
  readonly start: (
    args: readonly string[],
    callbacks: VoiceProcessCallbacks,
  ) => VoiceProcessHandle
  readonly schedule: (callback: () => void, delayMs: number) => unknown
  readonly cancel: (handle: unknown) => void
}

const defaultProcessDependencies: VoiceProcessDependencies = {
  start: (args, callbacks) => {
    const child = spawn("whisper-cli", [...args], {
      stdio: "ignore",
      windowsHide: true,
    })
    child.once("error", callbacks.onError)
    child.once("close", callbacks.onClose)
    return { kill: signal => child.kill(signal) }
  },
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export const runWhisperCli = (
  args: readonly string[],
  dependencies: VoiceProcessDependencies = defaultProcessDependencies,
): Effect.Effect<void, VoiceTranscriptionError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        let processFailed = false
        let settled = false
        let timedOut = false
        let terminationEscalation: unknown
        let timeout: unknown
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          if (timeout !== undefined) dependencies.cancel(timeout)
          if (terminationEscalation !== undefined)
            dependencies.cancel(terminationEscalation)
          if (error) reject(error)
          else resolve()
        }
        const child = dependencies.start(args, {
          onError: () => {
            processFailed = true
          },
          onClose: code =>
            finish(
              timedOut
                ? new Error("Whisper transcription timed out")
                : processFailed
                  ? new Error("Whisper process could not start")
                  : code === 0
                    ? undefined
                    : new Error("Whisper transcription failed"),
            ),
        })
        timeout = dependencies.schedule(() => {
          timedOut = true
          child.kill("SIGTERM")
          terminationEscalation = dependencies.schedule(() => {
            child.kill("SIGKILL")
          }, WHISPER_TERMINATION_GRACE_MS)
        }, WHISPER_TIMEOUT_MS)
      }),
    catch: () =>
      new VoiceTranscriptionError({
        message: "Voice transcription process failed",
      }),
  })

interface VoiceCleanupDependencies {
  readonly remove: (directory: string) => Promise<void>
  readonly sleep: (delayMs: number) => Promise<void>
}

const defaultCleanupDependencies: VoiceCleanupDependencies = {
  remove: directory => rm(directory, { recursive: true, force: true }),
  sleep: delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
}

export const withVoiceDirectory = <A, E, R>(
  acquire: Effect.Effect<string, VoiceTranscriptionError>,
  use: (directory: string) => Effect.Effect<A, E, R>,
  cleanup: (
    directory: string,
  ) => Effect.Effect<void, VoiceTranscriptionError> = directory =>
    cleanupVoiceDirectory(directory),
): Effect.Effect<A, E | VoiceTranscriptionError, R> =>
  Effect.uninterruptibleMask(restore =>
    Effect.gen(function* () {
      const directory = yield* acquire
      const admitted = yield* Effect.exit(restore(Effect.void))
      // In-flight filesystem and process operations must settle before release.
      const used: Exit.Exit<A, E> = Exit.isFailure(admitted)
        ? Exit.failCause(admitted.cause)
        : yield* Effect.exit(Effect.suspend(() => use(directory)))
      const cleaned = yield* Effect.exit(
        Effect.suspend(() => cleanup(directory)),
      )

      if (Exit.isFailure(used) && Exit.isFailure(cleaned))
        return yield* Effect.failCause(
          Cause.sequential(used.cause, cleaned.cause),
        )
      if (Exit.isFailure(used)) return yield* Effect.failCause(used.cause)
      if (Exit.isFailure(cleaned)) return yield* Effect.failCause(cleaned.cause)
      return used.value
    }),
  )

export const cleanupVoiceDirectory = (
  directory: string,
  dependencies: VoiceCleanupDependencies = defaultCleanupDependencies,
): Effect.Effect<void, VoiceTranscriptionError> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < VOICE_CLEANUP_ATTEMPTS; attempt += 1) {
      const removed = yield* Effect.either(
        Effect.tryPromise({
          try: () => dependencies.remove(directory),
          catch: () =>
            new VoiceTranscriptionError({
              message: "Voice transcription workspace cleanup failed",
            }),
        }),
      )
      if (removed._tag === "Right") return
      if (attempt + 1 < VOICE_CLEANUP_ATTEMPTS)
        yield* Effect.tryPromise({
          try: () => dependencies.sleep(50),
          catch: () =>
            new VoiceTranscriptionError({
              message: "Voice transcription cleanup retry failed",
            }),
        })
      else return yield* Effect.fail(removed.left)
    }
  })
