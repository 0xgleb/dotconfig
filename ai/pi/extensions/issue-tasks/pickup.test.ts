import assert from "node:assert/strict"
import test from "node:test"
import { Cause, Deferred, Effect, Either, Exit, Schema } from "effect"
import { decodeIssueReference } from "./identity.ts"
import {
  GitHubInProgressTargetSchema,
  GitHubIssueNodeIdSchema,
  ProjectItemIdSchema,
} from "./github-project-read.ts"
import { GitHubUserSchema } from "./github-user.ts"
import {
  createGitHubPickupClient,
  GITHUB_PICKUP_READ_DOCUMENT,
  GITHUB_PICKUP_ASSIGN_DOCUMENT,
  GITHUB_PICKUP_STATUS_DOCUMENT,
  type GitHubPickupWriteExecution,
} from "./github-pickup.ts"
import { selectIssueAssignment } from "./selector.ts"
import type { IssueNextObservation } from "./next.ts"
import {
  createIssueNextPicker,
  IssuePickupReadError,
  IssuePickupWriteError,
  type IssuePickupClient,
  type IssuePickupObservation,
  type IssuePickupTarget,
  type IssuePickupTrace,
} from "./pickup.ts"

const viewer = Schema.decodeUnknownSync(GitHubUserSchema)({
  id: "viewer-id",
  login: "0xgleb",
})
const other = Schema.decodeUnknownSync(GitHubUserSchema)({
  id: "other-id",
  login: "levsgit",
})
const reference = decodeIssueReference({
  repository: "owner/repository",
  number: 7,
})
assert.ok(Either.isRight(reference))
const target: IssuePickupTarget = {
  issue: reference.right,
  issueNodeId: Schema.decodeUnknownSync(GitHubIssueNodeIdSchema)(
    "issue-node-id",
  ),
  itemId: Schema.decodeUnknownSync(ProjectItemIdSchema)("item-id"),
  viewer,
  inProgress: Schema.decodeUnknownSync(GitHubInProgressTargetSchema)({
    projectId: "PVT_kwHOAl_tIc4BpO1U",
    fieldId: "PVTSSF_lAHOAl_tIc4BpO1UzhnrYfs",
    optionId: "47fc9ee4",
  }),
}
const invocation = { sessionId: "native-session", toolCallId: "original-call" }
const selection = Effect.runSync(
  selectIssueAssignment({
    scope: [target.issue],
    coverage: "complete",
    candidates: [
      {
        issue: target.issue,
        state: "open",
        priority: { kind: "number", value: 1 },
        effort: { kind: "number", value: 1 },
        eligibility: { blockers: "clear", dependencies: "clear" },
      },
    ],
  }),
)
assert.ok(selection.kind === "selected")
const recommendation: IssueNextObservation = {
  selection,
  viewer,
  inProgress: target.inProgress,
  selected: {
    kind: "issue",
    itemId: target.itemId,
    issueNodeId: target.issueNodeId,
    issue: target.issue,
    assignees: [],
    status: null,
    state: "open",
    priority: { kind: "number", value: 1 },
    effort: { kind: "number", value: 1 },
  },
  excludedAssignments: [],
}
const initial: IssuePickupObservation = {
  viewer,
  issue: target.issue,
  issueNodeId: target.issueNodeId,
  itemId: target.itemId,
  projectId: target.inProgress.projectId,
  state: "open",
  archived: false,
  assignees: [],
  status: null,
}
const desired = {
  fieldId: target.inProgress.fieldId,
  optionId: target.inProgress.optionId,
}
const fixture = (observation: IssuePickupObservation = initial) => {
  const calls: string[] = []
  let remote = observation
  const client: {
    inspect: IssuePickupClient["inspect"]
    assignOwner: IssuePickupClient["assignOwner"]
    setInProgress: IssuePickupClient["setInProgress"]
  } = {
    inspect: () =>
      Effect.sync(() => {
        calls.push("inspect")
        return remote
      }),
    assignOwner: (received, call, onDispatch) =>
      Effect.sync(() => {
        assert.deepEqual(received, target)
        assert.deepEqual(call, invocation)
        calls.push("assign")
        onDispatch()
        remote = { ...remote, assignees: [viewer] }
      }),
    setInProgress: (received, call, onDispatch) =>
      Effect.sync(() => {
        assert.deepEqual(received, target)
        assert.deepEqual(call, invocation)
        calls.push("status")
        onDispatch()
        remote = { ...remote, status: desired }
      }),
  }
  const reader = { read: () => Effect.succeed(recommendation) }
  return {
    calls,
    client,
    reader,
    setRemote: (value: IssuePickupObservation) => {
      remote = value
    },
    picker: () => createIssueNextPicker({ reader, pickup: client }),
  }
}
const run = Effect.runPromise

test("reviewer pickup rechecks In review without changing the implementation assignee or status", async () => {
  const reviewStatus = Schema.decodeUnknownSync(GitHubInProgressTargetSchema)({
    projectId: target.inProgress.projectId,
    fieldId: target.inProgress.fieldId,
    optionId: "aba860b9",
  })
  const observed = {
    ...initial,
    assignees: [other],
    status: { fieldId: reviewStatus.fieldId, optionId: reviewStatus.optionId },
  }
  const source = fixture(observed)
  const picker = createIssueNextPicker({
    reader: {
      read: () =>
        Effect.succeed({ ...recommendation, review: { status: reviewStatus } }),
    },
    pickup: source.client,
  })
  const result = await run(picker.next({ mode: "review" }, invocation))
  assert.ok(result.kind === "review")
  assert.deepEqual(result.observed.assignees, [other])
  assert.deepEqual(result.observed.status, observed.status)
  assert.deepEqual(source.calls, ["inspect"])
})

test("review pickup fails before work if the selected issue has left In review", async () => {
  const source = fixture({ ...initial, assignees: [viewer], status: desired })
  const reviewStatus = Schema.decodeUnknownSync(GitHubInProgressTargetSchema)({
    projectId: target.inProgress.projectId,
    fieldId: target.inProgress.fieldId,
    optionId: "aba860b9",
  })
  const picker = createIssueNextPicker({
    reader: {
      read: () =>
        Effect.succeed({ ...recommendation, review: { status: reviewStatus } }),
    },
    pickup: source.client,
  })
  const result = await run(
    Effect.either(picker.next({ mode: "review" }, invocation)),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "stale_selection")
  assert.deepEqual(source.calls, ["inspect"])
})

test("implementation pickup refuses a selection that moves to Refine before live reinspection", async () => {
  const refine = Schema.decodeUnknownSync(GitHubInProgressTargetSchema)({
    projectId: target.inProgress.projectId,
    fieldId: target.inProgress.fieldId,
    optionId: "refine-option",
  })
  const source = fixture({
    ...initial,
    status: { fieldId: refine.fieldId, optionId: refine.optionId },
  })
  const picker = createIssueNextPicker({
    reader: {
      read: () =>
        Effect.succeed({ ...recommendation, refineOptions: [refine.optionId] }),
    },
    pickup: source.client,
  })
  const result = await run(Effect.either(picker.next({}, invocation)))
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "stale_selection")
  assert.deepEqual(source.calls, ["inspect"])
})

test("native pickup adds owner, changes only selected item status, and verifies actual readback", async () => {
  const source = fixture()
  const result = await run(source.picker().next({}, invocation))
  assert.equal(result.kind, "pickup")
  assert.ok(result.kind === "pickup")
  assert.equal(result.receipt.kind, "verified")
  assert.deepEqual(source.calls, ["inspect", "assign", "status", "inspect"])
  assert.equal(result.receipt.trace.assignment, "acknowledged")
  assert.equal(result.receipt.trace.status, "acknowledged")
  assert.ok(result.receipt.kind === "verified")
  assert.equal(result.receipt.verification, "observed_not_exclusive")
  assert.deepEqual(result.receipt.observed.assignees, [viewer])
  assert.deepEqual(result.receipt.observed.status, desired)
})

test("already owner-only and In Progress verifies without gratuitous mutations", async () => {
  const source = fixture({ ...initial, assignees: [viewer], status: desired })
  const result = await run(source.picker().next({}, invocation))
  assert.ok(result.kind === "pickup" && result.receipt.kind === "verified")
  assert.deepEqual(source.calls, ["inspect"])
  assert.equal(result.receipt.trace.assignment, "not_needed")
  assert.equal(result.receipt.trace.status, "not_needed")
})

for (const changed of [
  { ...initial, viewer: other },
  { ...initial, assignees: [other] },
  { ...initial, assignees: [viewer, other] },
  { ...initial, state: "closed" as const },
  { ...initial, archived: true },
  {
    ...initial,
    itemId: Schema.decodeUnknownSync(ProjectItemIdSchema)("another-item"),
  },
]) {
  test(`changed pickup preflight cannot write: ${JSON.stringify(changed)}`, async () => {
    const source = fixture(changed)
    const result = await run(
      Effect.either(source.picker().next({}, invocation)),
    )
    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, "stale_selection")
    assert.deepEqual(source.calls, ["inspect"])
  })
}

test("assignment followed by a definitely unstarted status write reports known partial effects", async () => {
  const source = fixture()
  source.client.setInProgress = () =>
    Effect.suspend(() => {
      source.calls.push("status")
      return Effect.fail(
        new IssuePickupWriteError({
          dispatch: "not_started",
          message: "unavailable",
        }),
      )
    })
  const result = await run(source.picker().next({}, invocation))
  assert.ok(result.kind === "pickup" && result.receipt.kind === "partial")
  assert.equal(result.receipt.trace.assignment, "acknowledged")
  assert.equal(result.receipt.trace.status, "not_started")
  assert.deepEqual(source.calls, ["inspect", "assign", "status", "inspect"])
})

test("possible assignment dispatch is not retried, undone, or followed by another mutation", async () => {
  const source = fixture()
  source.client.assignOwner = (_target, _invocation, onDispatch) =>
    Effect.suspend(() => {
      source.calls.push("assign")
      onDispatch()
      return Effect.fail(
        new IssuePickupWriteError({ dispatch: "possible", message: "timeout" }),
      )
    })
  const result = await run(source.picker().next({}, invocation))
  assert.ok(result.kind === "pickup" && result.receipt.kind === "unknown")
  assert.equal(result.receipt.trace.assignment, "possible")
  assert.deepEqual(source.calls, ["inspect", "assign", "inspect"])
})

test("readback can verify desired states without pretending an uncertain write was acknowledged", async () => {
  const source = fixture()
  source.client.setInProgress = (_target, _invocation, onDispatch) =>
    Effect.suspend(() => {
      source.calls.push("status")
      onDispatch()
      source.setRemote({ ...initial, assignees: [viewer], status: desired })
      return Effect.fail(
        new IssuePickupWriteError({
          dispatch: "possible",
          message: "response lost",
        }),
      )
    })
  const result = await run(source.picker().next({}, invocation))
  assert.ok(result.kind === "pickup" && result.receipt.kind === "verified")
  assert.equal(result.receipt.trace.status, "possible")
  assert.equal(result.receipt.verification, "observed_not_exclusive")
})

test("competing assignee at final readback prevents success", async () => {
  const source = fixture()
  const ordinary = source.client.setInProgress
  source.client.setInProgress = (...args) =>
    ordinary(...args).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          source.setRemote({
            ...initial,
            assignees: [viewer, other],
            status: desired,
          })
        }),
      ),
    )
  const result = await run(source.picker().next({}, invocation))
  assert.ok(result.kind === "pickup" && result.receipt.kind === "partial")
})

test("unavailable post-write readback retains an explicit unknown receipt", async () => {
  const source = fixture()
  const ordinary = source.client.inspect
  source.client.inspect = received =>
    source.calls.length === 0
      ? ordinary(received)
      : Effect.suspend(() => {
          source.calls.push("inspect")
          return Effect.fail(
            new IssuePickupReadError({
              code: "transport_error",
              message: "unavailable",
            }),
          )
        })
  const result = await run(source.picker().next({}, invocation))
  assert.ok(result.kind === "pickup" && result.receipt.kind === "unknown")
  assert.equal(result.receipt.observed, null)
  assert.equal(result.receipt.trace.assignment, "acknowledged")
  assert.equal(result.receipt.trace.status, "acknowledged")
})

const pickupPayload = (observed: IssuePickupObservation = initial) => ({
  data: {
    viewer: observed.viewer,
    node: {
      __typename: "ProjectV2Item",
      id: observed.itemId,
      isArchived: observed.archived,
      project: {
        id: observed.projectId,
        statusField: {
          __typename: "ProjectV2SingleSelectField",
          id: target.inProgress.fieldId,
          name: "Status",
          dataType: "SINGLE_SELECT",
          options: [{ id: target.inProgress.optionId, name: "In progress" }],
        },
      },
      content: {
        __typename: "Issue",
        id: observed.issueNodeId,
        number: observed.issue.number,
        state: observed.state === "open" ? "OPEN" : "CLOSED",
        repository: { nameWithOwner: observed.issue.repository },
        assignees: {
          nodes: observed.assignees,
          totalCount: observed.assignees.length,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
      status:
        observed.status === null
          ? null
          : {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              optionId: observed.status.optionId,
              field: { id: observed.status.fieldId },
            },
    },
  },
})

test("GitHub pickup read uses the fixed item query and validates actual viewer, assignees and Status binding", async () => {
  const requests: unknown[] = []
  const client = createGitHubPickupClient({
    read: request =>
      Effect.sync(() => {
        requests.push(request)
        return JSON.stringify(pickupPayload())
      }),
    write: () => assert.fail("read must not mutate"),
  })
  const observed = await run(client.inspect(target))
  assert.deepEqual(observed, initial)
  assert.deepEqual(requests, [
    {
      document: GITHUB_PICKUP_READ_DOCUMENT,
      variables: { item: target.itemId },
    },
  ])
  assert.ok(Object.isFrozen(observed))
  assert.ok(Object.isFrozen(observed.assignees))
})

test("GitHub pickup mutations use only selected node, actual owner and verified item Status IDs", async () => {
  const requests: GitHubPickupWriteExecution[] = []
  let dispatched = 0
  const client = createGitHubPickupClient({
    read: () => assert.fail("mutation decoder must not invent extra reads"),
    write: (request, onDispatch) =>
      Effect.sync(() => {
        requests.push(request)
        onDispatch()
        return JSON.stringify({
          data:
            request.document === GITHUB_PICKUP_ASSIGN_DOCUMENT
              ? {
                  addAssigneesToAssignable: {
                    assignable: { id: target.issueNodeId },
                  },
                }
              : {
                  updateProjectV2ItemFieldValue: {
                    projectV2Item: { id: target.itemId },
                  },
                },
        })
      }),
  })
  await run(
    client.assignOwner(target, invocation, () => {
      dispatched++
    }),
  )
  await run(
    client.setInProgress(target, invocation, () => {
      dispatched++
    }),
  )
  assert.equal(dispatched, 2)
  assert.deepEqual(requests, [
    {
      document: GITHUB_PICKUP_ASSIGN_DOCUMENT,
      variables: {
        input: {
          assignableId: target.issueNodeId,
          assigneeIds: [viewer.id],
          clientMutationId: "original-call:assign",
        },
      },
    },
    {
      document: GITHUB_PICKUP_STATUS_DOCUMENT,
      variables: {
        input: {
          projectId: target.inProgress.projectId,
          itemId: target.itemId,
          fieldId: target.inProgress.fieldId,
          value: { singleSelectOptionId: target.inProgress.optionId },
          clientMutationId: "original-call:status",
        },
      },
    },
  ])
})

test("malformed or wrong-target GitHub pickup data never becomes eligible evidence", async () => {
  const ordinary = pickupPayload()
  const node = ordinary.data.node
  for (const payload of [
    { data: { ...ordinary.data, viewer: null } },
    { data: { ...ordinary.data, node: null } },
    { data: { ...ordinary.data, node: { ...node, id: "another-item" } } },
    {
      data: {
        ...ordinary.data,
        node: {
          ...node,
          project: {
            ...node.project,
            statusField: { ...node.project.statusField, id: "wrong-field" },
          },
        },
      },
    },
    {
      data: {
        ...ordinary.data,
        node: {
          ...node,
          content: {
            ...node.content,
            assignees: { ...node.content.assignees, nodes: null },
          },
        },
      },
    },
    {
      data: {
        ...ordinary.data,
        node: {
          ...node,
          content: {
            ...node.content,
            assignees: { ...node.content.assignees, totalCount: 1 },
          },
        },
      },
    },
    { ...ordinary, errors: [{ message: "private-provider-error" }] },
  ]) {
    const client = createGitHubPickupClient({
      read: () => Effect.succeed(JSON.stringify(payload)),
      write: () => assert.fail("invalid read cannot write"),
    })
    const result = await run(Effect.either(client.inspect(target)))
    assert.ok(Either.isLeft(result))
    assert.equal(result.left.code, "invalid_response")
    assert.ok(!result.left.message.includes("private-provider-error"))
  }
})

test("a mutation response with errors or the wrong target remains possible dispatch, not no-write", async () => {
  for (const payload of [
    {
      data: { addAssigneesToAssignable: { assignable: { id: "wrong-issue" } } },
    },
    { errors: [{ message: "private-provider-error" }] },
    { data: null },
  ]) {
    const client = createGitHubPickupClient({
      read: () => assert.fail("not a read"),
      write: (_request, onDispatch) =>
        Effect.sync(() => {
          onDispatch()
          return JSON.stringify(payload)
        }),
    })
    const result = await run(
      Effect.either(client.assignOwner(target, invocation, () => {})),
    )
    assert.ok(Either.isLeft(result))
    assert.equal(result.left.dispatch, "possible")
    assert.ok(!result.left.message.includes("private-provider-error"))
  }
})

test("stop during assignment retains possible-dispatch evidence and starts no status or recovery read", async () => {
  const source = fixture()
  const entered = Effect.runSync(Deferred.make<void>())
  source.client.assignOwner = (_target, _invocation, onDispatch) =>
    Effect.gen(function* () {
      source.calls.push("assign")
      onDispatch()
      yield* Deferred.succeed(entered, undefined)
      return yield* Effect.never
    })
  let trace: IssuePickupTrace | undefined
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(
    source.picker().next({}, invocation, value => {
      trace = value
    }),
    { signal: controller.signal },
  )
  assert.equal(
    await Promise.race([
      run(Deferred.await(entered)).then(() => true),
      pending.then(() => false),
    ]),
    true,
    "pickup must reach the actual assignment boundary",
  )
  controller.abort()
  const exit = await pending
  assert.ok(Exit.isFailure(exit) && Cause.isInterrupted(exit.cause))
  assert.deepEqual(source.calls, ["inspect", "assign"])
  assert.equal(trace?.assignment, "possible")
})
