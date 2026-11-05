import { Data, Effect, Either } from "effect"
import { issueKey, type IssueReference } from "./identity.ts"
import type {
  GitHubInProgressTarget,
  GitHubIssueNodeId,
  GitHubProjectItemId,
} from "./github-project-read.ts"
import type { GitHubUser } from "./github-user.ts"
import type {
  IssueNextObservation,
  IssueNextObserver,
  IssueNextReadFailure,
  IssueNextReader,
} from "./next.ts"
import type { TaskNativeCall } from "./tool.ts"

export interface IssuePickupTarget {
  readonly issue: IssueReference
  readonly issueNodeId: GitHubIssueNodeId
  readonly itemId: GitHubProjectItemId
  readonly viewer: GitHubUser
  readonly inProgress: GitHubInProgressTarget
}

export interface IssuePickupObservation {
  readonly viewer: GitHubUser
  readonly issue: IssueReference
  readonly issueNodeId: GitHubIssueNodeId
  readonly itemId: GitHubProjectItemId
  readonly projectId: GitHubInProgressTarget["projectId"]
  readonly state: "open" | "closed"
  readonly archived: boolean
  readonly assignees: readonly GitHubUser[]
  readonly status: {
    readonly fieldId: GitHubInProgressTarget["fieldId"]
    readonly optionId: GitHubInProgressTarget["optionId"]
  } | null
}

export class IssuePickupReadError extends Data.TaggedError(
  "IssuePickupReadError",
)<{
  readonly code:
    "invalid_request" | "invalid_response" | "unavailable" | "transport_error"
  readonly message: string
}> {}

export class IssuePickupWriteError extends Data.TaggedError(
  "IssuePickupWriteError",
)<{
  readonly dispatch: "not_started" | "possible"
  readonly message: string
}> {}

export interface IssuePickupClient {
  readonly inspect: (
    target: IssuePickupTarget,
  ) => Effect.Effect<IssuePickupObservation, IssuePickupReadError>
  readonly assignOwner: (
    target: IssuePickupTarget,
    invocation: TaskNativeCall,
    onDispatch: () => void,
  ) => Effect.Effect<void, IssuePickupWriteError>
  readonly setInProgress: (
    target: IssuePickupTarget,
    invocation: TaskNativeCall,
    onDispatch: () => void,
  ) => Effect.Effect<void, IssuePickupWriteError>
}

export type IssuePickupStep =
  "not_started" | "not_needed" | "acknowledged" | "possible"

export interface IssuePickupTrace {
  readonly target: IssuePickupTarget
  readonly stage: "preflight" | "assignment" | "status" | "readback"
  readonly assignment: IssuePickupStep
  readonly status: IssuePickupStep
}

export type IssuePickupReceipt = {
  readonly trace: IssuePickupTrace
} & (
  | {
      readonly kind: "verified"
      readonly observed: IssuePickupObservation
      readonly verification: "observed_not_exclusive"
    }
  | { readonly kind: "partial"; readonly observed: IssuePickupObservation }
  | {
      readonly kind: "unknown"
      readonly observed: IssuePickupObservation | null
    }
)

export type IssueNextPickResult =
  | { readonly kind: "none"; readonly observation: IssueNextObservation }
  | {
      readonly kind: "review"
      readonly observation: IssueNextObservation
      readonly observed: IssuePickupObservation
    }
  | {
      readonly kind: "pickup"
      readonly observation: IssueNextObservation
      readonly receipt: IssuePickupReceipt
    }

export class IssueNextPickError extends Data.TaggedError("IssueNextPickError")<{
  readonly code: "unavailable" | "stale_selection" | "inconsistent_readback"
  readonly message: string
}> {}

export interface IssueNextPicker {
  readonly next: (
    input: unknown,
    invocation: TaskNativeCall,
    onTrace?: (trace: IssuePickupTrace) => void,
    observe?: IssueNextObserver,
  ) => Effect.Effect<
    IssueNextPickResult,
    IssueNextReadFailure | IssuePickupReadError | IssueNextPickError
  >
}

const pickError = (code: IssueNextPickError["code"]) =>
  new IssueNextPickError({
    code,
    message: {
      unavailable: "Issue pickup is unavailable",
      stale_selection:
        "The selected issue or owner changed before pickup; no mutation was started",
      inconsistent_readback:
        "Issue selection and its observed pickup target do not match",
    }[code],
  })

const matchingOpenObservation = (
  target: IssuePickupTarget,
  observed: IssuePickupObservation,
): boolean =>
  observed.viewer.id === target.viewer.id &&
  observed.viewer.login === target.viewer.login &&
  issueKey(observed.issue) === issueKey(target.issue) &&
  observed.issueNodeId === target.issueNodeId &&
  observed.itemId === target.itemId &&
  observed.projectId === target.inProgress.projectId &&
  observed.state === "open" &&
  !observed.archived &&
  (observed.status === null ||
    observed.status.fieldId === target.inProgress.fieldId)

const eligibleObservation = (
  target: IssuePickupTarget,
  observed: IssuePickupObservation,
): boolean =>
  matchingOpenObservation(target, observed) &&
  observed.assignees.every(user => user.id === target.viewer.id)

const desiredObservation = (
  target: IssuePickupTarget,
  observed: IssuePickupObservation,
): boolean =>
  eligibleObservation(target, observed) &&
  observed.assignees.some(user => user.id === target.viewer.id) &&
  observed.status?.optionId === target.inProgress.optionId

const freezeObservation = (
  observed: IssuePickupObservation,
): IssuePickupObservation =>
  Object.freeze({
    ...observed,
    viewer: Object.freeze({ ...observed.viewer }),
    issue: Object.freeze({ ...observed.issue }),
    assignees: Object.freeze(
      observed.assignees.map(user => Object.freeze({ ...user })),
    ),
    status:
      observed.status === null ? null : Object.freeze({ ...observed.status }),
  })

export const createIssueNextPicker = (options: {
  readonly reader: Pick<IssueNextReader, "read">
  readonly pickup: IssuePickupClient
}): IssueNextPicker => {
  const captured = Either.try({
    try: () => ({
      read: options.reader.read,
      inspect: options.pickup.inspect,
      assign: options.pickup.assignOwner,
      status: options.pickup.setInProgress,
    }),
    catch: () => pickError("unavailable"),
  })

  const next: IssueNextPicker["next"] = (input, invocation, onTrace, observe) =>
    Effect.gen(function* () {
      yield* Effect.yieldNow()
      const ports = yield* captured
      const observation = yield* ports.read(input, observe)
      const selected = observation.selected
      if (observation.selection.kind === "none") {
        if (selected !== null)
          return yield* Effect.fail(pickError("inconsistent_readback"))
        return Object.freeze({ kind: "none" as const, observation })
      }
      if (
        selected === null ||
        issueKey(selected.issue) !== issueKey(observation.selection.issue)
      )
        return yield* Effect.fail(pickError("inconsistent_readback"))
      const target: IssuePickupTarget = Object.freeze({
        issue: selected.issue,
        issueNodeId: selected.issueNodeId,
        itemId: selected.itemId,
        viewer: observation.viewer,
        inProgress: observation.inProgress,
      })
      if (observation.review !== undefined) {
        const observed = freezeObservation(yield* ports.inspect(target))
        const status = observation.review.status
        if (
          !matchingOpenObservation(target, observed) ||
          status.projectId !== target.inProgress.projectId ||
          status.fieldId !== target.inProgress.fieldId ||
          observed.status?.fieldId !== status.fieldId ||
          observed.status.optionId !== status.optionId
        )
          return yield* Effect.fail(pickError("stale_selection"))
        return Object.freeze({ kind: "review" as const, observation, observed })
      }
      let trace: IssuePickupTrace = Object.freeze({
        target,
        stage: "preflight",
        assignment: "not_started",
        status: "not_started",
      })
      const record = (next: IssuePickupTrace): void => {
        trace = Object.freeze(next)
        onTrace?.(trace)
      }
      record(trace)
      const initial = freezeObservation(yield* ports.inspect(target))
      if (
        !eligibleObservation(target, initial) ||
        (initial.status !== null &&
          observation.refineOptions?.includes(initial.status.optionId) === true)
      )
        return yield* Effect.fail(pickError("stale_selection"))
      record({
        ...trace,
        assignment: initial.assignees.some(user => user.id === target.viewer.id)
          ? "not_needed"
          : "not_started",
        status:
          initial.status?.optionId === target.inProgress.optionId
            ? "not_needed"
            : "not_started",
      })
      const result = (receipt: IssuePickupReceipt): IssueNextPickResult =>
        Object.freeze({
          kind: "pickup",
          observation,
          receipt: Object.freeze(receipt),
        })
      const finish = () =>
        Effect.gen(function* () {
          record({ ...trace, stage: "readback" })
          const readback = yield* Effect.either(ports.inspect(target))
          if (Either.isLeft(readback))
            return result({ kind: "unknown", trace, observed: null })
          const observed = freezeObservation(readback.right)
          if (desiredObservation(target, observed))
            return result({
              kind: "verified",
              trace,
              observed,
              verification: "observed_not_exclusive",
            })
          return trace.assignment === "possible" || trace.status === "possible"
            ? result({ kind: "unknown", trace, observed })
            : result({ kind: "partial", trace, observed })
        })
      if (desiredObservation(target, initial))
        return result({
          kind: "verified",
          trace,
          observed: initial,
          verification: "observed_not_exclusive",
        })
      if (trace.assignment !== "not_needed") {
        record({ ...trace, stage: "assignment" })
        const assigned = yield* Effect.either(
          Effect.suspend(() =>
            ports.assign(target, invocation, () => {
              record({ ...trace, assignment: "possible" })
            }),
          ),
        )
        if (Either.isLeft(assigned)) {
          if (assigned.left.dispatch === "possible")
            record({ ...trace, assignment: "possible" })
          return yield* finish()
        }
        record({ ...trace, assignment: "acknowledged" })
      }
      if (trace.status !== "not_needed") {
        record({ ...trace, stage: "status" })
        const started = yield* Effect.either(
          Effect.suspend(() =>
            ports.status(target, invocation, () => {
              record({ ...trace, status: "possible" })
            }),
          ),
        )
        if (Either.isLeft(started)) {
          if (started.left.dispatch === "possible")
            record({ ...trace, status: "possible" })
          return yield* finish()
        }
        record({ ...trace, status: "acknowledged" })
      }
      return yield* finish()
    })

  return Object.freeze({ next })
}
