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
  /**
   * Bridge agent this request was routed to, recorded when the dispatch flow
   * enqueued it. Outcome envelopes travel over the bridge, so the agent named
   * here is the one entitled to close the row even though it holds no lease.
   * Pi sessions register on the bridge under their own registry session ids, so
   * an assignment can name a session that also holds a lease: that session, and
   * only that session, may additionally claim the row and run it locally (see
   * `claimableRequests`).
   *
   * The sender it is compared against is self-asserted. The bridge relays the
   * requester id its local caller declared and authenticates nothing, so this
   * fence holds within the local machine trust boundary: it stops an honest
   * lane from closing work it was never given, and any process that can already
   * run the bridge CLI can name whichever agent it likes.
   */
  readonly assignedAgentId?: string;
}

/**
 * The party that moved a request to its terminal status.
 *
 * A session draining its own queue closes the row under the lease it claimed it
 * with, so both the lease and the session are known. A routed request is
 * instead closed by the bridge agent it was assigned to, which holds no lease
 * and never claimed the row: there is no lease to name, only the reporter.
 */
export type RequestClosure =
  | {
      readonly party: "lease_holder";
      readonly leaseId: string;
      readonly agentId: string;
    }
  | { readonly party: "reporter"; readonly agentId: string };

export type RegistryRequest =
  | (RequestBase & { readonly status: "queued" })
  | (RequestBase & {
      readonly status: "claimed";
      readonly leaseId: string;
      readonly agentId: string;
    })
  | (RequestBase & {
      readonly status: "completed";
      /**
       * Absent only for a terminal row persisted without a closing identity,
       * which no adapter writes: a stored row is decoded, never assumed.
       */
      readonly closedBy?: RequestClosure;
      readonly summary: string;
    })
  | (RequestBase & {
      readonly status: "failed";
      readonly closedBy?: RequestClosure;
      readonly failure: "blocked" | "cancelled" | "error" | "timed_out";
      readonly diagnostic: string;
    })
  | (RequestBase & { readonly status: "cancelled" });

export interface RegisteredAgent {
  readonly identity: AgentIdentity;
  readonly cwd: string;
  readonly label: string;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
}

export interface RegistrySnapshot {
  readonly version: 1;
  readonly agents?: readonly RegisteredAgent[];
  readonly leases: readonly Lease[];
  readonly requests: readonly RegistryRequest[];
}

export interface AgentHeartbeatInput {
  readonly agent: AgentIdentity;
  readonly cwd: string;
  readonly label: string;
  readonly now: number;
  readonly ttlMs: number;
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
  readonly assignedAgentId?: string;
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

export type ReportedOutcome =
  | { readonly resolution: "completed"; readonly summary: string }
  | {
      readonly resolution: "failed";
      readonly failure: "blocked" | "cancelled" | "error" | "timed_out";
      readonly diagnostic: string;
    };

/**
 * A routed request closed by the agent that reported its outcome rather than
 * by a lease holder performing its own transition. Entitlement is checked
 * against the row: the reporter is either the agent the request was assigned
 * to at routing time, or the session holding the project role lease. No lease
 * of the caller's own is involved, so a lane that merely relays the envelope
 * never has to impersonate the worker to record what it said.
 */
export interface ResolveRequestInput {
  readonly requestId: string;
  readonly reporterId: string;
  readonly outcome: ReportedOutcome;
  readonly now: number;
}

/**
 * Why a reporter may not close a request. The store fences this on the row and
 * the outcome workflow tests the same entitlement before it decides anything
 * else about the row, so both paths name one reason to the reporter.
 */
export const NOT_ENTITLED_TO_CLOSE =
  "reporter is neither the assigned agent nor the holder of the request role";

export class RegistryError extends Data.TaggedError("RegistryError")<{
  readonly code:
    | "busy"
    | "capacity"
    | "corrupt_state"
    | "invalid_input"
    | "io"
    | "not_entitled"
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
  readonly heartbeatAgent: (input: AgentHeartbeatInput) => Effect.Effect<RegisteredAgent, RegistryError>;
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
  readonly resolveRequest: (input: ResolveRequestInput) => Effect.Effect<RegistryRequest, RegistryError>;
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

export type SessionLane = "full-capability" | "local-dispatch";

export interface ClaimableRequestsInput {
  readonly snapshot: RegistrySnapshot;
  readonly lease: Lease;
  readonly lane: SessionLane;
}

/**
 * The queue rows a session holding `lease` may claim and then run itself.
 *
 * The dispatch lane routes messages and records the outcomes that come back and
 * never executes queue work, so a claim there hides the row from the receiver
 * that would have run it while the registry reports a live owner.
 *
 * Beyond that lane, the name a row carries decides which of the two delivery
 * paths applies. A receiver reachable only over the bridge reads its assignment
 * while the row stays queued and closes it with an outcome envelope, so a claim
 * on that row is a second delivery of the same instruction and whichever
 * executor reports back second loses the transition. A Pi-native receiver
 * instead registers on the bridge under its own registry session id, so a row
 * naming that id is addressed to the very session reading it, and claiming it is
 * the delivery rather than a duplicate of one. Both paths follow from comparing
 * the assignment against the owner of `lease`: an unassigned row is drained by
 * whichever session holds the role, a row naming that session belongs to it, and
 * a row naming any other agent is never claimed out from under that agent.
 *
 * The claiming session's identity reaches this comparison through `lease.owner`,
 * which is the same identity the caller filtered the lease by and the same one
 * it claims the row with.
 */
export const claimableRequests: (
  input: ClaimableRequestsInput,
) => readonly RegistryRequest[] = ({ snapshot, lease, lane }) =>
  lane === "local-dispatch"
    ? []
    : snapshot.requests.filter(
        (request) =>
          request.project === lease.project &&
          request.role === lease.role &&
          (request.assignedAgentId === undefined ||
            request.assignedAgentId === lease.owner.id) &&
          (request.status === "queued" ||
            (request.status === "claimed" && request.leaseId !== lease.id)),
      );

export const emptyRegistrySnapshot: RegistrySnapshot = { version: 1, leases: [], requests: [] };
