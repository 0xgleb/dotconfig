import { Effect } from "effect"
import { CANONICAL_BACKLOG_EVENT } from "./backlog-events.ts"
import type { CanonicalBacklogSnapshot } from "./canonical-backlog.ts"
import {
  BacklogSourceAdapterError,
  githubTrackerSnapshot,
  backlogDocumentSnapshot,
  type GitHubTrackerSnapshotInput,
  type BacklogDocumentSnapshotInput,
} from "./backlog-normalization.ts"

export {
  BacklogSourceAdapterError,
  githubTrackerSnapshot,
  backlogDocumentSnapshot,
  type GitHubTrackerItemInput,
  type GitHubTrackerSnapshotInput,
  type BacklogDocumentSnapshotInput,
} from "./backlog-normalization.ts"

export interface CanonicalBacklogEventEmitter {
  readonly emit: (name: string, value: unknown) => void
}

const adapterError = (
  code: BacklogSourceAdapterError["code"],
  message: string,
): BacklogSourceAdapterError => new BacklogSourceAdapterError({ code, message })

const emitCanonicalSnapshot = (
  emitter: CanonicalBacklogEventEmitter,
  snapshot: Effect.Effect<CanonicalBacklogSnapshot, BacklogSourceAdapterError>,
): Effect.Effect<CanonicalBacklogSnapshot, BacklogSourceAdapterError> =>
  snapshot.pipe(
    Effect.tap(value =>
      Effect.try({
        try: () => emitter.emit(CANONICAL_BACKLOG_EVENT, value),
        catch: () =>
          adapterError("internal_failure", "backlog event emission failed"),
      }),
    ),
  )

export const emitGitHubTrackerSnapshot = (
  emitter: CanonicalBacklogEventEmitter,
  input: GitHubTrackerSnapshotInput,
): Effect.Effect<CanonicalBacklogSnapshot, BacklogSourceAdapterError> =>
  emitCanonicalSnapshot(emitter, githubTrackerSnapshot(input))

export const emitBacklogDocumentSnapshot = (
  emitter: CanonicalBacklogEventEmitter,
  input: BacklogDocumentSnapshotInput,
): Effect.Effect<CanonicalBacklogSnapshot, BacklogSourceAdapterError> =>
  emitCanonicalSnapshot(emitter, backlogDocumentSnapshot(input))
