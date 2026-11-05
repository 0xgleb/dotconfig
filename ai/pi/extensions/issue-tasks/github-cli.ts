import { execFile, type ChildProcess } from "node:child_process"
import { isAbsolute } from "node:path"
import { Effect, Either } from "effect"
import {
  createGitHubIssueReader,
  GitHubReadError,
  MAX_GITHUB_READ_BYTES,
  type GitHubIssueReader,
  type GitHubIssueQueryExecution,
} from "./github-read.ts"
import {
  createGitHubPickupClient,
  type GitHubPickupReadExecution,
  type GitHubPickupWriteExecution,
} from "./github-pickup.ts"
import { IssuePickupWriteError, type IssuePickupClient } from "./pickup.ts"
import {
  createGitHubProjectReader,
  type GitHubProjectReader,
  type GitHubProjectQueryExecution,
} from "./github-project-read.ts"

export const createGitHubCliProjectReader = (
  options: GitHubCliReaderOptions,
): GitHubProjectReader =>
  createGitHubProjectReader({
    executeQuery: createGitHubCliExecutor(options),
  })

export const createGitHubCliPickupClient = (
  options: GitHubCliReaderOptions,
): IssuePickupClient => {
  const execute = createGitHubCliExecutor(options)
  return createGitHubPickupClient({
    read: request => execute(request),
    write: (request, onDispatch) =>
      Effect.suspend(() => {
        let dispatched = false
        return execute(request, () => {
          dispatched = true
          onDispatch()
        }).pipe(
          Effect.mapError(
            () =>
              new IssuePickupWriteError({
                dispatch: dispatched ? "possible" : "not_started",
                message:
                  "GitHub pickup transport did not produce a verified response",
              }),
          ),
        )
      }),
  })
}

export interface GitHubCliExecutionOptions {
  readonly cwd: string
  readonly encoding: "buffer"
  readonly shell: false
  readonly maxBuffer: number
  readonly timeout: number
  readonly killSignal: "SIGKILL"
  readonly signal: AbortSignal
}
export type GitHubCliLaunch = (
  args: readonly string[],
  options: GitHubCliExecutionOptions,
  callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
) => ChildProcess
export interface GitHubCliReaderOptions {
  readonly cwd: string
  readonly launch?: GitHubCliLaunch
}
const transportError = (): GitHubReadError =>
  new GitHubReadError({
    code: "transport_error",
    message: "GitHub CLI did not produce a complete response",
  })
// --input - reads the complete GraphQL JSON body from stdin.
// https://cli.github.com/manual/gh_api
const githubArguments = Object.freeze([
  "api",
  "graphql",
  "--hostname",
  "github.com",
  "--input",
  "-",
])

export const createGitHubCliReader = (
  options: GitHubCliReaderOptions,
): GitHubIssueReader =>
  createGitHubIssueReader({ executeQuery: createGitHubCliExecutor(options) })

const createGitHubCliExecutor = (
  options: GitHubCliReaderOptions,
): ((
  request:
    | GitHubIssueQueryExecution
    | GitHubProjectQueryExecution
    | GitHubPickupReadExecution
    | GitHubPickupWriteExecution,
  onDispatch?: () => void,
) => Effect.Effect<string, GitHubReadError>) => {
  const cwd = options.cwd
  const launch: GitHubCliLaunch =
    options.launch ??
    ((args, execution, callback) =>
      execFile("gh", [...args], execution, callback))

  return (request, onDispatch) =>
    Effect.suspend(() => {
      if (typeof cwd !== "string" || !isAbsolute(cwd))
        return Effect.fail(transportError())

      const payload = Either.try({
        try: () =>
          JSON.stringify({
            query: request.document,
            variables: request.variables,
          }),
        catch: transportError,
      })

      if (Either.isLeft(payload)) return Effect.fail(payload.left)
      if (typeof payload.right !== "string")
        return Effect.fail(transportError())

      return Effect.async<string, GitHubReadError>((resume, signal) => {
        let outcome: Either.Either<string, GitHubReadError> | undefined
        let closed = false
        let exited = false
        const started = Either.try({
          try: () =>
            launch(
              githubArguments,
              {
                cwd,
                encoding: "buffer",
                shell: false,
                maxBuffer: MAX_GITHUB_READ_BYTES,
                timeout: 30_000,
                killSignal: "SIGKILL",
                signal,
              },
              (error, stdout) => {
                if (outcome !== undefined) return
                outcome =
                  error !== null || !Buffer.isBuffer(stdout)
                    ? Either.left(transportError())
                    : Either.try({
                        try: () =>
                          new TextDecoder("utf-8", { fatal: true }).decode(
                            stdout,
                          ),
                        catch: transportError,
                      })
              },
            ),
          catch: transportError,
        })

        if (Either.isLeft(started)) {
          resume(Effect.fail(started.left))
          return
        }
        const child = started.right
        const stop = () => {
          if (closed || exited || child.pid === undefined) return
          const stopped = Either.try({
            try: () => child.kill("SIGKILL"),
            catch: transportError,
          })
          if (Either.isLeft(stopped)) outcome = Either.left(stopped.left)
        }
        const inputFailed = () => {
          outcome = Either.left(transportError())
          stop()
        }
        child.once("exit", () => {
          exited = true
        })
        child.once("close", () => {
          closed = true
          if (outcome === undefined) resume(Effect.fail(transportError()))
          else if (Either.isLeft(outcome)) resume(Effect.fail(outcome.left))
          else resume(Effect.succeed(outcome.right))
        })
        const input = child.stdin
        if (input === null || input === undefined) inputFailed()
        else {
          input.on("error", inputFailed)
          const sent = Either.try({
            try: () => {
              onDispatch?.()
              input.end(payload.right)
            },
            catch: transportError,
          })
          if (Either.isLeft(sent)) inputFailed()
        }

        return Effect.async<void>(finish => {
          if (closed) {
            finish(Effect.void)
            return
          }
          child.once("close", () => finish(Effect.void))
          stop()
        })
      })
    })
}
