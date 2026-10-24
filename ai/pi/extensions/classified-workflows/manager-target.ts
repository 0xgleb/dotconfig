import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { isAbsolute } from "node:path"
import { Either } from "effect"
import {
  managerPairDirectory,
  ManagerSessionError,
} from "./manager-session-core.ts"
import { openNativeManagerState } from "./manager-native-state.ts"

export interface ManagerTarget {
  readonly workerSessionId: string
  readonly cwd: string
}

export const MANAGER_TARGET_ENTRY = "manager.target.v1"

export const readManagerTarget = (
  ctx: ExtensionContext,
): Either.Either<ManagerTarget | undefined, ManagerSessionError> => {
  const entry = ctx.sessionManager
    .getBranch()
    .findLast(
      value =>
        value.type === "custom" && value.customType === MANAGER_TARGET_ENTRY,
    )
  return entry?.type === "custom"
    ? decodeTarget(entry.data, "unsafe_state")
    : Either.right(undefined)
}

export const selectManagerTarget = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  target: ManagerTarget,
  agentDir: string,
): Either.Either<ManagerTarget, ManagerSessionError> =>
  Either.gen(function* () {
    const selected = yield* decodeTarget(
      { version: 1, workerSessionId: target.workerSessionId, cwd: target.cwd },
      "invalid_input",
    )
    const directory = yield* managerPairDirectory({
      workerSessionId: selected.workerSessionId,
      workerCwd: selected.cwd,
      agentDir,
    })
    const state = yield* openNativeManagerState(directory, selected)
    yield* state.context()
    yield* Either.try({
      try: () =>
        pi.appendEntry(MANAGER_TARGET_ENTRY, { version: 1, ...selected }),
      catch: () =>
        new ManagerSessionError({
          code: "unconfirmed",
          message:
            "Worker selection persistence is unconfirmed; inspect the current target before continuing.",
        }),
    })
    const current = yield* readManagerTarget(ctx)
    if (
      current?.workerSessionId !== selected.workerSessionId ||
      current.cwd !== selected.cwd
    )
      return yield* Either.left(
        new ManagerSessionError({
          code: "unconfirmed",
          message:
            "Worker selection was not confirmed in the active manager journal.",
        }),
      )
    return selected
  })

const decodeTarget = (
  value: unknown,
  code: "invalid_input" | "unsafe_state",
): Either.Either<ManagerTarget, ManagerSessionError> => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("workerSessionId" in value) ||
    typeof value.workerSessionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value.workerSessionId) ||
    !("cwd" in value) ||
    typeof value.cwd !== "string" ||
    !isAbsolute(value.cwd) ||
    /[\u0000-\u001f\u007f]/u.test(value.cwd) ||
    Object.keys(value).some(
      key => !["version", "workerSessionId", "cwd"].includes(key),
    )
  )
    return Either.left(
      new ManagerSessionError({
        code,
        message:
          "Manager worker target is malformed; no default worker will be selected.",
      }),
    )
  return Either.right({
    workerSessionId: value.workerSessionId,
    cwd: value.cwd,
  })
}
