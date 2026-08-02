import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Data, Effect } from "effect"
import { startControlPlaneServer } from "./server.ts"
import { makeSqliteJobStore } from "./sqlite-job-store.ts"

const DEFAULT_PORT = 43_121
const LOOPBACK_HOST = "127.0.0.1"

export interface ControlPlaneConfig {
  readonly host: typeof LOOPBACK_HOST
  readonly port: number
  readonly databasePath: string
}

export class ControlPlaneConfigError extends Data.TaggedError(
  "ControlPlaneConfigError",
)<{
  readonly code: "invalid_config"
  readonly message: string
}> {}

const configError = (message: string): ControlPlaneConfigError =>
  new ControlPlaneConfigError({ code: "invalid_config", message })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const absoluteDirectory = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 1_024 &&
  isAbsolute(value)
    ? value
    : undefined

export const parseControlPlaneConfig = (
  environment: unknown,
): Effect.Effect<ControlPlaneConfig, ControlPlaneConfigError> => {
  if (!isRecord(environment))
    return Effect.fail(configError("environment must be an object"))
  const home = absoluteDirectory(environment.HOME)
  if (!home) return Effect.fail(configError("HOME must be an absolute path"))
  const configuredState = environment.XDG_STATE_HOME
  const stateRoot =
    configuredState === undefined
      ? join(home, ".local", "state")
      : absoluteDirectory(configuredState)
  if (!stateRoot)
    return Effect.fail(configError("XDG_STATE_HOME must be an absolute path"))

  const configuredPort = environment.PI_CONTROL_PLANE_PORT
  const port = configuredPort === undefined ? DEFAULT_PORT : Number(configuredPort)
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    (typeof configuredPort === "string" && !/^\d+$/u.test(configuredPort))
  ) {
    return Effect.fail(
      configError("PI_CONTROL_PLANE_PORT must be an integer from 1 to 65535"),
    )
  }

  return Effect.succeed({
    host: LOOPBACK_HOST,
    port,
    databasePath: join(stateRoot, "pi", "control-plane", "jobs.sqlite"),
  })
}

const waitForShutdown = (): Effect.Effect<void> =>
  Effect.async((resume) => {
    const stop = () => resume(Effect.void)
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    return Effect.sync(() => {
      process.removeListener("SIGINT", stop)
      process.removeListener("SIGTERM", stop)
    })
  })

export const runControlPlane = (
  config: ControlPlaneConfig,
): Effect.Effect<void, unknown> =>
  Effect.acquireUseRelease(
    makeSqliteJobStore(config.databasePath),
    (store) =>
      Effect.acquireUseRelease(
        startControlPlaneServer({
          host: config.host,
          port: config.port,
          store,
        }),
        (server) =>
          Effect.zipRight(
            Effect.sync(() =>
              console.log(`pi-control-plane listening on ${server.origin}`),
            ),
            waitForShutdown(),
          ),
        (server) => server.close,
      ),
    (store) => Effect.sync(() => store.close()),
  )

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMainModule) {
  const program = Effect.flatMap(parseControlPlaneConfig(process.env), runControlPlane)
  void Effect.runPromise(program).then(
    () => {},
    () => {
      console.error("pi-control-plane stopped with an internal error")
      process.exitCode = 1
    },
  )
}
