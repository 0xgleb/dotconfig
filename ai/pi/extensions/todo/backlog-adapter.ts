import { createHash } from "node:crypto"
import type { BranchTodoBacklogSnapshot } from "../shared/backlog-events.ts"
import type { Todo, TodoState } from "./state.ts"

const MAX_REQUIREMENT_CHARACTERS = 4_000
const MAX_REQUIREMENTS_PER_SOURCE = 32

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex")

const requirementChunks = (value: string): readonly string[] => {
  const chunks: string[] = []
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + MAX_REQUIREMENT_CHARACTERS, value.length)
    if (
      end < value.length &&
      end > offset &&
      /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "")
    )
      end -= 1
    const chunk = value.slice(offset, end)
    if (chunk.length > 0) chunks.push(chunk)
    offset = end
  }
  return chunks
}

const todoRequirements = (todo: Todo): readonly string[] => [
  ...requirementChunks(todo.text),
  ...(todo.replies ?? []).flatMap(reply =>
    requirementChunks(`Owner or agent reply: ${reply}`),
  ),
  ...(todo.status === "blocked"
    ? requirementChunks(`Current blocker: ${todo.reason}`)
    : []),
]

const groupsOf = <T>(
  values: readonly T[],
  size: number,
): readonly (readonly T[])[] => {
  const groups: T[][] = []
  for (let offset = 0; offset < values.length; offset += size)
    groups.push(values.slice(offset, offset + size))
  return groups
}

export const branchTodoBacklogSnapshot = (
  project: string,
  sessionId: string,
  state: TodoState,
  observedAt: number,
): BranchTodoBacklogSnapshot => ({
  project,
  sessionId,
  observedAt,
  todos: state.todos.flatMap(todo => {
    const canonicalId = `${sessionId}:todo-${todo.id}:${digest(todo.text).slice(0, 16)}`
    const pages = groupsOf(todoRequirements(todo), MAX_REQUIREMENTS_PER_SOURCE)
    return pages.map((requirements, index) => ({
      canonicalId,
      // Preserve legacy single-page identity; repeated page contents still need distinct source IDs.
      sourceId: `${canonicalId}:${pages.length > 1 ? `page-${index}:` : ""}snapshot-${digest(requirements.join("\u001f")).slice(0, 16)}`,
      requirements,
      status: todo.status,
      ...(todo.status === "blocked" ? { reason: todo.reason } : {}),
      page: { index, count: pages.length },
    }))
  }),
})
