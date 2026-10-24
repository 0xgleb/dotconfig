import { Data, Effect } from "effect"

import {
  backlogDocumentSnapshot,
  githubTrackerSnapshot,
  type BacklogSourceAdapterError,
  type GitHubTrackerItemInput,
} from "../shared/backlog-source-adapters.ts"
import type { CanonicalBacklogSnapshot } from "../shared/backlog-events.ts"

export interface BacklogIngestToolRequest {
  readonly action: "ingest_backlog"
  readonly project?: string
  readonly sourceKind?: "github" | "document"
  readonly repository?: string
  readonly coverage?: "partial" | "complete"
  readonly trackerItems?: readonly GitHubTrackerItemInput[]
  readonly documentId?: string
  readonly content?: string
}

export class BacklogIngestToolError extends Data.TaggedError(
  "BacklogIngestToolError",
)<{
  readonly code: "invalid_input"
  readonly message: string
}> {}

const invalid = (message: string): BacklogIngestToolError =>
  new BacklogIngestToolError({ code: "invalid_input", message })

export const backlogSnapshotFromToolRequest = (
  request: BacklogIngestToolRequest,
  currentProject: string,
  observedAt: number,
): Effect.Effect<
  CanonicalBacklogSnapshot,
  BacklogIngestToolError | BacklogSourceAdapterError
> => {
  if (request.action !== "ingest_backlog")
    return Effect.fail(invalid("backlog ingest action is invalid"))
  if (request.project !== undefined && request.project !== currentProject)
    return Effect.fail(
      invalid("backlog ingestion is restricted to the current project"),
    )
  if (request.sourceKind === "github") {
    if (
      request.repository === undefined ||
      request.coverage === undefined ||
      request.trackerItems === undefined ||
      request.documentId !== undefined ||
      request.content !== undefined
    )
      return Effect.fail(invalid("GitHub source fields are invalid"))
    return githubTrackerSnapshot({
      project: currentProject,
      repository: request.repository,
      observedAt,
      coverage: request.coverage,
      items: request.trackerItems,
    })
  }
  if (request.sourceKind === "document") {
    if (
      request.documentId === undefined ||
      request.content === undefined ||
      request.repository !== undefined ||
      request.coverage !== undefined ||
      request.trackerItems !== undefined
    )
      return Effect.fail(invalid("document source fields are invalid"))
    return backlogDocumentSnapshot({
      project: currentProject,
      documentId: request.documentId,
      observedAt,
      content: request.content,
    })
  }
  return Effect.fail(invalid("sourceKind is required"))
}
