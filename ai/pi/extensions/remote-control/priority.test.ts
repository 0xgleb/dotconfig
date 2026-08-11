import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parseRoutePlan } from "./protocol.ts"
import {
  QUEUED_RECEIVER_LABEL,
  attachmentRefusal,
  ownerPaneDedupeKey,
  routedBundle,
  routingDelegations,
  routingHint,
  routingRoster,
  turnClaims,
  type RoutableProject,
} from "./routing-plan.ts"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")

const DISPATCHER = "/Users/example/.config"
const DISPATCHER_AGENT_ID = "pi-dispatcher"

const projects = (routable: readonly RoutableProject[]): readonly string[] =>
  routable.map(({ project }) => project)

test("Telegram prompts steer an active local turn at the next safe boundary", () => {
  assert.match(source, /accepting: active === undefined/)
  assert.doesNotMatch(source, /accepting: ctx\.isIdle\(\)/)
  assert.match(
    source,
    /remoteTurnContent\(message\.text, message\.images\)[\s\S]*?sendUserMessage\(content, \{[\s\S]*?deliverAs: "steer"/,
  )
  assert.doesNotMatch(source, /if \(active \|\| !ctx\.isIdle\(\)\) return/)
})

test("routing turns roster known projects whose receiver holds no live lease", () => {
  const roster = routingRoster({
    live: [
      { id: DISPATCHER_AGENT_ID, label: "dispatcher", cwd: DISPATCHER },
      { id: "pi-yielduck", label: "yielduck", cwd: "/Users/example/yielduck" },
    ],
    known: ["/Users/example/yielduck", "/Users/example/issuance"],
    dispatcherAgentId: DISPATCHER_AGENT_ID,
  })

  assert.deepEqual(
    roster.roster.map(({ cwd, label }) => ({ cwd, label })),
    [
      { cwd: "/Users/example/yielduck", label: "yielduck" },
      { cwd: "/Users/example/issuance", label: QUEUED_RECEIVER_LABEL },
    ],
    "a known project with no live agent is offered as a queued receiver",
  )
  assert.deepEqual(roster.routable, [
    {
      availability: "live",
      project: "/Users/example/yielduck",
      agentId: "pi-yielduck",
    },
    { availability: "queued", project: "/Users/example/issuance" },
  ])
})

test("a project stays routable while an agent rooted in its worktree is live", () => {
  const roster = routingRoster({
    live: [
      {
        id: "pi-worktree",
        label: "worktree session",
        cwd: `${DISPATCHER}/.worktrees/local-dispatcher-lane`,
      },
    ],
    known: [DISPATCHER],
    dispatcherAgentId: DISPATCHER_AGENT_ID,
  })

  assert.deepEqual(
    roster.routable.filter(({ project }) => project === DISPATCHER),
    [{ availability: "queued", project: DISPATCHER }],
    "a worktree pane does not serve its parent project, so the project keeps its queue entry",
  )
  assert.deepEqual(
    parseRoutePlan(
      `route: ${DISPATCHER} | messages: 1`,
      1,
      projects(roster.routable),
    ),
    [{ project: DISPATCHER, indexes: [1] }],
    "a directive naming the parent project must survive the routable filter",
  )
})

test("the dispatcher's own session is not a receiver it can route to", () => {
  const roster = routingRoster({
    live: [{ id: DISPATCHER_AGENT_ID, label: "dispatcher", cwd: DISPATCHER }],
    known: [],
    dispatcherAgentId: DISPATCHER_AGENT_ID,
  })

  assert.deepEqual(roster.roster, [], "the model is never offered itself")
  assert.deepEqual(
    routingDelegations([], {
      size: 2,
      routable: roster.routable,
      dispatcherProject: DISPATCHER,
    }),
    [],
    "the catch-all must not fire into a project only the dispatcher sits in",
  )
})

test("unrouted messages fall back to the dispatcher project another agent serves", () => {
  const roster = routingRoster({
    live: [
      { id: DISPATCHER_AGENT_ID, label: "dispatcher", cwd: DISPATCHER },
      { id: "pi-config", label: "config receiver", cwd: DISPATCHER },
    ],
    known: [],
    dispatcherAgentId: DISPATCHER_AGENT_ID,
  })

  assert.deepEqual(
    routingDelegations([{ project: DISPATCHER, indexes: [1] }], {
      size: 3,
      routable: roster.routable,
      dispatcherProject: DISPATCHER,
    }),
    [
      { project: DISPATCHER, assignedAgentId: "pi-config", indexes: [1] },
      { project: DISPATCHER, assignedAgentId: "pi-config", indexes: [2, 3] },
    ],
  )
})

test("a routed directive records the receiver the turn picked", () => {
  const roster = routingRoster({
    live: [
      { id: "pi-yielduck", label: "yielduck", cwd: "/Users/example/yielduck" },
    ],
    known: ["/Users/example/issuance"],
    dispatcherAgentId: DISPATCHER_AGENT_ID,
  })
  const plan = parseRoutePlan(
    [
      "route: /Users/example/yielduck | messages: 1 | note: check the fills",
      "route: /Users/example/issuance | messages: 2",
    ].join("\n"),
    2,
    projects(roster.routable),
  )

  assert.deepEqual(
    routingDelegations(plan, {
      size: 2,
      routable: roster.routable,
      dispatcherProject: DISPATCHER,
    }),
    [
      {
        project: "/Users/example/yielduck",
        assignedAgentId: "pi-yielduck",
        indexes: [1],
        note: "check the fills",
      },
      { project: "/Users/example/issuance", indexes: [2] },
    ],
    "a live receiver is recorded as the assignee; a merely queued project promises nobody",
  )
})

test("a directive naming a subdirectory is filed under the routable project root", () => {
  const roster = routingRoster({
    live: [{ id: "pi-st0x", label: "st0x", cwd: "/Users/example/st0x" }],
    known: [],
    dispatcherAgentId: DISPATCHER_AGENT_ID,
  })
  const plan = parseRoutePlan(
    "route: /Users/example/st0x/st0x.issuance | messages: 1",
    1,
    projects(roster.routable),
  )

  assert.deepEqual(
    routingDelegations(plan, {
      size: 1,
      routable: roster.routable,
      dispatcherProject: DISPATCHER,
    }),
    [
      {
        project: "/Users/example/st0x",
        assignedAgentId: "pi-st0x",
        indexes: [1],
      },
    ],
    "the registry matches a queued row to its drainer by exact project string",
  )
})

test("the delegate request carries the assignment the routing turn resolved", () => {
  assert.match(
    source,
    /const delegations = routingDelegations\(plan, \{[\s\S]*?routable,[\s\S]*?dispatcherProject: ctx\.cwd,/,
  )
  assert.match(source, /assignedAgentId: delegation\.assignedAgentId/)
  assert.doesNotMatch(
    source,
    /delegateToProject\(directive\.project/,
    "enqueueing the model's raw path skips both the assignment and the project root",
  )
})

test("outcome envelopes carry the claiming row's bridge requester as the sender", () => {
  assert.match(
    source,
    /interface ClaimedBridgeMessage \{[\s\S]*?readonly requesterId: string;/,
  )
  assert.match(
    source,
    /const message: ClaimedBridgeMessage = \{[\s\S]*?requesterId: claimed\.right\.requesterId,/,
  )
  assert.match(source, /senderId: message\.requesterId,/)
})

test("a failed routing turn fails every message it claimed, not just the first", () => {
  const batch = [
    { id: "message-1", claimToken: "token-1" },
    { id: "message-2", claimToken: "token-2" },
  ]

  assert.deepEqual(
    turnClaims({ messageId: "message-1", claimToken: "token-1", batch }),
    batch,
  )
  assert.deepEqual(
    turnClaims({ messageId: "message-1", claimToken: "token-1" }),
    [{ id: "message-1", claimToken: "token-1" }],
    "a conversational turn still resolves its single claimed row",
  )
  assert.match(
    source,
    /for \(const claim of turnClaims\(turn\)\) \{[\s\S]*?store\.fail\(\{[\s\S]*?messageId: claim\.id,[\s\S]*?claimToken: claim\.claimToken,/,
  )
  assert.doesNotMatch(
    source,
    /store\.fail\(\{\s*messageId: turn\.messageId/,
    "failing only the turn's first row strands the rest of the batch until it expires",
  )
})

test("a routing turn that never reached the model fails its batch", () => {
  assert.match(
    source,
    /if \(Either\.isLeft\(sent\)\) await finishFailure\(routingTurn, "model_error"\)/,
  )
  assert.doesNotMatch(
    source,
    /finishRouting\(routingTurn, ""/,
    "an unsent turn has no routing decision to record",
  )
})

test("a roster read failure abandons the turn instead of routing on an empty roster", () => {
  assert.match(
    source,
    /const roster = await run\(store\.listAgents\(Date\.now\(\)\)\);\s*if \(Either\.isLeft\(roster\)\) \{[\s\S]*?safeError\(roster\.left\)[\s\S]*?finishFailure\(turn, "model_error"\)/,
  )
  assert.doesNotMatch(
    source,
    /Either\.isRight\(roster\)\s*\?[\s\S]*?:\s*\[\]/,
    "a store error is not an empty roster",
  )
})

test("a claim failure keeps its error on the status line instead of clearing it", () => {
  assert.match(
    source,
    /if \(Either\.isLeft\(claimed\)\) \{\s*drain = "claim_failed";/,
  )
  assert.match(
    source,
    /else if \(drain === "drained"\) ctx\.ui\.setStatus\(STATUS_KEY, undefined\)/,
  )
})

test("attachments are refused loudly rather than routed by their caption alone", () => {
  assert.match(attachmentRefusal(1), /^Not routed: /)
  assert.match(attachmentRefusal(1), /1 attachment\b/)
  assert.match(attachmentRefusal(3), /3 attachments\b/)
  assert.match(
    source,
    /const attachments = claimed\.right\.images;[\s\S]*?if \(attachments\.length > 0\) \{[\s\S]*?attachmentRefusal\(attachments\.length\)[\s\S]*?store\.complete\(\{/,
  )
})

test("owner pane input on the dispatch lane is enqueued instead of answered freehand", () => {
  assert.match(
    source,
    /pi\.on\("input", async \(event, ctx\) => \{[\s\S]*?event\.source !== "interactive"/,
  )
  assert.match(
    source,
    /pi\.on\("input"[\s\S]*?store\.enqueue\(\{[\s\S]*?requesterId: "owner-pane",[\s\S]*?ttlMs: BRIDGE_MESSAGE_TTL_MS,[\s\S]*?\}\),[\s\S]*?return \{ action: "handled" \}/,
  )
  assert.match(
    source,
    /pi\.on\("input"[\s\S]*?text\.startsWith\("\/"\)\)[\s\S]*?return \{ action: "continue" \}/,
  )
})

test("repeating yourself in the pane queues the work again", () => {
  const first = ownerPaneDedupeKey({
    sessionId: "session-a",
    sequence: 1,
    now: 1_000,
  })
  const second = ownerPaneDedupeKey({
    sessionId: "session-a",
    sequence: 2,
    now: 1_000,
  })

  assert.notEqual(
    first,
    second,
    "a dedupe key matched against completed rows silences the retyped message for an hour",
  )
  assert.match(
    first,
    /^[A-Za-z0-9._:-]+$/,
    "the bridge rejects a dedupe key outside the identifier charset",
  )
  assert.match(source, /sequence: paneSubmissions,/)
})

test("an unusable bridge rejects pane input rather than handing it to the local model", () => {
  assert.match(
    source,
    /Either\.isLeft\(enqueued\)[\s\S]*?ctx\.ui\.notify\([\s\S]*?return \{ action: "handled" \}/,
  )
  assert.doesNotMatch(
    source,
    /Either\.isLeft\(enqueued\)[\s\S]*?return \{ action: "continue" \}/,
    "passing the text through is exactly the freehand answer the lane exists to prevent",
  )
})

test("pane messages report their own outcome back onto the pane", () => {
  assert.match(source, /trackPaneMessage\(enqueued\.right\.id\)/)
  assert.match(
    source,
    /const reportPaneOutcome = \([\s\S]*?paneMessages\.delete\(messageId\)[\s\S]*?latestCtx\?\.ui\.notify/,
  )
  assert.match(
    source,
    /reportPaneOutcome\(message\.id, \{ outcome: "routed", response: completion \}\)/,
  )
  assert.match(
    source,
    /reportPaneOutcome\(claim\.id, \{ outcome: "dropped", reason: failure \}\)/,
  )
  assert.match(source, /paneMessages\.size >= MAX_TRACKED_PANE_MESSAGES/)
})

test("dispatcher notes reach receivers labelled as untrusted router output", () => {
  const bundle = routedBundle(
    {
      project: "/Users/example/yielduck",
      indexes: [1, 2],
      note: "check the\nfills",
    },
    ["first owner message", "second owner message"],
  )

  assert.equal(
    bundle,
    [
      routingHint("check the fills"),
      "first owner message",
      "second owner message",
    ].join("\n\n---\n\n"),
  )
  assert.match(bundle, /untrusted, not owner intent/)
  assert.doesNotMatch(
    bundle,
    /Dispatcher note: /,
    "model-authored text must not be delivered under system provenance",
  )
  assert.equal(
    routedBundle({ project: "/Users/example/yielduck", indexes: [1] }, [
      "first owner message",
    ]),
    "first owner message",
    "a bundle with no note carries the owner text verbatim",
  )
})

test("owner-relay frames reach Telegram before the bridge message completes", () => {
  assert.match(
    source,
    /const relay = parseOwnerRelay\(message\.text\);[\s\S]*?deliverOwnerRelay\(relay\)[\s\S]*?store\.complete\(\{/,
  )
  assert.match(
    source,
    /Either\.isLeft\(sent\)[\s\S]*?outcome: "undelivered",[\s\S]*?outcome: "delivered"/,
  )
  assert.match(
    source,
    /const response = ownerRelayCompletion\(relay, delivery\);/,
  )
  assert.doesNotMatch(source, /response: relay,/)
  assert.doesNotMatch(source, /Relayed to owner on Telegram/)
})
