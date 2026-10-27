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

export interface ManagerTodoRuntime {
  readonly agentDir: string
  readonly wait: () => Promise<void>
  readonly timeoutMs: number
}

export interface ManagerTodoToolResult {
  readonly content: { type: "text"; text: string }[]
  readonly isError: boolean
  readonly details:
    | { readonly outcome: "unavailable" }
    | {
        readonly outcome: "completed" | "failed" | "queued" | "unconfirmed"
        readonly requestId: string
        readonly workerSessionId: string
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
    wait: () => new Promise(resolve => setTimeout(resolve, 50)),
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
  if (
    !Number.isFinite(runtime.timeoutMs) ||
    runtime.timeoutMs < 0 ||
    runtime.timeoutMs > 30_000
  ) {
    return unavailable("Invalid manager worker binding or request timeout.")
  }
  const directory = managerPairDirectory({
    workerSessionId,
    workerCwd,
    agentDir: runtime.agentDir,
  })
  if (Either.isLeft(directory)) return unavailable(directory.left.message)
  const state = openNativeManagerState(directory.right, {
    workerSessionId,
    cwd: workerCwd,
  })
  if (Either.isLeft(state)) return unavailable(state.left.message)
  const current = state.right.context()
  if (Either.isLeft(current)) return unavailable(current.left.message)
  if (current.right.data.todoControl !== true)
    return unavailable(
      "The worker has not loaded task control; no mutation was queued.",
    )
  if (
    request.action === "priority" &&
    current.right.data.todoPriorityControl !== true
  )
    return unavailable(
      "The worker has not loaded priority control; no mutation was queued.",
    )
  if (
    (request.action === "effort" ||
      (request.action === "add" && request.effort !== undefined)) &&
    current.right.data.todoEffortControl !== true
  )
    return unavailable(
      "The worker has not loaded effort control; no mutation was queued.",
    )
  const decoded = decodeTodoControl(request)
  if (Either.isLeft(decoded)) return unavailable(decoded.left.message)
  const submitted = state.right.enqueueTodo(
    decoded.right,
    current.right.priorityRevision,
  )
  if (Either.isLeft(submitted)) return unavailable(submitted.left.message)
  const requestId = submitted.right
  const deadline = performance.now() + runtime.timeoutMs
  while (!signal?.aborted) {
    const receipt = state.right.receipt(requestId)
    if (Either.isLeft(receipt)) break
    if (receipt.right && receipt.right.status !== "started") {
      return {
        content: [{ type: "text", text: receipt.right.message }],
        isError:
          receipt.right.status === "failed" ||
          receipt.right.status === "unconfirmed",
        details: { outcome: receipt.right.status, requestId, workerSessionId },
      }
    }
    if (performance.now() >= deadline) break
    const waited = await Effect.runPromise(
      Effect.either(
        Effect.tryPromise({
          try: runtime.wait,
          catch: () => "reply_wait_failed" as const,
        }),
      ),
    )
    if (Either.isLeft(waited)) break
  }
  return {
    content: [
      {
        type: "text",
        text: `Queued worker request ${requestId}; its result is not confirmed.`,
      },
    ],
    isError: false,
    details: { outcome: "queued", requestId, workerSessionId },
  }
}

const unavailable = (message: string): ManagerTodoToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
  details: { outcome: "unavailable" },
})
