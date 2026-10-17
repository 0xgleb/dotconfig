import { homedir } from "node:os"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Effect, Either } from "effect"
import { Type } from "typebox"
import {
  backlogRequirementsFromText,
  MESSAGE_BACKLOG_EVENT,
} from "../shared/backlog-events.ts"
import { wasRunAborted } from "../shared/continuation-pause.ts"
import { isLocalDispatchProvider } from "../shared/local-lane.ts"
import {
  REGISTRY_DELEGATE_REQUEST_EVENT,
  REGISTRY_OUTCOME_EVENT,
  REGISTRY_PROJECTS_REQUEST_EVENT,
  type RegistryDelegateOutcome,
  type RegistryDelegateRequest,
  type RegistryOutcomeRequest,
  type RegistryOutcomeResult,
  type RegistryProjectsRequest,
} from "../shared/registry-intent-events.ts"
import {
  QUESTION_REMOTE_RESOLUTION_EVENT,
  QUESTION_STATE_EVENT,
  type RemoteUserQuestionResolution,
  type UserQuestionStateSnapshot,
} from "../shared/question-events.ts"
import {
  REMOTE_CAPABILITY_HANDSHAKE_EVENT,
  REMOTE_CAPABILITY_MESSAGE,
  REMOTE_TASK_CONTINUATION_MESSAGE,
  remoteCapabilityMessage,
  type RemoteCapabilityHandshake,
} from "../shared/remote-capability.ts"
import {
  REGISTRY_IDENTITY_REQUEST_EVENT,
  type RegistryIdentityRequest,
  type RegistryRoleIdentity,
} from "../shared/registry-intent-events.ts"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"
import { HUMAN_TURN_EVENT } from "../shared/usage-governor-events.ts"
import { agentDisplayLabel } from "./agent-identity.ts"
import { bridgeQueueRoutableAgents } from "./agent-selection.ts"
import {
  deliverCabaCardRelay,
  deliverChatRelay,
  deliverOwnerRelay,
  deliverStakeholderUpdate,
  type OwnerRelayDeliveryError,
} from "./owner-telegram.ts"
import { remoteBridgeDatabasePath } from "./paths.ts"
import { remoteKanbanResponse } from "./remote-commands.ts"
import {
  canClaimRemoteTurn,
  settleTaskContinuation,
  type TaskContinuationPhase,
} from "./routing-gate.ts"
import {
  BRIDGE_AGENT_TTL_MS,
  BRIDGE_MESSAGE_TTL_MS,
  RemoteBridgeError,
  dispatchSystemPrompt,
  finalAssistantText,
  mechanicalDispatchCompaction,
  normalizeLegacyRemoteImageContent,
  chatRelayCompletion,
  malformedOwnerRelayCompletion,
  ownerRelayCompletion,
  parseChatRelay,
  parseOutcomeEnvelope,
  parseOwnerRelay,
  coversProject,
  remoteMessageSource,
  remoteSourceCarriesOwnerAuthority,
  parseRoutePlan,
  servesProject,
  routingBatchPrompt,
  remoteTurnContent,
  trimDispatchContext,
  type ChatRelayOutcome,
  type OutcomeEnvelope,
  type OwnerRelayDelivery,
  type RemoteFailure,
  type RemoteMessage,
  type RosterAgent,
} from "./protocol.ts"
import { makeRemoteBridgeStore } from "./sqlite-store.ts"
import { enterRemoteToolGuard, type RemoteToolGuard } from "./tool-guard.ts"

const POLL_MS = 2_000
const STATUS_KEY = "remote-control"
const DISPATCH_CONTEXT_BUDGET_CHARS = 100_000

interface ClaimedBridgeMessage {
  readonly id: string
  readonly claimToken: string
  readonly requesterId: string
  readonly text: string
}

interface ActiveRemoteTurn {
  readonly messageId: string
  readonly claimToken: string
  readonly toolGuard: RemoteToolGuard
  readonly lane: "conversational" | "routing"
  readonly text: string
  readonly source?: ReturnType<typeof remoteMessageSource>
  readonly batch?: readonly ClaimedBridgeMessage[]
  /**
   * Projects that can actually take work: live roster entries plus registry
   * projects whose receiver is merely between polls. Captured when the turn
   * opens so routing decides against the roster the model was shown.
   */
  readonly routable?: readonly string[]
}

const safeError = (error: RemoteBridgeError): string =>
  `${error.code}: ${error.message}`.slice(0, 160)

const safeDeliveryError = (error: OwnerRelayDeliveryError): string =>
  `${error.code}: ${error.message}`.slice(0, 160)

export default function remoteControl(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "remote-control", "2026.09.04.1")
  const store = makeRemoteBridgeStore(
    remoteBridgeDatabasePath(process.env.XDG_STATE_HOME, homedir()),
  )
  let timer: ReturnType<typeof setInterval> | undefined
  let latestCtx: ExtensionContext | undefined
  let syncing = false
  let active: ActiveRemoteTurn | undefined
  let taskContinuationPhase: TaskContinuationPhase = "idle"
  let taskContinuationId: string | undefined
  let questionState: UserQuestionStateSnapshot = { questions: [] }
  let questionsDirty = false

  const run = <A, E>(
    operation: Effect.Effect<A, E>,
  ): Promise<Either.Either<A, E>> => Effect.runPromise(Effect.either(operation))

  pi.registerTool({
    name: "deliver_caba_tracker",
    label: "Deliver CABA tracker",
    description:
      "Deliver the real interactive Boulder CABA tracker card directly to the owner's Telegram.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const delivery = await run(deliverCabaCardRelay())
      if (Either.isLeft(delivery)) {
        const reason = safeDeliveryError(delivery.left)
        return {
          content: [
            { type: "text", text: `CABA tracker was not delivered: ${reason}` },
          ],
          details: { outcome: "undelivered", reason },
          isError: true,
        }
      }
      return {
        content: [
          {
            type: "text",
            text: "Interactive CABA tracker delivered on Telegram.",
          },
        ],
        details: { outcome: "delivered" },
      }
    },
  })

  pi.registerTool({
    name: "report_owner",
    label: "Report to owner",
    description:
      "Deliver a bounded owner-facing report through the verified Piece of Pi Telegram transport and return typed delivery evidence.",
    promptSnippet: "Deliver a verified report to the owner on Telegram",
    promptGuidelines: [
      "Use report_owner for an explicitly requested owner report or a verified registry relay request.",
      "Keep reports concise, link identifiers, and never include credentials, prompts, raw logs, or full diffs.",
      "Treat only outcome=delivered as delivery evidence.",
    ],
    parameters: Type.Object(
      { text: Type.String({ minLength: 1, maxLength: 16_000 }) },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const delivery = await run(
        deliverOwnerRelay(params.text, bridgeAgentLabel(ctx)),
      )
      if (Either.isLeft(delivery)) {
        const reason = safeDeliveryError(delivery.left)
        return {
          content: [
            { type: "text", text: `Owner report was not delivered: ${reason}` },
          ],
          details: { outcome: "undelivered", reason },
          isError: true,
        }
      }
      return {
        content: [
          { type: "text", text: "Owner report delivered on Telegram." },
        ],
        details: { outcome: "delivered" },
      }
    },
  })

  pi.registerTool({
    name: "deliver_stakeholder_update",
    label: "Deliver stakeholder update",
    description:
      "Deliver exact stakeholder-forwardable content to the owner's Telegram without a visible agent banner, while retaining sender audit metadata privately.",
    promptSnippet:
      "Deliver exact verified stakeholder-forwardable content to the owner on Telegram",
    promptGuidelines: [
      "Use deliver_stakeholder_update only for final content explicitly prepared for the owner to forward unchanged to stakeholders, such as a verified EOD or team update.",
      "Use report_owner instead for agent status, findings, handoffs, questions, or anything addressed to the owner as the owner.",
      "Treat only outcome=delivered as stakeholder delivery evidence.",
    ],
    parameters: Type.Object(
      { text: Type.String({ minLength: 1, maxLength: 16_000 }) },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sender = bridgeAgentLabel(ctx)
      const deliveredAt = Date.now()
      const delivery = await run(deliverStakeholderUpdate(params.text))
      if (Either.isLeft(delivery)) {
        const reason = safeDeliveryError(delivery.left)
        pi.appendEntry("stakeholder-update-audit", {
          sender,
          deliveredAt,
          characters: params.text.length,
          outcome: "undelivered",
          reason,
        })
        return {
          content: [
            {
              type: "text",
              text: `Stakeholder update was not delivered: ${reason}`,
            },
          ],
          details: { outcome: "undelivered", reason },
          isError: true,
        }
      }
      pi.appendEntry("stakeholder-update-audit", {
        sender,
        deliveredAt,
        characters: params.text.length,
        outcome: "delivered",
      })
      return {
        content: [
          {
            type: "text",
            text: "Exact stakeholder update delivered on Telegram.",
          },
        ],
        details: { outcome: "delivered", mode: "stakeholder_update" },
      }
    },
  })

  pi.events.on(QUESTION_STATE_EVENT, (snapshot: UserQuestionStateSnapshot) => {
    questionState = snapshot
    questionsDirty = true
  })

  const clearActive = (turn: ActiveRemoteTurn): void => {
    if (active !== turn) return
    const handshake: RemoteCapabilityHandshake = turn.toolGuard.restore()
    active = undefined
    pi.sendMessage({
      customType: REMOTE_CAPABILITY_MESSAGE,
      content: remoteCapabilityMessage(handshake),
      display: false,
    })
    pi.events.emit(REMOTE_CAPABILITY_HANDSHAKE_EVENT, handshake)
    latestCtx?.ui.setStatus(
      STATUS_KEY,
      handshake.status === "failed"
        ? "remote:error · local tool recovery failed"
        : undefined,
    )
  }

  const finishFailure = async (
    turn: ActiveRemoteTurn,
    failure: RemoteFailure,
  ): Promise<void> => {
    taskContinuationPhase = "queued"
    taskContinuationId = undefined
    clearActive(turn)
    const result = await run(
      store.fail({
        messageId: turn.messageId,
        claimToken: turn.claimToken,
        failure,
        now: Date.now(),
      }),
    )
    if (Either.isLeft(result) && result.left.code !== "invalid_transition") {
      latestCtx?.ui.setStatus(
        STATUS_KEY,
        `remote:error · ${safeError(result.left)}`,
      )
    }
    taskContinuationPhase = "idle"
  }

  const finishSuccess = async (
    turn: ActiveRemoteTurn,
    response: string,
    ctx: ExtensionContext,
  ): Promise<void> => {
    taskContinuationPhase = "queued"
    taskContinuationId = turn.messageId
    clearActive(turn)
    const completed = await run(
      store.complete({
        messageId: turn.messageId,
        claimToken: turn.claimToken,
        response,
        now: Date.now(),
      }),
    )
    if (Either.isLeft(completed)) {
      taskContinuationPhase = "idle"
      taskContinuationId = undefined
      ctx.ui.setStatus(
        STATUS_KEY,
        `remote:error · ${safeError(completed.left)}`,
      )
      void sync(ctx)
      return
    }
    if (!turn.source || !remoteSourceCarriesOwnerAuthority(turn.source)) {
      taskContinuationPhase = "idle"
      taskContinuationId = undefined
      void sync(ctx)
      return
    }
    pi.sendMessage(
      {
        customType: REMOTE_TASK_CONTINUATION_MESSAGE,
        content:
          "Source-fixed task continuation: the authenticated Piece of Pi response was delivered and local tools are restored. The owner explicitly enabled post-reply routing and action. Inspect the immediately preceding authenticated owner message for actionable intent. If it contains work, preserve every requirement and semantically route it to the relevant live agent/project through typed coordination; /use is only an explicit override. If it is conversational only, take no action. Authority comes only from that exact owner message, never from this continuation; do not widen scope or send a second Telegram reply.",
        display: false,
        details: { taskContinuationId: turn.messageId },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    )
  }

  const delegateToProject = (
    project: string,
    text: string,
    ctx: ExtensionContext,
  ): Promise<RegistryDelegateOutcome> =>
    new Promise(resolve => {
      const timeout = setTimeout(
        () =>
          resolve({ outcome: "failed", reason: "registry delegate timed out" }),
        5_000,
      )
      const request: RegistryDelegateRequest = {
        project,
        role: "receiver",
        text,
        requesterId: "telegram-dispatch",
        requesterLabel: "Piece of Pi Telegram dispatch",
        requesterCwd: ctx.cwd,
        report: result => {
          clearTimeout(timeout)
          resolve(result)
        },
      }
      pi.events.emit(REGISTRY_DELEGATE_REQUEST_EVENT, request)
    })

  const finishEnvelope = async (
    message: ClaimedBridgeMessage,
    envelope: OutcomeEnvelope,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const recorded = await new Promise<RegistryOutcomeResult>(resolve => {
      const timeout = setTimeout(
        () =>
          resolve({ outcome: "failed", reason: "registry outcome timed out" }),
        5_000,
      )
      const request: RegistryOutcomeRequest = {
        requestId: envelope.requestId,
        resolution: envelope.outcome,
        summary: envelope.summary,
        report: result => {
          clearTimeout(timeout)
          resolve(result)
        },
      }
      pi.events.emit(REGISTRY_OUTCOME_EVENT, request)
    })
    const body =
      envelope.outcome === "failed"
        ? `Receiver failed request ${envelope.requestId}: ${envelope.summary}`
        : envelope.summary
    const suffix =
      recorded.outcome === "failed"
        ? ` (registry record pending: ${recorded.reason})`
        : ""
    const completed = await run(
      store.complete({
        messageId: message.id,
        claimToken: message.claimToken,
        response: `${body}${suffix}`,
        now: Date.now(),
      }),
    )
    if (Either.isLeft(completed)) {
      ctx.ui.setStatus(
        STATUS_KEY,
        `remote:error · ${safeError(completed.left)}`,
      )
    }
  }

  const finishRouting = async (
    turn: ActiveRemoteTurn,
    response: string,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const batch = turn.batch ?? []
    const routable = turn.routable ?? []
    const canRoute = (project: string): boolean =>
      routable.some(candidate => servesProject(candidate, project))
    const plan = parseRoutePlan(response, batch.length, routable)
    const routed = new Set(plan.flatMap(directive => [...directive.indexes]))
    const fallback = batch
      .map((_, position) => position + 1)
      .filter(index => !routed.has(index))
    // The dispatcher's own project is the catch-all only when it is itself
    // owned. Falling back to an unowned cwd is what silently swallowed owner
    // messages; leaving them unrouted at least reports that immediately.
    const directives = [
      ...plan,
      ...(fallback.length > 0 && canRoute(ctx.cwd)
        ? [{ project: ctx.cwd, indexes: fallback }]
        : []),
    ]
    const acks = new Map<number, string[]>()
    for (const directive of directives) {
      const bundle = [
        ...(directive.note ? [`Dispatcher note: ${directive.note}`] : []),
        ...directive.indexes.map(index => batch[index - 1]?.text ?? ""),
      ]
        .filter(part => part.length > 0)
        .join("\n\n---\n\n")
      const outcome = await delegateToProject(directive.project, bundle, ctx)
      const ack =
        outcome.outcome === "queued"
          ? `${directive.project} (request ${outcome.requestId})`
          : `${directive.project} FAILED: ${outcome.reason}`
      for (const index of directive.indexes) {
        acks.set(index, [...(acks.get(index) ?? []), ack])
      }
    }
    clearActive(turn)
    for (const [position, message] of batch.entries()) {
      const destinations = acks.get(position + 1) ?? [
        "nowhere - no live agent owns a project for this message",
      ]
      const completed = await run(
        store.complete({
          messageId: message.id,
          claimToken: message.claimToken,
          response: `Routed to ${destinations.join("; ")}.`,
          now: Date.now(),
        }),
      )
      if (Either.isLeft(completed)) {
        ctx.ui.setStatus(
          STATUS_KEY,
          `remote:error · ${safeError(completed.left)}`,
        )
      }
    }
  }

  const beginTurn = async (
    message: Extract<RemoteMessage, { readonly status: "claimed" }>,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const source = remoteMessageSource(message.requesterId)
    const turn: ActiveRemoteTurn = {
      messageId: message.id,
      claimToken: message.claimToken,
      toolGuard: enterRemoteToolGuard(pi),
      lane: "conversational",
      text: message.text,
      source,
    }
    active = turn
    ctx.ui.setStatus(STATUS_KEY, "remote:chat · tools:off")
    const contentResult = await Effect.runPromise(
      Effect.either(
        remoteTurnContent(
          message.text,
          message.images,
          "conversational",
          source,
        ),
      ),
    )
    if (Either.isLeft(contentResult)) {
      await finishFailure(turn, "model_error")
      return
    }
    const content = contentResult.right
    const prompt = content[0]
    const authenticatedOwner = remoteSourceCarriesOwnerAuthority(source)
    if (authenticatedOwner && prompt?.type === "text")
      pi.events.emit(HUMAN_TURN_EVENT, prompt.text)
    pi.events.emit(MESSAGE_BACKLOG_EVENT, {
      project: ctx.cwd,
      messageId: message.id,
      observedAt: message.createdAt,
      source: authenticatedOwner ? "owner-message" : "bridge-message",
      authority: authenticatedOwner ? "authenticated-owner" : "routing-only",
      requirements: backlogRequirementsFromText(message.text),
    })
    const sent = await Effect.runPromise(
      Effect.either(
        Effect.try({
          try: () =>
            pi.sendUserMessage(content, {
              deliverAs: "steer",
            }),
          catch: () =>
            new RemoteBridgeError({
              code: "io",
              message: "could not start remote turn",
            }),
        }),
      ),
    )
    if (Either.isLeft(sent)) await finishFailure(turn, "model_error")
  }

  /**
   * Registry leases expire in ninety seconds while receivers poll hours apart,
   * so the live-agent roster alone would hide every project between polls and
   * the batch would fall back to the dispatcher's own project. A timeout or an
   * unavailable registry reports nothing and the roster stays live-only.
   */
  const knownProjects = (): Promise<readonly string[]> =>
    new Promise(resolve => {
      const timeout = setTimeout(() => resolve([]), 3_000)
      const request: RegistryProjectsRequest = {
        report: projects => {
          clearTimeout(timeout)
          resolve(projects)
        },
      }
      pi.events.emit(REGISTRY_PROJECTS_REQUEST_EVENT, request)
    })

  const beginRoutingTurn = async (
    batch: readonly ClaimedBridgeMessage[],
    ctx: ExtensionContext,
  ): Promise<void> => {
    const first = batch[0]
    if (!first) return
    const turn: ActiveRemoteTurn = {
      messageId: first.id,
      claimToken: first.claimToken,
      toolGuard: enterRemoteToolGuard(pi),
      lane: "routing",
      text: first.text,
      batch,
    }
    active = turn
    ctx.ui.setStatus(
      STATUS_KEY,
      `remote:routing · ${batch.length} msg · tools:off`,
    )
    const roster = await Effect.runPromise(
      Effect.either(store.listAgents(Date.now())),
    )
    const live: readonly RosterAgent[] = Either.isRight(roster)
      ? bridgeQueueRoutableAgents(roster.right).map(({ id, label, cwd }) => ({
          id,
          label,
          cwd,
        }))
      : []
    const known = await knownProjects()
    const offline: readonly RosterAgent[] = known
      .filter(project => !live.some(({ cwd }) => coversProject(cwd, project)))
      .map(project => ({
        id: "queue",
        label: "receiver offline - queued for its next poll",
        cwd: project,
      }))
    const routingTurn: ActiveRemoteTurn = {
      ...turn,
      routable: [...live, ...offline].map(({ cwd }) => cwd),
    }
    active = routingTurn
    const promptResult = await Effect.runPromise(
      Effect.either(
        routingBatchPrompt(
          batch.map((message, position) => ({
            index: position + 1,
            text: message.text,
            source: remoteMessageSource(message.requesterId),
          })),
          [...live, ...offline],
        ),
      ),
    )
    if (Either.isLeft(promptResult)) {
      await finishFailure(routingTurn, "model_error")
      return
    }
    const prompt = promptResult.right
    const sent = await Effect.runPromise(
      Effect.either(
        Effect.try({
          try: () =>
            pi.sendUserMessage([{ type: "text", text: prompt }], {
              deliverAs: "steer",
            }),
          catch: () =>
            new RemoteBridgeError({
              code: "io",
              message: "could not start routing turn",
            }),
        }),
      ),
    )
    if (Either.isLeft(sent)) {
      await finishRouting(routingTurn, "", ctx)
    }
  }

  const bridgeAgentLabel = (ctx: ExtensionContext): string => {
    const roles: RegistryRoleIdentity[] = []
    const request: RegistryIdentityRequest = {
      agentId: ctx.sessionManager.getSessionId(),
      report: identity => roles.push(identity),
    }
    pi.events.emit(REGISTRY_IDENTITY_REQUEST_EVENT, request)
    return agentDisplayLabel(
      pi.getSessionName() ?? ctx.cwd.split("/").at(-1) ?? "Pi agent",
      roles,
    )
  }

  const chatRelayOutcome = async (
    name: string,
    body: string,
  ): Promise<ChatRelayOutcome> => {
    const sent = await run(deliverChatRelay(name, body))
    if (Either.isLeft(sent)) {
      return {
        outcome: "undelivered",
        chat: name,
        reason: safeDeliveryError(sent.left),
      }
    }
    return sent.right.outcome === "delivered"
      ? { outcome: "delivered", chat: sent.right.title }
      : { outcome: "unknown_chat", chat: name, known: sent.right.known }
  }

  const sync = async (ctx: ExtensionContext): Promise<void> => {
    if (syncing) return
    syncing = true
    latestCtx = ctx
    try {
      const now = Date.now()
      const heartbeat = await run(
        store.heartbeatAgent({
          id: ctx.sessionManager.getSessionId(),
          label: bridgeAgentLabel(ctx),
          cwd: ctx.cwd,
          accepting: active === undefined,
          workDelivery: "native-pi",
          now,
          ttlMs: BRIDGE_AGENT_TTL_MS,
        }),
      )
      if (Either.isLeft(heartbeat)) {
        ctx.ui.setStatus(
          STATUS_KEY,
          `remote:error · ${safeError(heartbeat.left)}`,
        )
        return
      }

      if (questionsDirty) {
        const questionSync = await run(
          store.syncQuestions({
            agentId: ctx.sessionManager.getSessionId(),
            questions: questionState.questions,
            now,
          }),
        )
        if (Either.isLeft(questionSync)) {
          ctx.ui.setStatus(
            STATUS_KEY,
            `remote:error · ${safeError(questionSync.left)}`,
          )
          return
        }
        questionsDirty = false
      }

      const resolution = await run(
        store.takeQuestionResolution({
          agentId: ctx.sessionManager.getSessionId(),
          now,
        }),
      )
      if (Either.isLeft(resolution)) {
        ctx.ui.setStatus(
          STATUS_KEY,
          `remote:error · ${safeError(resolution.left)}`,
        )
        return
      }
      if (resolution.right) {
        const answer: RemoteUserQuestionResolution = {
          id: resolution.right.questionId,
          answer: resolution.right.answer,
        }
        pi.events.emit(QUESTION_REMOTE_RESOLUTION_EVENT, answer)
      }

      if (!canClaimRemoteTurn(active !== undefined, taskContinuationPhase))
        return
      if (isLocalDispatchProvider(ctx.model?.provider)) {
        const routable: ClaimedBridgeMessage[] = []
        while (routable.length < 16) {
          const claimed = await run(
            store.claimNext({
              agentId: ctx.sessionManager.getSessionId(),
              now: Date.now(),
            }),
          )
          if (Either.isLeft(claimed)) {
            ctx.ui.setStatus(
              STATUS_KEY,
              `remote:error · ${safeError(claimed.left)}`,
            )
            break
          }
          if (claimed.right?.status !== "claimed") break
          const message: ClaimedBridgeMessage = {
            id: claimed.right.id,
            claimToken: claimed.right.claimToken,
            requesterId: claimed.right.requesterId,
            text: claimed.right.text,
          }
          const envelope = parseOutcomeEnvelope(message.text)
          if (envelope) {
            await finishEnvelope(message, envelope, ctx)
            continue
          }
          const relay = parseOwnerRelay(message.text)
          if (relay) {
            const response =
              relay.frame === "malformed-owner-relay"
                ? malformedOwnerRelayCompletion(relay.reason)
                : await run(
                    deliverOwnerRelay(relay.body, message.requesterId),
                  ).then(sent => {
                    const delivery: OwnerRelayDelivery = Either.isLeft(sent)
                      ? {
                          outcome: "undelivered",
                          reason: safeDeliveryError(sent.left),
                        }
                      : { outcome: "delivered" }
                    return ownerRelayCompletion(relay.body, delivery)
                  })
            const relayed = await run(
              store.complete({
                messageId: message.id,
                claimToken: message.claimToken,
                response,
                now: Date.now(),
              }),
            )
            if (Either.isLeft(relayed))
              ctx.ui.setStatus(
                STATUS_KEY,
                `remote:error · ${safeError(relayed.left)}`,
              )
            continue
          }
          const chatFrame = parseChatRelay(message.text)
          if (chatFrame) {
            const outcome: ChatRelayOutcome =
              chatFrame.frame === "chat-relay"
                ? await chatRelayOutcome(chatFrame.name, chatFrame.body)
                : { outcome: "malformed", reason: chatFrame.reason }
            const relayed = await run(
              store.complete({
                messageId: message.id,
                claimToken: message.claimToken,
                response: chatRelayCompletion(
                  chatFrame.frame === "chat-relay"
                    ? chatFrame.body
                    : message.text,
                  outcome,
                ),
                now: Date.now(),
              }),
            )
            if (Either.isLeft(relayed))
              ctx.ui.setStatus(
                STATUS_KEY,
                `remote:error · ${safeError(relayed.left)}`,
              )
            continue
          }
          if (message.text.trim() === "/kanban") {
            const completed = await run(
              store.complete({
                messageId: message.id,
                claimToken: message.claimToken,
                response: remoteKanbanResponse(ctx.sessionManager.getBranch()),
                now: Date.now(),
              }),
            )
            if (Either.isLeft(completed))
              ctx.ui.setStatus(
                STATUS_KEY,
                `remote:error · ${safeError(completed.left)}`,
              )
            continue
          }
          routable.push(message)
        }
        if (routable.length > 0) await beginRoutingTurn(routable, ctx)
        else ctx.ui.setStatus(STATUS_KEY, undefined)
        return
      }
      const claimed = await run(
        store.claimNext({ agentId: ctx.sessionManager.getSessionId(), now }),
      )
      if (Either.isLeft(claimed)) {
        ctx.ui.setStatus(
          STATUS_KEY,
          `remote:error · ${safeError(claimed.left)}`,
        )
        return
      }
      if (claimed.right?.status === "claimed") {
        if (claimed.right.text.trim() === "/kanban") {
          const completed = await run(
            store.complete({
              messageId: claimed.right.id,
              claimToken: claimed.right.claimToken,
              response: remoteKanbanResponse(ctx.sessionManager.getBranch()),
              now: Date.now(),
            }),
          )
          if (Either.isLeft(completed))
            ctx.ui.setStatus(
              STATUS_KEY,
              `remote:error · ${safeError(completed.left)}`,
            )
        } else {
          await beginTurn(claimed.right, ctx)
        }
      } else ctx.ui.setStatus(STATUS_KEY, undefined)
    } finally {
      syncing = false
    }
  }

  pi.on("context", (event, ctx) => {
    const messages = normalizeLegacyRemoteImageContent(event.messages)
    if (
      taskContinuationPhase === "queued" &&
      messages.some(
        message =>
          message.role === "custom" &&
          message.customType === REMOTE_TASK_CONTINUATION_MESSAGE &&
          message.details !== undefined &&
          typeof message.details === "object" &&
          "taskContinuationId" in message.details &&
          message.details.taskContinuationId === taskContinuationId,
      )
    )
      taskContinuationPhase = "running"
    if (isLocalDispatchProvider(ctx.model?.provider)) {
      const trimmed = trimDispatchContext(
        messages,
        DISPATCH_CONTEXT_BUDGET_CHARS,
      )
      return { messages: [...trimmed.messages] }
    }
    return { messages }
  })

  pi.on("session_before_compact", (event, ctx) => {
    if (!isLocalDispatchProvider(ctx.model?.provider)) return undefined
    return { compaction: mechanicalDispatchCompaction(event.preparation) }
  })

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx
    if (timer) clearInterval(timer)
    timer = setInterval(() => void sync(ctx), POLL_MS)
    timer.unref()
    void sync(ctx)
  })

  pi.on("before_agent_start", (_event, ctx) => {
    active?.toolGuard.enforce()
    if (isLocalDispatchProvider(ctx.model?.provider))
      return { systemPrompt: dispatchSystemPrompt(ctx.cwd) }
    return undefined
  })

  /**
   * Owner text typed into the pane joins the bridge queue so the dispatch lane
   * drains it mechanically instead of letting the local model answer freehand.
   * Only `interactive` input may be intercepted: this extension's own
   * `sendUserMessage` routing prompts surface as input events too, and
   * re-enqueuing those would loop.
   */
  pi.on("input", async (event, ctx) => {
    if (!isLocalDispatchProvider(ctx.model?.provider))
      return { action: "continue" }
    if (event.source !== "interactive") return { action: "continue" }
    const text = event.text.trim()
    if (text.length === 0 || text.startsWith("/")) return { action: "continue" }
    const enqueued = await run(
      store.enqueue({
        targetAgentId: ctx.sessionManager.getSessionId(),
        requesterId: "owner-pane",
        dedupeKey: `pane-${Date.now()}`,
        text,
        now: Date.now(),
        ttlMs: BRIDGE_MESSAGE_TTL_MS,
      }),
    )
    if (Either.isLeft(enqueued)) {
      ctx.ui.setStatus(STATUS_KEY, `remote:error · ${safeError(enqueued.left)}`)
      return { action: "continue" }
    }
    void sync(ctx)
    return { action: "handled" }
  })

  pi.on("turn_end", async (event, ctx) => {
    latestCtx = ctx
    const turn = active
    if (!turn) return
    if (wasRunAborted([event.message])) {
      await finishFailure(turn, "aborted")
      return
    }
    const response = finalAssistantText([event.message])
    if (!response) return
    if (turn.lane === "routing") {
      await finishRouting(turn, response, ctx)
      return
    }
    await finishSuccess(turn, response, ctx)
  })

  pi.on("agent_end", async (event, ctx) => {
    latestCtx = ctx
    const turn = active
    if (!turn) return
    if (wasRunAborted(event.messages)) {
      await finishFailure(turn, "aborted")
      return
    }
    const response = finalAssistantText(event.messages)
    if (!response) return
    if (turn.lane === "routing") {
      await finishRouting(turn, response, ctx)
      return
    }
    await finishSuccess(turn, response, ctx)
  })

  pi.on("agent_settled", async (_event, ctx) => {
    latestCtx = ctx
    const turn = active
    if (turn) {
      await finishFailure(turn, "model_error")
      return
    }
    const settledPhase = settleTaskContinuation(taskContinuationPhase)
    if (settledPhase === taskContinuationPhase) return
    taskContinuationPhase = settledPhase
    taskContinuationId = undefined
    void sync(ctx)
  })

  pi.on("session_shutdown", async (_event, ctx) => {
    if (timer) clearInterval(timer)
    timer = undefined
    latestCtx = ctx
    const turn = active
    if (turn) await finishFailure(turn, "session_ended")
    taskContinuationPhase = "idle"
    taskContinuationId = undefined
    ctx.ui.setStatus(STATUS_KEY, undefined)
    latestCtx = undefined
  })
}
