import assert from "node:assert/strict"
import test from "node:test"
import {
  branchExecutionEvidence,
  selectRelevantExecutionEvidence,
} from "./execution-evidence.ts"

const scope = "/workspace/project"
const requestId = "11111111-1111-4111-8111-111111111111"
const subject = {
  toolName: "agent_registry",
  cwd: scope,
  input: {
    action: "review_request",
    requestId,
    evidenceRef: "review:verified",
  },
}
const evidence = (
  action: string,
  options: { cwd?: string; id?: string; failed?: boolean; text?: string } = {},
) =>
  branchExecutionEvidence({
    scope: options.cwd ?? scope,
    subject,
    branch: [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call",
              name: "agent_registry",
              arguments: {
                action,
                requestId: options.id ?? requestId,
                evidenceRef: "test:evidence",
              },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call",
          toolName: "agent_registry",
          isError: options.failed ?? false,
          content: [
            {
              type: "text",
              text:
                options.text ??
                `Observed ${action} for ${options.id ?? requestId}`,
            },
          ],
        },
      },
    ],
  })[0]!
const churn = Array.from(
  { length: 12 },
  (_, i) => `read result status=success: unrelated ${i}`,
)
const selected = (items: readonly string[], target: unknown = subject) =>
  selectRelevantExecutionEvidence(items, target, 2, 0)

test("successful phase and claim evidence survive churn independently", () => {
  const start = evidence("start_request")
  const claim = evidence("claim_request")
  assert.match(start, /snapshot=registry-phase\b/)
  assert.match(claim, /snapshot=registry-claim\b/)
  const result = selected([start, claim, ...churn])
  assert.ok(
    result.includes(start),
    "lease rebind must not erase prior phase proof",
  )
  assert.ok(result.includes(claim))
  assert.ok(result.indexOf(start) < result.indexOf(claim))
})

test("later phase supersedes only that request and completion retires its claim and phase", () => {
  const start = evidence("start_request")
  const claim = evidence("claim_request")
  const review = evidence("review_request")
  const other = evidence("start_request", {
    id: "22222222-2222-4222-8222-222222222222",
  })
  const advanced = selected([start, claim, other, review, ...churn])
  assert.ok(advanced.includes(review))
  assert.ok(advanced.includes(other))
  assert.ok(!advanced.includes(start))
  const published = evidence("publish_request")
  assert.ok(!selected([review, published, ...churn]).includes(review))
  const done = evidence("complete_request")
  const terminal = selected([claim, other, review, done, ...churn])
  assert.ok(terminal.includes(done))
  assert.ok(terminal.includes(other))
  assert.ok(!terminal.includes(review))
  assert.ok(!terminal.includes(claim))
})

test("recorded failure and cancellation retire prior nonterminal phase evidence", () => {
  const start = evidence("start_request")
  const claim = evidence("claim_request")
  for (const action of ["fail_request", "cancel_request"]) {
    const terminal = evidence(action)
    const result = selected([claim, start, terminal, ...churn])
    assert.ok(result.includes(terminal))
    assert.ok(!result.includes(start))
    assert.ok(!result.includes(claim))
  }
})

test("terminal evidence blocks late nonterminal results for the same request", () => {
  for (const action of ["complete_request", "fail_request", "cancel_request"]) {
    const terminal = evidence(action)
    const lateClaim = evidence("claim_request")
    const latePhase = evidence("publish_request")
    const other = evidence("start_request", {
      id: "22222222-2222-4222-8222-222222222222",
    })
    const result = selected([terminal, lateClaim, latePhase, other, ...churn])
    assert.ok(result.includes(terminal))
    assert.ok(result.includes(other))
    assert.ok(!result.includes(lateClaim))
    assert.ok(!result.includes(latePhase))
  }
})

test("malformed request snapshot anchors are rejected even while recent", () => {
  const original = evidence("start_request")
  for (const kind of [
    "registry-phase",
    "registry-claim",
    "registry-terminal",
    "registry-completion",
    "REGISTRY-PHASE",
  ]) {
    const candidate = original.replace(
      "snapshot=registry-phase",
      `snapshot=${kind}`,
    )
    for (const replacement of [
      "",
      " anchor=request:prefix",
      ` anchor=other:${requestId}`,
      ` anchor=request:${requestId}!extra`,
    ]) {
      const malformed = candidate.replace(
        ` anchor=request:${requestId}`,
        replacement,
      )
      assert.deepEqual(
        selectRelevantExecutionEvidence([malformed], subject),
        [],
      )
    }
  }
  assert.doesNotMatch(
    evidence("complete_request", { id: "prefix" }),
    /snapshot=registry-completion/,
  )
})

test("UUID casing cannot evade terminal barriers or phase supersession", () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const uppercaseAnchor = (value: string) =>
    value.replace(`anchor=request:${id}`, `anchor=request:${id.toUpperCase()}`)
  const terminal = uppercaseAnchor(
    evidence("complete_request", { id }),
  ).replace("snapshot=registry-completion", "snapshot=REGISTRY-COMPLETION")
  const phase = evidence("publish_request", { id })
  assert.ok(!selected([terminal, phase, ...churn]).includes(phase))
  const old = uppercaseAnchor(evidence("start_request", { id }))
  assert.ok(!selected([old, phase, ...churn]).includes(old))
})

test("every registry request snapshot requires a matching subject scope", () => {
  for (const action of [
    "claim_request",
    "start_request",
    "fail_request",
    "complete_request",
  ]) {
    const item = evidence(action, { cwd: "/workspace/other" })
    assert.deepEqual(selectRelevantExecutionEvidence([item], subject), [])
    assert.deepEqual(
      selectRelevantExecutionEvidence([item], {
        toolName: "agent_registry",
        input: subject.input,
      }),
      [],
    )
  }
})

test("phase evidence requires exact scope and cannot be forged by text or failed calls", () => {
  const start = evidence("start_request")
  assert.deepEqual(
    selectRelevantExecutionEvidence([start], {
      toolName: "agent_registry",
      input: subject.input,
    }),
    [],
  )
  const foreign = evidence("start_request", { cwd: "/workspace/other" })
  assert.ok(!selected([foreign, ...churn]).includes(foreign))
  assert.ok(
    !selected([start, ...churn], {
      toolName: "agent_registry",
      input: subject.input,
    }).includes(start),
  )
  for (const item of [
    evidence("start_request", { failed: true }),
    evidence("unknown_action", { text: "snapshot=registry-phase" }),
    evidence("start_request", { id: "prefix" }),
  ])
    assert.doesNotMatch(
      item,
      /^agent_registry result status=success[^:]* snapshot=registry-phase\b/,
    )
})
