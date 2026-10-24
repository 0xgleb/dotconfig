import { Context, Data, Effect } from "effect"
import type { AgentTokenUsage } from "./usage.ts"

export type LeaseMode = "task" | "operational"
export type LeaseStatus = "active" | "paused" | "suspended"
export type LeaseSuspensionReason = "policy_changed"
export type RegistryRequestPriority = "normal" | "urgent"

export interface AgentIdentity {
  readonly id: string
  readonly pid: number
  readonly model?: string
  readonly runtimeVersions?: Readonly<Record<string, string>>
}

interface LeaseBase {
  readonly id: string
  readonly project: string
  readonly role: string
  readonly mode: LeaseMode
  readonly owner: AgentIdentity
  readonly policyDigest: string
  readonly acquiredAt: number
  readonly heartbeatAt: number
  readonly expiresAt: number
}

export type Lease =
  | (LeaseBase & { readonly status: "active" | "paused" })
  | (LeaseBase & {
      readonly status: "suspended"
      readonly reason: LeaseSuspensionReason
    })

interface RequestBase {
  readonly id: string
  readonly project: string
  readonly role: string
  readonly requesterId: string
  readonly requesterLabel?: string
  readonly requesterCwd?: string
  readonly text: string
  readonly priority: RegistryRequestPriority
  readonly createdAt: number
  readonly updatedAt: number
  readonly requesterAcknowledgedAt?: number
  readonly recipientReceivedAt?: number
  readonly recipientAgentId?: string
  readonly recipientLeaseId?: string
}

export type RegistryRequest =
  | (RequestBase & { readonly status: "queued" })
  | (RequestBase & {
      readonly status: "claimed"
      readonly leaseId: string
      readonly agentId: string
    })
  | (RequestBase & {
      readonly status: "completed"
      readonly leaseId: string
      readonly agentId: string
      readonly summary: string
    })
  | (RequestBase & {
      readonly status: "failed"
      readonly leaseId: string
      readonly agentId: string
      readonly failure: "blocked" | "cancelled" | "error" | "timed_out"
      readonly diagnostic: string
    })
  | (RequestBase & { readonly status: "cancelled" })

export type AgentActivityStatus = "in_progress" | "in_review" | "pending"

export interface AgentActivity {
  readonly todoId: number
  readonly status: AgentActivityStatus
  readonly text: string
}

export interface RegisteredAgent {
  readonly identity: AgentIdentity
  readonly cwd: string
  readonly label: string
  readonly usage: AgentTokenUsage
  readonly activities?: readonly AgentActivity[]
  readonly heartbeatAt: number
  readonly expiresAt: number
}

export interface RegistrySnapshot {
  readonly version: 1
  readonly agents?: readonly RegisteredAgent[]
  readonly leases: readonly Lease[]
  readonly requests: readonly RegistryRequest[]
}

export interface AgentHeartbeatInput {
  readonly agent: AgentIdentity
  readonly cwd: string
  readonly label: string
  readonly usage: AgentTokenUsage
  readonly activities?: readonly AgentActivity[]
  readonly now: number
  readonly ttlMs: number
}

export interface ClaimLeaseInput {
  readonly agent: AgentIdentity
  readonly project: string
  readonly role: string
  readonly mode: LeaseMode
  readonly policyDigest: string
  readonly now: number
  readonly ttlMs: number
}

export type ClaimLeaseResult =
  | { readonly outcome: "claimed"; readonly lease: Lease }
  | { readonly outcome: "already_owned"; readonly lease: Lease }

export interface HeartbeatInput {
  readonly leaseId: string
  readonly agentId: string
  readonly policyDigest: string
  readonly runtimeVersions?: Readonly<Record<string, string>>
  readonly now: number
  readonly ttlMs: number
}

export interface PauseLeaseInput {
  readonly leaseId: string
  readonly agentId: string
  readonly now: number
}

export interface ReleaseLeaseInput {
  readonly leaseId: string
  readonly agentId: string
  readonly now: number
}

export interface EnqueueRequestInput {
  readonly project: string
  readonly role: string
  readonly requesterId: string
  readonly requesterLabel?: string
  readonly requesterCwd?: string
  readonly text: string
  readonly priority?: RegistryRequestPriority
  readonly now: number
}

export interface AcknowledgeRequestInput {
  readonly requestId: string
  readonly requesterId: string
  readonly now: number
}

export interface ReceiveRequestInput extends ClaimRequestInput {}

export interface CancelRequestInput {
  readonly requestId: string
  readonly requesterId: string
  readonly now: number
}

export interface ClearExceptProjectInput {
  readonly preservedProject: string
  readonly now: number
}

export interface ClearedRegistryCounts {
  readonly agents: number
  readonly leases: number
  readonly requests: number
}

export interface ClaimRequestInput {
  readonly requestId: string
  readonly leaseId: string
  readonly agentId: string
  readonly now: number
}

export interface AdvanceRequestBacklogInput extends ClaimRequestInput {
  readonly phase: "implementation" | "review" | "publication"
  readonly evidenceRef: string
}

export interface CompleteRequestInput extends ClaimRequestInput {
  readonly summary: string
}

export interface FailRequestInput extends ClaimRequestInput {
  readonly failure: "blocked" | "cancelled" | "error" | "timed_out"
  readonly diagnostic: string
}

export class RegistryError extends Data.TaggedError("RegistryError")<{
  readonly code:
    | "busy"
    | "capacity"
    | "corrupt_state"
    | "invalid_input"
    | "io"
    | "not_found"
    | "stale_lease"
    | "invalid_transition"
  readonly message: string
}> {}

export const registrySyncNotification = (
  failureActive: boolean,
  failureMessage?: string,
): string | undefined => {
  if (failureMessage !== undefined)
    return failureActive ? undefined : `Agent registry: ${failureMessage}`
  return failureActive ? "Agent registry recovered." : undefined
}

export interface RegistryReceiptAvailability {
  readonly notificationsEnabled: boolean
  readonly idle: boolean
  readonly pendingMessages: boolean
  readonly editorText: string
  readonly autoReloadPending: boolean
}

export const registryReceiptAvailable = (
  availability: RegistryReceiptAvailability,
): boolean =>
  availability.notificationsEnabled &&
  availability.idle &&
  !availability.pendingMessages &&
  availability.editorText.length === 0 &&
  !availability.autoReloadPending

export const prioritizedActiveReceiptLeases = (
  snapshot: RegistrySnapshot,
  agentId: string,
): readonly Lease[] =>
  snapshot.leases
    .filter(lease => lease.owner.id === agentId && lease.status === "active")
    .sort(
      (left, right) =>
        Number(right.mode === "operational") -
        Number(left.mode === "operational"),
    )

export interface ReconcileLeaseInput extends ClaimLeaseInput {
  readonly store: RegistryStore
}

export interface RegistryStore {
  readonly snapshot: (
    now: number,
  ) => Effect.Effect<RegistrySnapshot, RegistryError>
  readonly heartbeatAgent: (
    input: AgentHeartbeatInput,
  ) => Effect.Effect<RegisteredAgent, RegistryError>
  readonly claim: (
    input: ClaimLeaseInput,
  ) => Effect.Effect<ClaimLeaseResult, RegistryError>
  readonly heartbeat: (
    input: HeartbeatInput,
  ) => Effect.Effect<Lease, RegistryError>
  readonly pause: (
    input: PauseLeaseInput,
  ) => Effect.Effect<Lease, RegistryError>
  readonly resume: (
    input: HeartbeatInput,
  ) => Effect.Effect<Lease, RegistryError>
  readonly release: (
    input: ReleaseLeaseInput,
  ) => Effect.Effect<void, RegistryError>
  readonly enqueue: (
    input: EnqueueRequestInput,
  ) => Effect.Effect<RegistryRequest, RegistryError>
  readonly receiveRequest: (
    input: ReceiveRequestInput,
  ) => Effect.Effect<RegistryRequest, RegistryError>
  readonly acknowledgeRequest: (
    input: AcknowledgeRequestInput,
  ) => Effect.Effect<RegistryRequest, RegistryError>
  readonly cancelRequest: (
    input: CancelRequestInput,
  ) => Effect.Effect<RegistryRequest, RegistryError>
  readonly clearExceptProject: (
    input: ClearExceptProjectInput,
  ) => Effect.Effect<ClearedRegistryCounts, RegistryError>
  readonly claimRequest: (
    input: ClaimRequestInput,
  ) => Effect.Effect<RegistryRequest, RegistryError>
  readonly advanceRequestBacklog: (
    input: AdvanceRequestBacklogInput,
  ) => Effect.Effect<RegistryRequest, RegistryError>
  readonly completeRequest: (
    input: CompleteRequestInput,
  ) => Effect.Effect<RegistryRequest, RegistryError>
  readonly failRequest: (
    input: FailRequestInput,
  ) => Effect.Effect<RegistryRequest, RegistryError>
}

export const RegistryStore = Context.GenericTag<RegistryStore>(
  "pi/agent-registry/RegistryStore",
)

export const runRegistryEffect: <T>(
  operation: Effect.Effect<T, RegistryError>,
) => Promise<T> = operation => Effect.runPromise(operation)

export const reconcileSessionLease: (
  input: ReconcileLeaseInput,
) => Effect.Effect<ClaimLeaseResult, RegistryError> = input =>
  Effect.gen(function* () {
    const snapshot = yield* input.store.snapshot(input.now)
    const existing = snapshot.leases.find(
      lease =>
        lease.project === input.project &&
        lease.role === input.role &&
        lease.owner.id === input.agent.id,
    )
    if (
      existing &&
      (existing.status === "suspended" ||
        existing.policyDigest !== input.policyDigest)
    ) {
      yield* input.store.release({
        leaseId: existing.id,
        agentId: input.agent.id,
        now: input.now,
      })
    }
    return yield* input.store.claim(input)
  })

export const registrySnapshotForProject = (
  snapshot: RegistrySnapshot,
  project: string,
): RegistrySnapshot => ({
  version: snapshot.version,
  ...(snapshot.agents
    ? { agents: snapshot.agents.filter(agent => agent.cwd === project) }
    : {}),
  leases: snapshot.leases.filter(lease => lease.project === project),
  requests: snapshot.requests.filter(request => request.project === project),
})

export const terminalOutcomeBelongsToContext = (
  request: RegistryRequest,
  requesterId: string,
  cwd: string,
): boolean =>
  request.requesterId === requesterId &&
  request.requesterCwd === cwd &&
  request.project === cwd

export const emptyRegistrySnapshot: RegistrySnapshot = {
  version: 1,
  leases: [],
  requests: [],
}
