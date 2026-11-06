import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { getManagerBinding } from "../shared/manager-binding.ts"
import { Effect, Either } from "effect"
import type { TodoRequest } from "../todo/state.ts"
import { decodeTodoControl } from "../todo/control.ts"
import { managerPairDirectory } from "./manager-session-core.ts"
import { openNativeManagerState } from "./manager-native-state.ts"
import { callManagerTask } from "./manager-task-rpc.ts"

export interface ManagerTodoRuntime {
  readonly agentDir: string
  readonly wait?: () => Promise<void>
  readonly timeoutMs: number
}

export interface ManagerTodoToolResult {
  readonly content: { type: "text"; text: string }[]
  readonly isError: boolean
  readonly details:
    | {
        readonly outcome: "unavailable"
        readonly workerSessionId?: string
        readonly workerCwd?: string
      }
    | {
        readonly outcome: "completed" | "failed" | "unconfirmed"
        readonly requestId?: string
        readonly workerSessionId: string
        readonly workerCwd: string
      }
}

export const isNativeManagerProfile = (pi: ExtensionAPI): boolean =>
  typeof pi.getFlag === "function" &&
  pi.getFlag("manager-worker") !== undefined &&
  pi.getFlag("manager-worker") !== ""

export const invokeManagerTodo = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  request: TodoRequest,
  signal?: AbortSignal,
  runtime: ManagerTodoRuntime = {
    agentDir: getAgentDir(),
    timeoutMs: 5000,
  },
): Promise<ManagerTodoToolResult> => {
  const binding = getManagerBinding(pi, ctx)
  if (Either.isLeft(binding)) return unavailable(binding.left.message)
  if (binding.right.role === "manager-unavailable")
    return unavailable(binding.right.message)
  if (binding.right.role !== "manager")
    return unavailable("This session has no paired manager binding.")
  const workerSessionId = binding.right.workerSessionId
  const workerCwd = binding.right.workerCwd ?? ctx.cwd
  const selected = (message: string) =>
    `Worker ${workerCwd} (session ${workerSessionId}): ${message}`
  const fail = (message: string): ManagerTodoToolResult => ({
    ...unavailable(selected(message)),
    details: { outcome: "unavailable", workerSessionId, workerCwd },
  })
  if (
    !Number.isSafeInteger(runtime.timeoutMs) ||
    runtime.timeoutMs <= 0 ||
    runtime.timeoutMs > 30_000
  ) {
    return fail("Invalid manager worker binding or request timeout.")
  }
  const directory = managerPairDirectory({
    workerSessionId,
    workerCwd,
    agentDir: runtime.agentDir,
  })
  if (Either.isLeft(directory)) return fail(directory.left.message)
  const state = openNativeManagerState(directory.right, {
    workerSessionId,
    cwd: workerCwd,
  })
  if (Either.isLeft(state)) return fail(state.left.message)
  const current = state.right.context()
  if (Either.isLeft(current)) return fail(current.left.message)
  if (current.right.data.todoControl !== true)
    return fail("The selected worker has not loaded direct task control.")
  if (
    request.action === "priority" &&
    current.right.data.todoPriorityControl !== true
  )
    return fail("The selected worker has not loaded priority control.")
  if (
    (request.action === "effort" ||
      (request.action === "add" && request.effort !== undefined)) &&
    current.right.data.todoEffortControl !== true
  )
    return fail("The selected worker has not loaded effort control.")
  const decoded = decodeTodoControl(request)
  if (Either.isLeft(decoded)) return fail(decoded.left.message)
  if (!state.right.taskAuthority)
    return fail(
      "Direct worker task authority is unavailable; reload the selected worker and manager coherently.",
    )
  const result = await Effect.runPromise(
    Effect.either(
      callManagerTask({
        directory: directory.right,
        scope: { workerSessionId, cwd: workerCwd },
        authority: state.right.taskAuthority,
        operation: { kind: "todo", request: decoded.right },
        timeoutMs: runtime.timeoutMs,
        ...(signal ? { signal } : {}),
      }),
    ),
  )
  if (Either.isLeft(result)) {
    if (result.left.code !== "unconfirmed") return fail(result.left.message)
    return {
      content: [{ type: "text", text: selected(result.left.message) }],
      isError: true,
      details: { outcome: "unconfirmed", workerSessionId, workerCwd },
    }
  }
  return {
    content: [{ type: "text", text: selected(result.right.message) }],
    isError: result.right.outcome !== "completed",
    details: { outcome: result.right.outcome, workerSessionId, workerCwd },
  }
}

const unavailable = (message: string): ManagerTodoToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
  details: { outcome: "unavailable" },
})
