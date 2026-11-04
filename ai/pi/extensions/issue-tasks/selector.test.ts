import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Either } from "effect"
import { isFibonacciEffort } from "../shared/fibonacci-effort.ts"
import { isFibonacciEffort as legacyFibonacciEffort } from "../todo/state.ts"
import { decodeGitHubProjectPage } from "./github-project-read.ts"
import {
  MAX_ISSUE_SELECTION_CANDIDATES,
  selectIssueAssignment,
  type IssueSelectionEligibility,
} from "./selector.ts"

const eligibility: IssueSelectionEligibility = {
  scheduling: "active",
  blockers: "clear",
  parent: "clear",
  dependencies: "clear",
  ownership: "available",
  authorization: "allowed",
}

const numeric = (value: number) => ({ kind: "number", value })

const candidate = (
  number: number,
  patch: Readonly<Record<string, unknown>> = {},
  repository = "owner/repository",
) => ({
  issue: { repository, number },
  state: "open",
  priority: numeric(1),
  effort: numeric(1),
  eligibility: { ...eligibility },
  ...patch,
})

const snapshot = <A extends { readonly issue: unknown }>(
  candidates: readonly A[],
) => ({
  scope: candidates.map(row => row.issue),
  coverage: "complete",
  candidates,
})

const run = (input: unknown) => Effect.runSync(selectIssueAssignment(input))

const errorCode = (input: unknown) => {
  const result = Effect.runSync(Effect.either(selectIssueAssignment(input)))

  assert.ok(Either.isLeft(result))
  return result.left.code
}

const winner = (rows: readonly { readonly issue: unknown }[]) => {
  const result = run(snapshot(rows))

  assert.ok(result.kind === "selected")
  return result.issue
}

test("selects the smallest exact Priority times remaining Effort, not rank or input position", () => {
  const rows = [
    candidate(1, { effort: numeric(13) }),
    candidate(2, { priority: numeric(3), effort: numeric(2) }),
  ]

  assert.equal(winner(rows).number, 2)
  assert.equal(winner(rows.toReversed()).number, 2)
})

test("product comparison remains exact when Number products collide", () => {
  const largerRank = 9007199254740988
  const smallerRank = 6004799503160659

  assert.equal(largerRank * 2, smallerRank * 3)
  assert.equal(BigInt(largerRank) * 2n + 1n, BigInt(smallerRank) * 3n)
  assert.equal(
    winner([
      candidate(1, { priority: numeric(smallerRank), effort: numeric(3) }),
      candidate(2, { priority: numeric(largerRank), effort: numeric(2) }),
    ]).number,
    2,
  )
})

test("ties prefer lower Priority, then canonical repository and numeric issue identity", () => {
  assert.equal(
    winner([
      candidate(1, { priority: numeric(3), effort: numeric(2) }),
      candidate(2, { priority: numeric(2), effort: numeric(3) }),
    ]).number,
    2,
  )

  const rows = [candidate(10), candidate(2), candidate(1, {}, "Z/Repository")]

  for (const input of [
    rows,
    rows.toReversed(),
    rows.slice(1).concat(rows.slice(0, 1)),
  ]) {
    assert.deepEqual(winner(input), {
      repository: "owner/repository",
      number: 2,
    })
  }
})

for (const [field, value, reason] of [
  ["scheduling", "held", "held"],
  ["scheduling", "deferred", "deferred"],
  ["blockers", "blocked", "blocked"],
  ["blockers", "unknown", "unknown_blockers"],
  ["parent", "held", "held_parent"],
  ["parent", "unknown", "unknown_parent"],
  ["dependencies", "blocked", "blocked_dependencies"],
  ["dependencies", "unknown", "unknown_dependencies"],
  ["ownership", "other", "owned_elsewhere"],
  ["ownership", "unknown", "unknown_ownership"],
  ["authorization", "denied", "unauthorized"],
  ["authorization", "unknown", "unknown_authorization"],
] as const) {
  const schedulingStates =
    field === "scheduling" ? ["active"] : ["active", "refinement"]

  for (const scheduling of schedulingStates) {
    test(`${scheduling}: ${field} ${value} excludes the issue despite a smaller product`, () => {
      const rows = [
        candidate(1, {
          eligibility: { ...eligibility, scheduling, [field]: value },
        }),
        candidate(2, { priority: numeric(2) }),
      ]
      const result = run(snapshot(rows))
      const assessment = result.assessments[0]

      assert.ok(result.kind === "selected")
      assert.equal(result.issue.number, 2)
      assert.ok(assessment?.kind === "ineligible")
      assert.deepEqual(assessment.reasons, [reason])
    })
  }
}

for (const [name, patch, reason] of [
  ["closed", { state: "closed" }, "closed"],
  ["unranked", { priority: { kind: "unset" } }, "unranked"],
] as const) {
  test(`explicit refinement cannot override ${name} with missing effort`, () => {
    const result = run(
      snapshot([
        candidate(1, {
          ...patch,
          effort: { kind: "unset" },
          eligibility: { ...eligibility, scheduling: "refinement" },
        }),
      ]),
    )
    const assessment = result.assessments[0]

    assert.equal(result.kind, "none")
    assert.ok(assessment?.kind === "ineligible")
    assert.deepEqual(assessment.reasons, [reason])
  })
}

test("explicit refinement precedes missing-effort refinement", () => {
  const result = run(
    snapshot([
      candidate(1, {
        effort: { kind: "unset" },
        eligibility: { ...eligibility, scheduling: "refinement" },
      }),
    ]),
  )

  assert.equal(result.kind, "none")
  assert.deepEqual(result.assessments, [
    {
      kind: "refinement",
      issue: { repository: "owner/repository", number: 1 },
      reason: "scheduled_refinement",
    },
  ])
})

test("current-worker ownership stays eligible without creating execution authority", () => {
  assert.equal(
    winner([
      candidate(1, { eligibility: { ...eligibility, ownership: "current" } }),
    ]).number,
    1,
  )
})

test("missing effort and explicit refinement are visible but never weighted as one", () => {
  const result = run(
    snapshot([
      candidate(1, { effort: { kind: "unset" } }),
      candidate(2, {
        eligibility: { ...eligibility, scheduling: "refinement" },
      }),
      candidate(3, { priority: numeric(5), effort: numeric(3) }),
    ]),
  )

  assert.ok(result.kind === "selected")
  assert.equal(result.issue.number, 3)
  assert.deepEqual(
    result.assessments.slice(0, 2).map(row => row.kind),
    ["refinement", "refinement"],
  )
  assert.deepEqual(
    result.assessments
      .slice(0, 2)
      .map(row => (row.kind === "refinement" ? row.reason : undefined)),
    ["missing_effort", "scheduled_refinement"],
  )
})

test("exclusions precede refinement, with fixed complete reason ordering", () => {
  const result = run(
    snapshot([
      candidate(1, {
        state: "closed",
        priority: { kind: "unset" },
        effort: { kind: "unset" },
        eligibility: {
          scheduling: "held",
          blockers: "blocked",
          parent: "held",
          dependencies: "blocked",
          ownership: "other",
          authorization: "denied",
        },
      }),
    ]),
  )
  const assessment = result.assessments[0]

  assert.equal(result.kind, "none")
  assert.ok(assessment?.kind === "ineligible")
  assert.deepEqual(assessment.reasons, [
    "closed",
    "held",
    "blocked",
    "held_parent",
    "blocked_dependencies",
    "owned_elsewhere",
    "unauthorized",
    "unranked",
  ])
})

test("empty scope returns none and refinement alone does not create an assignment", () => {
  assert.deepEqual(run(snapshot([])), { kind: "none", assessments: [] })
  assert.equal(
    run(snapshot([candidate(1, { effort: { kind: "unset" } })])).kind,
    "none",
  )
})

for (const priority of [
  0,
  -1,
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
  Infinity,
  Number.NaN,
]) {
  test(`invalid Priority ${priority} rejects the whole snapshot even on closed work`, () => {
    assert.equal(
      errorCode(
        snapshot([
          candidate(1, { state: "closed", priority: numeric(priority) }),
          candidate(2),
        ]),
      ),
      "invalid_priority",
    )
  })
}

for (const effort of [
  0,
  -1,
  4,
  1.5,
  Number.MAX_SAFE_INTEGER,
  Infinity,
  Number.NaN,
]) {
  test(`invalid Effort ${effort} rejects the whole snapshot`, () => {
    assert.equal(
      errorCode(
        snapshot([candidate(1, { effort: numeric(effort) }), candidate(2)]),
      ),
      "invalid_effort",
    )
  })
}

test("rejects malformed tags, missing gates, caller extras and invalid identities", () => {
  for (const row of [
    candidate(1, { priority: { kind: "default" } }),
    candidate(1, { effort: null }),
    candidate(1, { eligibility: {} }),
    candidate(1, { eligibility: { ...eligibility, authorization: "maybe" } }),
    candidate(1, { issue: { repository: "not-a-repository", number: 1 } }),
    candidate(1, { issue: { repository: "owner/repository", number: 0 } }),
    candidate(1, { authority: "owner" }),
  ]) {
    assert.equal(errorCode(snapshot([row])), "invalid_input")
  }

  assert.equal(errorCode({ ...snapshot([]), revision: 1 }), "invalid_input")
  assert.equal(
    errorCode({ ...snapshot([]), coverage: "guessed" }),
    "invalid_input",
  )
})

test("explicit incompleteness and missing or extra joins cannot choose a prefix", () => {
  assert.equal(
    errorCode({ ...snapshot([candidate(1)]), coverage: "incomplete" }),
    "incomplete_snapshot",
  )
  assert.equal(
    errorCode({
      ...snapshot([candidate(1), candidate(2)]),
      candidates: [candidate(1)],
    }),
    "scope_mismatch",
  )
  assert.equal(
    errorCode({
      ...snapshot([candidate(1)]),
      candidates: [candidate(1), candidate(2)],
    }),
    "scope_mismatch",
  )
})

test("normalizes scope identities and rejects duplicate candidates or scope aliases", () => {
  const row = candidate(1)

  assert.equal(
    errorCode(snapshot([row, candidate(1, {}, "OWNER/REPOSITORY")])),
    "duplicate_issue",
  )
  assert.equal(
    errorCode({ ...snapshot([row]), candidates: [row, row] }),
    "duplicate_issue",
  )
  assert.equal(
    run({
      ...snapshot([row]),
      scope: [{ repository: "OWNER/REPOSITORY", number: 1 }],
    }).kind,
    "selected",
  )
  assert.equal(
    winner([candidate(1), candidate(1, {}, "another/repository")]).repository,
    "another/repository",
  )
})

test("bounds the complete snapshot without truncation and accepts the upper limit", () => {
  const rows = Array.from(
    { length: MAX_ISSUE_SELECTION_CANDIDATES },
    (_, index) => candidate(index + 1),
  )
  const result = run(snapshot(rows))

  assert.ok(result.kind === "selected")
  assert.equal(result.issue.number, 1)
  assert.equal(result.assessments.length, MAX_ISSUE_SELECTION_CANDIDATES)
  assert.equal(
    errorCode(
      snapshot([...rows, candidate(MAX_ISSUE_SELECTION_CANDIDATES + 1)]),
    ),
    "capacity",
  )
})

test("detaches and freezes JSON-compatible results without mutating inputs", () => {
  const input = snapshot([candidate(1)])
  const original = structuredClone(input)
  const result = run(input)

  assert.deepEqual(input, original)
  const originalCandidate = input.candidates[0]

  assert.ok(originalCandidate)
  originalCandidate.issue.repository = "changed/repository"
  assert.ok(result.kind === "selected")
  assert.equal(result.issue.repository, "owner/repository")
  assert.ok(Object.isFrozen(result))
  assert.ok(Object.isFrozen(result.issue))
  assert.ok(Object.isFrozen(result.assessments))
  assert.ok(Object.isFrozen(result.assessments[0]))
  assert.doesNotThrow(() => JSON.stringify(result))
})

test("throwing external getters become sanitized typed failures", () => {
  const input = Object.defineProperty({}, "coverage", {
    enumerable: true,
    get: () => {
      throw new Error("private caller detail")
    },
  })
  const result = Effect.runSync(Effect.either(selectIssueAssignment(input)))

  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "invalid_input")
  assert.doesNotMatch(result.left.message, /private caller detail/)
})

test("shared Fibonacci validation preserves the legacy import and all safe boundaries", () => {
  assert.equal(legacyFibonacciEffort, isFibonacciEffort)

  for (const value of [1, 2, 3, 5, 8, 13, 8944394323791464])
    assert.equal(isFibonacciEffort(value), true)
  for (const value of [
    0,
    -1,
    4,
    1.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    "3",
    null,
  ])
    assert.equal(isFibonacciEffort(value), false)
})

test("decoded Project observations enter the consumer contract without eligibility filtering", () => {
  const field = (id: string, name: string) => ({
    __typename: "ProjectV2Field",
    id,
    name,
    dataType: "NUMBER",
    isIssueField: false,
    issueField: null,
  })
  const priorityId = "PVTF_lAHOAl_tIc4BpO1UzhnrZvE"
  const effortId = "PVTF_lAHOAl_tIc4BpO1UzhnrY5k"
  const payload = {
    data: {
      node: {
        __typename: "ProjectV2",
        id: "PVT_kwHOAl_tIc4BpO1U",
        number: 4,
        owner: { __typename: "User", login: "0xgleb" },
        priorityField: field(priorityId, "Priority"),
        effortField: field(effortId, "Effort"),
        items: {
          nodes: [1, 2].map(number => ({
            id: `item-${number}`,
            isArchived: false,
            content: {
              __typename: "Issue",
              number,
              state: "OPEN",
              repository: { nameWithOwner: "Owner/Repository" },
            },
            priority: {
              __typename: "ProjectV2ItemFieldNumberValue",
              field: { id: priorityId },
              number,
            },
            effort: {
              __typename: "ProjectV2ItemFieldNumberValue",
              field: { id: effortId },
              number: 1,
            },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  }
  const decoded = decodeGitHubProjectPage(JSON.stringify(payload), {
    project: "personal",
    page: { limit: 2 },
  })

  assert.ok(Either.isRight(decoded))
  const rows = decoded.right.items.flatMap(item =>
    item.kind === "issue"
      ? [
          {
            issue: item.issue,
            state: item.state,
            priority: item.priority,
            effort: item.effort,
            eligibility: {
              ...eligibility,
              scheduling: item.issue.number === 1 ? "held" : "active",
            },
          },
        ]
      : [],
  )
  const result = run(snapshot(rows))

  assert.equal(result.assessments.length, 2)
  assert.ok(result.kind === "selected")
  assert.equal(result.issue.number, 2)
  assert.equal(result.assessments[0]?.kind, "ineligible")
})
