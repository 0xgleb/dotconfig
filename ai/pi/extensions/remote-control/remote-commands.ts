import { todoWorkSnapshot } from "../classified-workflows/goal.ts"
import { MAX_REMOTE_RESPONSE_CHARACTERS } from "./protocol.ts"

const section = (title: string, entries: readonly string[]): string[] =>
  entries.length === 0
    ? [`${title} (0)`, "- none"]
    : [`${title} (${entries.length})`, ...entries.map(entry => `- ${entry}`)]

export const remoteKanbanResponse = (entries: readonly unknown[]): string => {
  const snapshot = todoWorkSnapshot(entries)
  return [
    "**TASKS**",
    "",
    ...section("ACTIVE", snapshot.pending),
    "",
    ...section("BLOCKED", snapshot.blocked),
  ]
    .join("\n")
    .slice(0, MAX_REMOTE_RESPONSE_CHARACTERS)
}
