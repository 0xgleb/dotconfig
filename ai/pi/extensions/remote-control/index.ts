import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Either } from "effect";
import { wasRunAborted } from "../shared/continuation-pause.ts";
import {
  QUESTION_REMOTE_RESOLUTION_EVENT,
  QUESTION_STATE_EVENT,
  type RemoteUserQuestionResolution,
  type UserQuestionStateSnapshot,
} from "../shared/question-events.ts";
import {
  REMOTE_CAPABILITY_HANDSHAKE_EVENT,
  REMOTE_CAPABILITY_MESSAGE,
  remoteCapabilityMessage,
  type RemoteCapabilityHandshake,
} from "../shared/remote-capability.ts";
import { registerRuntimeVersion } from "../shared/runtime-version.ts";
import { remoteBridgeDatabasePath } from "./paths.ts";
import { remoteKanbanResponse } from "./remote-commands.ts";
import {
  BRIDGE_AGENT_TTL_MS,
  RemoteBridgeError,
  finalAssistantText,
  normalizeLegacyRemoteImageContent,
  remoteTurnContent,
  type RemoteFailure,
  type RemoteMessage,
} from "./protocol.ts";
import { makeRemoteBridgeStore } from "./sqlite-store.ts";
import { enterRemoteToolGuard, type RemoteToolGuard } from "./tool-guard.ts";

const POLL_MS = 2_000;
const STATUS_KEY = "remote-control";

interface ActiveRemoteTurn {
  readonly messageId: string;
  readonly claimToken: string;
  readonly toolGuard: RemoteToolGuard;
}

const safeError = (error: RemoteBridgeError): string =>
  `${error.code}: ${error.message}`.slice(0, 160);

export default function remoteControl(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "remote-control", "2026.08.01.13");
  const store = makeRemoteBridgeStore(
    remoteBridgeDatabasePath(process.env.XDG_STATE_HOME, homedir()),
  );
  let timer: ReturnType<typeof setInterval> | undefined;
  let latestCtx: ExtensionContext | undefined;
  let syncing = false;
  let active: ActiveRemoteTurn | undefined;
  let questionState: UserQuestionStateSnapshot = { questions: [] };
  let questionsDirty = true;

  const run = <A>(
    operation: Effect.Effect<A, RemoteBridgeError>,
  ): Promise<Either.Either<A, RemoteBridgeError>> =>
    Effect.runPromise(Effect.either(operation));

  pi.events.on(QUESTION_STATE_EVENT, (snapshot: UserQuestionStateSnapshot) => {
    questionState = snapshot;
    questionsDirty = true;
  });

  const clearActive = (turn: ActiveRemoteTurn): void => {
    if (active !== turn) return;
    const handshake: RemoteCapabilityHandshake = turn.toolGuard.restore();
    active = undefined;
    pi.sendMessage({
      customType: REMOTE_CAPABILITY_MESSAGE,
      content: remoteCapabilityMessage(handshake),
      display: false,
    });
    pi.events.emit(REMOTE_CAPABILITY_HANDSHAKE_EVENT, handshake);
    latestCtx?.ui.setStatus(
      STATUS_KEY,
      handshake.status === "failed"
        ? "remote:error · local tool recovery failed"
        : undefined,
    );
  };

  const finishFailure = async (
    turn: ActiveRemoteTurn,
    failure: RemoteFailure,
  ): Promise<void> => {
    clearActive(turn);
    const result = await run(
      store.fail({
        messageId: turn.messageId,
        claimToken: turn.claimToken,
        failure,
        now: Date.now(),
      }),
    );
    if (Either.isLeft(result) && result.left.code !== "invalid_transition") {
      latestCtx?.ui.setStatus(
        STATUS_KEY,
        `remote:error · ${safeError(result.left)}`,
      );
    }
  };

  const finishSuccess = async (
    turn: ActiveRemoteTurn,
    response: string,
    ctx: ExtensionContext,
  ): Promise<void> => {
    clearActive(turn);
    const completed = await run(
      store.complete({
        messageId: turn.messageId,
        claimToken: turn.claimToken,
        response,
        now: Date.now(),
      }),
    );
    if (Either.isLeft(completed))
      ctx.ui.setStatus(
        STATUS_KEY,
        `remote:error · ${safeError(completed.left)}`,
      );
  };

  const beginTurn = async (
    message: Extract<RemoteMessage, { readonly status: "claimed" }>,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const turn: ActiveRemoteTurn = {
      messageId: message.id,
      claimToken: message.claimToken,
      toolGuard: enterRemoteToolGuard(pi),
    };
    active = turn;
    ctx.ui.setStatus(STATUS_KEY, "remote:chat · tools:off");
    const sent = await Effect.runPromise(
      Effect.either(
        Effect.try({
          try: () =>
            pi.sendUserMessage(
              remoteTurnContent(message.text, message.images),
              {
                deliverAs: "steer",
              },
            ),
          catch: () =>
            new RemoteBridgeError({
              code: "io",
              message: "could not start remote turn",
            }),
        }),
      ),
    );
    if (Either.isLeft(sent)) await finishFailure(turn, "model_error");
  };

  const sync = async (ctx: ExtensionContext): Promise<void> => {
    if (syncing) return;
    syncing = true;
    latestCtx = ctx;
    try {
      const now = Date.now();
      const heartbeat = await run(
        store.heartbeatAgent({
          id: ctx.sessionManager.getSessionId(),
          label: pi.getSessionName() ?? ctx.cwd.split("/").at(-1) ?? "Pi agent",
          cwd: ctx.cwd,
          accepting: active === undefined,
          now,
          ttlMs: BRIDGE_AGENT_TTL_MS,
        }),
      );
      if (Either.isLeft(heartbeat)) {
        ctx.ui.setStatus(
          STATUS_KEY,
          `remote:error · ${safeError(heartbeat.left)}`,
        );
        return;
      }

      if (questionsDirty) {
        const questionSync = await run(
          store.syncQuestions({
            agentId: ctx.sessionManager.getSessionId(),
            questions: questionState.questions,
            now,
          }),
        );
        if (Either.isLeft(questionSync)) {
          ctx.ui.setStatus(
            STATUS_KEY,
            `remote:error · ${safeError(questionSync.left)}`,
          );
          return;
        }
        questionsDirty = false;
      }

      const resolution = await run(
        store.takeQuestionResolution({
          agentId: ctx.sessionManager.getSessionId(),
          now,
        }),
      );
      if (Either.isLeft(resolution)) {
        ctx.ui.setStatus(
          STATUS_KEY,
          `remote:error · ${safeError(resolution.left)}`,
        );
        return;
      }
      if (resolution.right) {
        const answer: RemoteUserQuestionResolution = {
          id: resolution.right.questionId,
          answer: resolution.right.answer,
        };
        pi.events.emit(QUESTION_REMOTE_RESOLUTION_EVENT, answer);
      }

      if (active) return;
      const claimed = await run(
        store.claimNext({ agentId: ctx.sessionManager.getSessionId(), now }),
      );
      if (Either.isLeft(claimed)) {
        ctx.ui.setStatus(
          STATUS_KEY,
          `remote:error · ${safeError(claimed.left)}`,
        );
        return;
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
          );
          if (Either.isLeft(completed))
            ctx.ui.setStatus(
              STATUS_KEY,
              `remote:error · ${safeError(completed.left)}`,
            );
        } else {
          await beginTurn(claimed.right, ctx);
        }
      } else ctx.ui.setStatus(STATUS_KEY, undefined);
    } finally {
      syncing = false;
    }
  };

  pi.on("context", (event) => ({
    messages: normalizeLegacyRemoteImageContent(event.messages),
  }));

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    questionsDirty = true;
    if (timer) clearInterval(timer);
    timer = setInterval(() => void sync(ctx), POLL_MS);
    timer.unref();
    void sync(ctx);
  });

  pi.on("before_agent_start", () => {
    active?.toolGuard.enforce();
  });

  pi.on("turn_end", async (event, ctx) => {
    latestCtx = ctx;
    const turn = active;
    if (!turn) return;
    if (wasRunAborted([event.message])) {
      await finishFailure(turn, "aborted");
      return;
    }
    const response = finalAssistantText([event.message]);
    if (!response) return;
    await finishSuccess(turn, response, ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    latestCtx = ctx;
    const turn = active;
    if (!turn) return;
    if (wasRunAborted(event.messages)) {
      await finishFailure(turn, "aborted");
      return;
    }
    const response = finalAssistantText(event.messages);
    if (!response) return;
    await finishSuccess(turn, response, ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    latestCtx = ctx;
    const turn = active;
    if (turn) await finishFailure(turn, "model_error");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    latestCtx = ctx;
    const turn = active;
    if (turn) await finishFailure(turn, "session_ended");
    ctx.ui.setStatus(STATUS_KEY, undefined);
    latestCtx = undefined;
  });
}
