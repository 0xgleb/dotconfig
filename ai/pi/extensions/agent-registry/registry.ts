import { Context, Data, Effect, Either } from "effect";

export type LeaseMode = "task" | "operational";
export type LeaseStatus = "active" | "paused" | "suspended";
export type LeaseSuspensionReason = "policy_changed";

export interface AgentIdentity {
  readonly id: string;
  readonly pid: number;
  readonly model?: string;
  readonly runtimeVersions?: Readonly<Record<string, string>>;
}

interface LeaseBase {
  readonly id: string;
  readonly project: string;
  readonly role: string;
  readonly mode: LeaseMode;
  readonly owner: AgentIdentity;
  readonly policyDigest: string;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
}

export type Lease =
  | (LeaseBase & { readonly status: "active" | "paused" })
  | (LeaseBase & { readonly status: "suspended"; readonly reason: LeaseSuspensionReason });

interface RequestBase {
  readonly id: string;
  readonly project: string;
  readonly role: string;
  readonly requesterId: string;
  readonly requesterLabel?: string;
  readonly requesterCwd?: string;
  readonly text: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly requesterAcknowledgedAt?: number;
}

export type RegistryRequest =
  | (RequestBase & { readonly status: "queued" })
  | (RequestBase & {
      readonly status: "claimed";
      readonly leaseId: string;
      readonly agentId: string;
    })
  | (RequestBase & {
      readonly status: "completed";
      readonly leaseId: string;
      readonly agentId: string;
      readonly summary: string;
    })
  | (RequestBase & {
      readonly status: "failed";
      readonly leaseId: string;
      readonly agentId: string;
      readonly failure: "blocked" | "cancelled" | "error" | "timed_out";
      readonly diagnostic: string;
    })
  | (RequestBase & { readonly status: "cancelled" });

export interface RegistrySnapshot {
  readonly version: 1;
  readonly leases: readonly Lease[];
  readonly requests: readonly RegistryRequest[];
}

export interface ClaimLeaseInput {
  readonly agent: AgentIdentity;
  readonly project: string;
  readonly role: string;
  readonly mode: LeaseMode;
  readonly policyDigest: string;
  readonly now: number;
  readonly ttlMs: number;
}

export type ClaimLeaseResult =
  | { readonly outcome: "claimed"; readonly lease: Lease }
  | { readonly outcome: "already_owned"; readonly lease: Lease };

export interface HeartbeatInput {
  readonly leaseId: string;
  readonly agentId: string;
  readonly policyDigest: string;
  readonly runtimeVersions?: Readonly<Record<string, string>>;
  readonly now: number;
  readonly ttlMs: number;
}

export interface PauseLeaseInput {
  readonly leaseId: string;
  readonly agentId: string;
  readonly now: number;
}

export interface ReleaseLeaseInput {
  readonly leaseId: string;
  readonly agentId: string;
  readonly now: number;
}

export interface EnqueueRequestInput {
  readonly project: string;
  readonly role: string;
  readonly requesterId: string;
  readonly requesterLabel?: string;
  readonly requesterCwd?: string;
  readonly text: string;
  readonly now: number;
}

export interface AcknowledgeRequestInput {
  readonly requestId: string;
  readonly requesterId: string;
  readonly now: number;
}

export interface CancelRequestInput {
  readonly requestId: string;
  readonly requesterId: string;
  readonly now: number;
}

export interface ClaimRequestInput {
  readonly requestId: string;
  readonly leaseId: string;
  readonly agentId: string;
  readonly now: number;
}

export interface CompleteRequestInput extends ClaimRequestInput {
  readonly summary: string;
}

export interface FailRequestInput extends ClaimRequestInput {
  readonly failure: "blocked" | "cancelled" | "error" | "timed_out";
  readonly diagnostic: string;
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
    | "invalid_transition";
  readonly message: string;
}> {}

export interface ReconcileLeaseInput extends ClaimLeaseInput {
  readonly store: RegistryStore;
}

export interface RegistryStore {
  readonly snapshot: (now: number) => Effect.Effect<RegistrySnapshot, RegistryError>;
  readonly claim: (input: ClaimLeaseInput) => Effect.Effect<ClaimLeaseResult, RegistryError>;
  readonly heartbeat: (input: HeartbeatInput) => Effect.Effect<Lease, RegistryError>;
  readonly pause: (input: PauseLeaseInput) => Effect.Effect<Lease, RegistryError>;
  readonly resume: (input: HeartbeatInput) => Effect.Effect<Lease, RegistryError>;
  readonly release: (input: ReleaseLeaseInput) => Effect.Effect<void, RegistryError>;
  readonly enqueue: (input: EnqueueRequestInput) => Effect.Effect<RegistryRequest, RegistryError>;
  readonly acknowledgeRequest: (input: AcknowledgeRequestInput) => Effect.Effect<RegistryRequest, RegistryError>;
  readonly cancelRequest: (input: CancelRequestInput) => Effect.Effect<RegistryRequest, RegistryError>;
  readonly claimRequest: (input: ClaimRequestInput) => Effect.Effect<RegistryRequest, RegistryError>;
  readonly completeRequest: (input: CompleteRequestInput) => Effect.Effect<RegistryRequest, RegistryError>;
  readonly failRequest: (input: FailRequestInput) => Effect.Effect<RegistryRequest, RegistryError>;
}

export const RegistryStore = Context.GenericTag<RegistryStore>("pi/agent-registry/RegistryStore");

export const runRegistryEffect: <T>(operation: Effect.Effect<T, RegistryError>) => Promise<T> = async (operation) => {
  const result = await Effect.runPromise(Effect.either(operation));
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

export const reconcileSessionLease: (
  input: ReconcileLeaseInput,
) => Effect.Effect<ClaimLeaseResult, RegistryError> = (input) =>
  Effect.gen(function* () {
    const snapshot = yield* input.store.snapshot(input.now);
    const existing = snapshot.leases.find(
      (lease) =>
        lease.project === input.project &&
        lease.role === input.role &&
        lease.owner.id === input.agent.id,
    );
    if (existing && (existing.status === "suspended" || existing.policyDigest !== input.policyDigest)) {
      yield* input.store.release({ leaseId: existing.id, agentId: input.agent.id, now: input.now });
    }
    return yield* input.store.claim(input);
  });

export const emptyRegistrySnapshot: RegistrySnapshot = { version: 1, leases: [], requests: [] };
