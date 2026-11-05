import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import type { TodoRequest } from "../todo/state.ts"

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
  _pi: ExtensionAPI,
  _ctx: ExtensionContext,
  _request: TodoRequest,
  _signal?: AbortSignal,
  _runtime?: ManagerTodoRuntime,
): Promise<ManagerTodoToolResult> => ({
  content: [
    {
      type: "text",
      text: "Legacy task control is unavailable. Use issue-qualified task operations.",
    },
  ],
  isError: true,
  details: { outcome: "unavailable" },
})
