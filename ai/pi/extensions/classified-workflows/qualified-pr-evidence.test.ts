import assert from "node:assert/strict"
import { realpathSync } from "node:fs"
import test from "node:test"
import {
  branchExecutionEvidence,
  selectRelevantExecutionEvidence,
  toolResultExecutionEvidence,
} from "./execution-evidence.ts"

const scope = realpathSync(process.cwd())
const command =
  "gh pr view 274 --repo example/service --json number,state,headRefOid,url,body"
const subject = {
  toolName: "agent_registry",
  cwd: scope,
  input: {
    action: "start_request",
    requestId: "11111111-1111-4111-8111-111111111111",
    evidenceRef: "Current pull request metadata was independently observed.",
  },
}
const observation = (id: string, command: string, text: string) => [
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text }],
    },
  },
]
const query = (text: string, queryCommand = command, isError = false) =>
  toolResultExecutionEvidence({
    toolName: "bash",
    input: { command: queryCommand },
    text,
    isError,
    scope,
    subject,
  })

const response = JSON.stringify({
  number: 274,
  state: "OPEN",
  headRefOid: "a".repeat(40),
  body: "Six non-closing tracking references.",
})

test("ordinary paired SDK records preserve qualified PR command, status and body", () => {
  const evidence = branchExecutionEvidence({
    branch: observation("query", command, response),
    scope,
    subject,
  })
  assert.equal(evidence.length, 1)
  assert.match(evidence[0] ?? "", /result status=success inputDigest=/)
  assert.ok(evidence[0]?.includes(command))
  assert.ok(evidence[0]?.includes(response))
})

test("qualified PR evidence survives unrelated result and relevance churn", () => {
  const branch = [
    ...observation("query", command, response),
    ...Array.from({ length: 20 }, (_, index) =>
      observation(
        `churn-${index}`,
        `echo report-${index}`,
        JSON.stringify(subject),
      ),
    ).flat(),
  ]
  const evidence = branchExecutionEvidence({ branch, scope, subject })
  const selected = selectRelevantExecutionEvidence(evidence, subject)
  assert.ok(selected.some(item => item.includes(response)))
})

test("query snapshots bind repository and field selection, superseding only an identical query", () => {
  const evidence = [
    query("old exact query"),
    query(
      "other repository",
      command.replace("example/service", "example/other"),
    ),
    query(
      "different fields",
      command.replace("number,state,headRefOid,url,body", "number,state"),
    ),
    query("new exact query"),
    query(JSON.stringify(subject), "echo first"),
    query(JSON.stringify(subject), "echo second"),
  ]
  const selected = selectRelevantExecutionEvidence(evidence, subject, 1, 1)
  const snapshots = selected.filter(item =>
    item.includes("snapshot=qualified-pull-request-query"),
  )
  assert.equal(snapshots.length, 3)
  assert.ok(!selected.some(item => item.endsWith("old exact query")))
  for (const text of [
    "other repository",
    "different fields",
    "new exact query",
  ])
    assert.ok(selected.some(item => item.endsWith(text)))
})

test("qualified query retention stays bounded and accepts the native external-command prefix", () => {
  assert.match(
    query("caret", `^${command}`),
    / snapshot=qualified-pull-request-query /,
  )
  const evidence = [
    ...Array.from({ length: 12 }, (_, index) =>
      query(`query-${index}`, command.replace("274", String(index + 1))),
    ),
    query(JSON.stringify(subject), "echo first"),
    query(JSON.stringify(subject), "echo second"),
  ]
  const snapshots = selectRelevantExecutionEvidence(
    evidence,
    subject,
    1,
    1,
  ).filter(item => item.includes("snapshot=qualified-pull-request-query"))
  assert.equal(snapshots.length, 8)
  assert.ok(snapshots.every(item => !/query-[0-3]$/.test(item)))
})

test("raw query bounds survive command-location normalization", () => {
  for (const padded of [
    " ".repeat(600) + command,
    command + " ".repeat(600),
    command + "\n",
  ]) {
    const direct = query(response, padded)
    const collected = branchExecutionEvidence({
      branch: observation("padded", padded, response),
      scope,
      subject,
    })
    assert.ok(!direct.includes("snapshot=qualified-pull-request-query"))
    assert.ok(
      collected.every(
        item => !item.includes("snapshot=qualified-pull-request-query"),
      ),
    )
  }
})

test("query retention is caller-scoped and does not promote failures or shell/mutation forms", () => {
  const foreign = toolResultExecutionEvidence({
    toolName: "bash",
    input: { command },
    text: response,
    isError: false,
    scope: `${scope}/another-workspace`,
    subject,
  })
  const selected = selectRelevantExecutionEvidence(
    [
      foreign,
      query(JSON.stringify(subject), "echo first"),
      query(JSON.stringify(subject), "echo second"),
    ],
    subject,
    1,
    1,
  )
  assert.ok(!selected.includes(foreign))
  const unsupported = [
    command.replace("pr view", "pr edit"),
    `${command}; echo other`,
    `${command}\necho other`,
    command.replace("example/service", "$env.REPOSITORY"),
    `${command} --web`,
    `${command} --repo example/other`,
    command.replace("example/service", "example/" + "a".repeat(600)),
  ]
  for (const value of unsupported)
    assert.ok(
      !query(response, value).includes("snapshot=qualified-pull-request-query"),
    )
  assert.ok(
    !query(response, command, true).includes(
      "snapshot=qualified-pull-request-query",
    ),
  )
  assert.ok(
    !query("snapshot=qualified-pull-request-query", "echo data").includes(
      " snapshot=qualified-pull-request-query input=",
    ),
  )
})
