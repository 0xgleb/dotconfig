import assert from "node:assert/strict"
import { Effect, Either, Schema } from "effect"
import { decodeIssueReference } from "../identity.ts"
import { GitHubUserSchema } from "../github-user.ts"
import {
  GitHubInProgressTargetSchema,
  GitHubIssueNodeIdSchema,
  ProjectItemIdSchema,
} from "../github-project-read.ts"
import { createIssueNextPicker } from "../pickup.ts"
import { selectIssueAssignment } from "../selector.ts"

export const nativeNextResult = async (
  number = 7,
  mode: "implementation" | "review" = "implementation",
) => {
  const reference = decodeIssueReference({ repository: "owner/repo", number })
  assert.ok(Either.isRight(reference))
  const issue = reference.right
  const viewer = Schema.decodeUnknownSync(GitHubUserSchema)({
    id: "viewer-id",
    login: "fixture-owner",
  })
  const inProgress = Schema.decodeUnknownSync(GitHubInProgressTargetSchema)({
    projectId: "project-id",
    fieldId: "status-field",
    optionId: "in-progress",
  })
  const itemId = Schema.decodeUnknownSync(ProjectItemIdSchema)(`item-${number}`)
  const issueNodeId = Schema.decodeUnknownSync(GitHubIssueNodeIdSchema)(
    `issue-${number}`,
  )
  const reviewStatus = Schema.decodeUnknownSync(GitHubInProgressTargetSchema)({
    ...inProgress,
    optionId: "in-review",
  })
  const status = {
    fieldId: inProgress.fieldId,
    optionId: mode === "review" ? reviewStatus.optionId : inProgress.optionId,
  }
  const selection = Effect.runSync(
    selectIssueAssignment({
      scope: [issue],
      coverage: "complete",
      candidates: [
        {
          issue,
          state: "open",
          priority: { kind: "number", value: 1 },
          effort: { kind: "number", value: 1 },
          eligibility: { blockers: "clear", dependencies: "clear" },
        },
      ],
    }),
  )
  const observed = {
    issue,
    viewer,
    issueNodeId,
    itemId,
    projectId: inProgress.projectId,
    state: "open" as const,
    archived: false,
    assignees: [viewer],
    status,
  }
  const result = await Effect.runPromise(
    createIssueNextPicker({
      reader: {
        read: () =>
          Effect.succeed({
            selection,
            viewer,
            inProgress,
            excludedAssignments: [],
            ...(mode === "review" ? { review: { status: reviewStatus } } : {}),
            selected: {
              kind: "issue",
              issue,
              itemId,
              issueNodeId,
              assignees: [viewer],
              status: status.optionId,
              state: "open",
              priority: { kind: "number", value: 1 },
              effort: { kind: "number", value: 1 },
            },
          }),
      },
      pickup: {
        inspect: () => Effect.succeed(observed),
        assignOwner: () =>
          Effect.sync(() => assert.fail("Fixture is already assigned")),
        setInProgress: () =>
          Effect.sync(() =>
            assert.fail("Fixture already has its requested status"),
          ),
      },
    }).next(
      {},
      { sessionId: "fixture-session", toolCallId: `fixture-next-${number}` },
    ),
  )
  return {
    args: {
      action: "next",
      query: { repository: issue.repository, project: "personal", mode },
    },
    details: { outcome: { kind: "issue_next", result }, output: "complete" },
    issue,
  }
}
