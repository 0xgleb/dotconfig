import assert from "node:assert/strict"
import { Effect, Either, Option } from "effect"
import { decodeIssueReference } from "./identity.ts"
import { openSqliteTaskStore } from "./sqlite-store.ts"

const databasePath = process.argv[2]
assert.ok(databasePath)
const issue = decodeIssueReference({
  repository: "0xgleb/dotconfig",
  number: 1,
})
assert.ok(Either.isRight(issue))
const store = await Effect.runPromise(openSqliteTaskStore({ databasePath }))
try {
  const result = await Effect.runPromise(
    store.readTasks(issue.right, { limit: 10 }),
  )
  assert.ok(Option.isSome(result))
  console.log(
    JSON.stringify({
      issue: result.value.issue,
      revision: result.value.revision,
      taskIds: result.value.tasks.map(task => task.id),
      text: result.value.tasks[0]?.text,
    }),
  )
} finally {
  await Effect.runPromise(store.close())
}
