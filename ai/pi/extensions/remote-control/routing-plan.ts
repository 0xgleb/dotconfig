import {
  servesProject,
  type RosterAgent,
  type RouteDirective,
} from "./protocol.ts";

export const MAX_ROUTING_HINT_CHARACTERS = 300;
export const QUEUED_RECEIVER_ID = "queue";
export const QUEUED_RECEIVER_LABEL =
  "receiver offline - queued for its next poll";

/**
 * A project the routing turn may address, and who would receive work sent
 * there. A live entry names the bridge agent that is polling right now, which
 * is the identity a delegated request records so that receiver can close the
 * request with an outcome envelope later. A queued entry names a project the
 * registry knows about whose receiver is merely between polls: the work waits
 * in the registry and no receiver identity can be promised for it.
 */
export type RoutableProject =
  | {
      readonly availability: "live";
      readonly project: string;
      readonly agentId: string;
    }
  | { readonly availability: "queued"; readonly project: string };

export interface RoutingRoster {
  /** Roster shown to the router model, in prompt order. */
  readonly roster: readonly RosterAgent[];
  readonly routable: readonly RoutableProject[];
}

export interface RoutingRosterInput {
  readonly live: readonly RosterAgent[];
  readonly known: readonly string[];
  readonly dispatcherAgentId: string;
}

/**
 * Builds the roster a routing turn decides against.
 *
 * The dispatcher heartbeats itself into the same bridge roster it reads, so
 * without removing its own entry it is always its own receiver: the catch-all
 * guard that is supposed to hold unroutable messages back can never refuse,
 * and the router model is offered the dispatcher session as a destination for
 * work the dispatch lane is barred from claiming.
 *
 * A registry project stands in as a queued receiver only when no remaining
 * live agent serves it, which is the same direction routing admits directives
 * in: an agent rooted in a worktree does not serve its parent project, so the
 * parent keeps its own queue entry.
 */
export const routingRoster = (input: RoutingRosterInput): RoutingRoster => {
  const peers = input.live.filter(
    (agent) => agent.id !== input.dispatcherAgentId,
  );
  const offline = input.known
    .filter((project) => !peers.some(({ cwd }) => servesProject(cwd, project)))
    .map((project) => ({
      id: QUEUED_RECEIVER_ID,
      label: QUEUED_RECEIVER_LABEL,
      cwd: project,
    }));
  return {
    roster: [...peers, ...offline],
    routable: [
      ...peers.map(
        (agent): RoutableProject => ({
          availability: "live",
          project: agent.cwd,
          agentId: agent.id,
        }),
      ),
      ...offline.map(
        (agent): RoutableProject => ({
          availability: "queued",
          project: agent.cwd,
        }),
      ),
    ],
  };
};

/**
 * One enqueue the routing turn owes the registry: the project string the row
 * is filed under, the receiver that row is assigned to when one is live, and
 * the batch positions whose text travels in the bundle.
 */
export interface RoutingDelegation {
  readonly project: string;
  readonly assignedAgentId?: string;
  readonly indexes: readonly number[];
  readonly note?: string;
}

export interface RoutingBatch {
  readonly size: number;
  readonly routable: readonly RoutableProject[];
  readonly dispatcherProject: string;
}

/**
 * Resolves a project named by the router model to the routable entry that
 * serves it, preferring the most specific one.
 *
 * The registry matches a queued row to a drainer by exact project string, so a
 * directive naming a subdirectory of a routable project has to be filed under
 * that project's root or nothing can ever claim the row - the message would be
 * acknowledged as routed and then sit until it expired.
 */
export const resolveRoutable = (
  routable: readonly RoutableProject[],
  project: string,
): RoutableProject | undefined =>
  routable
    .filter((entry) => servesProject(entry.project, project))
    .reduce<RoutableProject | undefined>(
      (best, entry) => (best === undefined ? entry : moreSpecific(best, entry)),
      undefined,
    );

/**
 * Turns a parsed route plan into the enqueues it implies.
 *
 * Every directive is filed under the routable project root that serves it, and
 * messages no directive covers fall back to the dispatcher's own project -
 * but only when some other agent is routable there, since delegating to a
 * project nothing drains reports the message as routed and then swallows it.
 */
export const routingDelegations = (
  plan: readonly RouteDirective[],
  batch: RoutingBatch,
): readonly RoutingDelegation[] => {
  const routed = plan.flatMap((directive) => {
    const target = resolveRoutable(batch.routable, directive.project);
    return target === undefined
      ? []
      : [delegation(target, directive.indexes, directive.note)];
  });
  const covered = new Set(routed.flatMap((entry) => [...entry.indexes]));
  const unrouted = Array.from(
    { length: batch.size },
    (_unused, position) => position + 1,
  ).filter((index) => !covered.has(index));
  const catchAll =
    unrouted.length > 0
      ? resolveRoutable(batch.routable, batch.dispatcherProject)
      : undefined;
  return catchAll === undefined
    ? routed
    : [...routed, delegation(catchAll, unrouted)];
};

/**
 * The note is the one part of a routed bundle the local router model authors
 * itself, and its own context is full of untrusted owner and agent text. It is
 * labelled as an untrusted hint and flattened to a single line so it can
 * neither pose as owner intent nor open its own section in the bundle.
 */
export const routingHint = (note: string): string =>
  `Routing hint from the local router model (untrusted, not owner intent): ${note
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_ROUTING_HINT_CHARACTERS)}`;

/**
 * The text delivered to a receiver: the untrusted routing hint, when the model
 * wrote one, followed by the original message texts verbatim.
 */
export const routedBundle = (
  delegation: RoutingDelegation,
  texts: readonly string[],
): string =>
  [
    ...(delegation.note === undefined ? [] : [routingHint(delegation.note)]),
    ...delegation.indexes.map((index) => texts[index - 1] ?? ""),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n---\n\n");

/**
 * Identifiers of one claimed row. Failing a turn has to resolve every row the
 * turn claimed, and `claimNext` only ever selects queued rows, so a row left
 * `claimed` is invisible until its delivery window lapses.
 */
export interface BridgeClaim {
  readonly id: string;
  readonly claimToken: string;
}

export interface ClaimingTurn {
  readonly messageId: string;
  readonly claimToken: string;
  readonly batch?: readonly BridgeClaim[];
}

/**
 * A routing turn claims a whole batch but carries only the first row's
 * identifiers, so failing the turn by those identifiers alone abandons the
 * rest of the batch in `claimed`, where nothing reclaims it and only the
 * one-hour expiry sweep ever resolves it.
 */
export const turnClaims = (turn: ClaimingTurn): readonly BridgeClaim[] =>
  turn.batch ?? [{ id: turn.messageId, claimToken: turn.claimToken }];

export interface OwnerPaneSubmission {
  readonly sessionId: string;
  readonly sequence: number;
  readonly now: number;
}

/**
 * Dedupe keys are matched against every row the requester ever wrote,
 * including rows that already completed, so a key derived from the message
 * text made the bridge hand back an hour-old finished row instead of queueing
 * the owner's new one - the pane went silent for anything typed twice. Each
 * pane submission gets its own key: the owner repeating themselves is asking
 * for the work again, not retrying a lost message.
 */
export const ownerPaneDedupeKey = (submission: OwnerPaneSubmission): string =>
  `pane-${submission.sessionId}-${submission.now}-${submission.sequence}`;

/**
 * The dispatch lane routes by delegating text through the registry, which has
 * no attachment channel, so an image can only be dropped on the way. The
 * sender is told instead of being handed a "Routed to ..." acknowledgement for
 * content the receiver never gets.
 */
export const attachmentRefusal = (imageCount: number): string =>
  `Not routed: the dispatch lane delivers text only and this message carries ${imageCount} ${imageCount === 1 ? "attachment" : "attachments"}. Send it to the receiving agent directly, or resend the request as text.`;

const moreSpecific = (
  left: RoutableProject,
  right: RoutableProject,
): RoutableProject => {
  if (left.project.length !== right.project.length)
    return left.project.length > right.project.length ? left : right;
  return left.availability === "live" ? left : right;
};

const delegation = (
  target: RoutableProject,
  indexes: readonly number[],
  note?: string,
): RoutingDelegation => ({
  project: target.project,
  ...(target.availability === "live" ? { assignedAgentId: target.agentId } : {}),
  indexes,
  ...(note === undefined ? {} : { note }),
});
