import { createHash } from "node:crypto"
import { isAbsolute, join } from "node:path"
import { Data, Either } from "effect"

export interface ManagerSessionLaunchInput {
  readonly workerSessionId: string
  readonly workerCwd: string
  readonly agentDir: string
  readonly piExecutable: string
  readonly provider: string
  readonly modelId: string
  readonly existingPaneNames: readonly string[]
}

export type ManagerSessionLaunchPlan =
  | { readonly kind: "existing"; readonly paneName: string }
  | {
      readonly kind: "launch"
      readonly paneName: string
      readonly sessionDirectory: string
      readonly executable: "zellij"
      readonly args: readonly string[]
    }

export class ManagerSessionError extends Data.TaggedError(
  "ManagerSessionError",
)<{
  readonly code:
    | "invalid_input"
    | "unsupported_provider"
    | "unavailable"
    | "unauthorized"
    | "protocol"
    | "stale_revision"
    | "io"
    | "unsafe_state"
    | "launch_failed"
  readonly message: string
}> {}

export const managerSessionLaunchPlan = (
  input: ManagerSessionLaunchInput,
): Either.Either<ManagerSessionLaunchPlan, ManagerSessionError> => {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.workerSessionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(input.workerSessionId) ||
    ![input.workerCwd, input.agentDir, input.piExecutable].every(
      path =>
        typeof path === "string" &&
        isAbsolute(path) &&
        !/[\u0000-\u001f\u007f]/u.test(path),
    ) ||
    typeof input.provider !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(input.provider) ||
    typeof input.modelId !== "string" ||
    !input.modelId.trim() ||
    input.modelId.length > 200 ||
    /[\u0000-\u0020\u007f]/u.test(input.modelId) ||
    !Array.isArray(input.existingPaneNames) ||
    !input.existingPaneNames.every(name => typeof name === "string")
  ) {
    return Either.left(
      new ManagerSessionError({
        code: "invalid_input",
        message:
          "Native manager launch requires a valid worker identity, absolute paths and configured model.",
      }),
    )
  }

  if (input.provider === "anthropic") {
    return Either.left(
      new ManagerSessionError({
        code: "unsupported_provider",
        message: "Native manager sessions cannot use Anthropic API billing.",
      }),
    )
  }

  const pair = createHash("sha256")
    .update(`${input.workerCwd}\u0000${input.workerSessionId}`)
    .digest("hex")
    .slice(0, 24)
  const paneName = `manager-${pair}`
  if (input.existingPaneNames.includes(paneName)) {
    return Either.right({ kind: "existing", paneName })
  }

  const sessionDirectory = join(input.agentDir, "manager", pair, "sessions")

  return Either.right({
    kind: "launch",
    paneName,
    sessionDirectory,
    executable: "zellij",
    args: [
      "action",
      "new-pane",
      "--name",
      paneName,
      "--cwd",
      input.workerCwd,
      "--",
      input.piExecutable,
      "--session-dir",
      sessionDirectory,
      "--continue",
      "--name",
      paneName,
      "--model",
      `${input.provider}/${input.modelId}`,
      "--no-builtin-tools",
      "--manager-worker",
      input.workerSessionId,
    ],
  })
}
