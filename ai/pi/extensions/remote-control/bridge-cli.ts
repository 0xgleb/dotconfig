#!/usr/bin/env node
import { homedir } from "node:os";
import { Effect, Either } from "effect";
import { remoteBridgeDatabasePath } from "./paths.ts";
import {
  BRIDGE_AGENT_TTL_MS,
  BRIDGE_MESSAGE_TTL_MS,
  MAX_REMOTE_MESSAGE_CHARACTERS,
  MAX_ROSTER_LABEL_CHARACTERS,
  RemoteBridgeError,
  type RemoteMessage,
  boundedBridgeText,
} from "./protocol.ts";
import { makeRemoteBridgeStore } from "./sqlite-store.ts";

const store = makeRemoteBridgeStore(remoteBridgeDatabasePath(process.env.XDG_STATE_HOME, homedir()));

const option = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const requiredOption = (args: readonly string[], name: string): Effect.Effect<string, RemoteBridgeError> => {
  const value = option(args, name)?.trim();
  return value
    ? Effect.succeed(value)
    : Effect.fail(new RemoteBridgeError({ code: "invalid_input", message: `${name} required` }));
};

const readStdin = (): Effect.Effect<string, RemoteBridgeError> =>
  Effect.async<string, RemoteBridgeError>((resume) => {
    let text = "";
    let settled = false;
    const finish = (result: Effect.Effect<string, RemoteBridgeError>): void => {
      if (settled) return;
      settled = true;
      resume(result);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
      if (text.length <= MAX_REMOTE_MESSAGE_CHARACTERS + 1) return;
      process.stdin.destroy();
      finish(
        Effect.fail(
          new RemoteBridgeError({
            code: "invalid_input",
            message: `stdin exceeds ${MAX_REMOTE_MESSAGE_CHARACTERS} characters`,
          }),
        ),
      );
    });
    process.stdin.on("end", () => finish(Effect.succeed(text)));
    process.stdin.on("error", () =>
      finish(Effect.fail(new RemoteBridgeError({ code: "io", message: "could not read stdin" }))),
    );
  });

const publicMessage = (message: RemoteMessage): Readonly<Record<string, unknown>> => ({
  id: message.id,
  targetAgentId: message.targetAgentId,
  status: message.status,
  createdAt: message.createdAt,
  expiresAt: message.expiresAt,
  ...(message.status === "completed" ? { response: message.response, completedAt: message.completedAt } : {}),
  ...(message.status === "failed" ? { failure: message.failure, completedAt: message.completedAt } : {}),
});

const command = (args: readonly string[]): Effect.Effect<unknown, RemoteBridgeError> => {
  const [action] = args;
  if (action === "agents") {
    return Effect.map(store.listAgents(Date.now()), (agents) =>
      agents.map(({ id, label, accepting, expiresAt }) => ({ id, label, accepting, expiresAt })),
    );
  }
  if (action === "send") {
    return Effect.gen(function* () {
      const targetAgentId = yield* requiredOption(args, "--agent");
      const dedupeKey = yield* requiredOption(args, "--dedupe");
      const requesterId = option(args, "--requester")?.trim() || "metagenda-telegram";
      const text = yield* readStdin();
      const message = yield* store.enqueue({
        targetAgentId,
        requesterId,
        dedupeKey,
        text,
        now: Date.now(),
        ttlMs: BRIDGE_MESSAGE_TTL_MS,
      });
      return publicMessage(message);
    });
  }
  // `ask_user` is a Pi tool, so until now only a native Pi session could put a
  // question in front of the owner. Every other lane - Claude Code, cursor -
  // had to guess or relay a report and hope, which is the opposite of what the
  // question cards are for. These two verbs are the missing entry point: `ask`
  // publishes into the same store the relay already drains, and `answer` is
  // how a lane with no push inbox collects the reply.
  if (action === "ask") {
    return Effect.gen(function* () {
      const agentId = yield* requiredOption(args, "--agent");
      const header = option(args, "--header")?.trim();
      const question = yield* readStdin();
      const options = (option(args, "--options") ?? "")
        .split("|")
        .map((label) => label.trim())
        .filter((label) => label.length > 0)
        .map((label) => ({ label }));
      // Telegram binds its card to (agent_id, question_id), so the id has to
      // be unique per agent and stable once relayed. Seconds since epoch is
      // both, and stays inside the integer the card round-trips.
      const questionId = Math.floor(Date.now() / 1_000);
      yield* store.syncQuestions({
        agentId,
        questions: [
          {
            id: questionId,
            status: "pending" as const,
            question: boundedBridgeText("question", question, MAX_REMOTE_MESSAGE_CHARACTERS),
            ...(header ? { header } : {}),
            ...(options.length > 0 ? { options } : {}),
          },
        ],
        now: Date.now(),
      });
      return { agentId, questionId, status: "pending" };
    });
  }
  if (action === "answer") {
    return Effect.gen(function* () {
      const agentId = yield* requiredOption(args, "--agent");
      const resolution = yield* store.takeQuestionResolution({
        agentId,
        now: Date.now(),
      });
      return resolution ?? { agentId, status: "pending" };
    });
  }
  if (action === "result") {
    return Effect.gen(function* () {
      const id = yield* requiredOption(args, "--id");
      return publicMessage(yield* store.get(id, Date.now()));
    });
  }
  if (action === "register") {
    return Effect.gen(function* () {
      const id = yield* requiredOption(args, "--agent-id");
      const label = yield* requiredOption(args, "--label");
      const cwd = yield* requiredOption(args, "--cwd");
      // Registration is where a bad roster field is cheap to refuse. The
      // prompt builder neutralizes what reaches it, but a caller that sends a
      // relative cwd or an unbounded label should learn so here rather than
      // silently appear on the roster in a mangled form.
      const boundedLabel = yield* Effect.try({
        try: () => boundedBridgeText("--label", label, MAX_ROSTER_LABEL_CHARACTERS),
        catch: (error) => error as RemoteBridgeError,
      });
      if (!cwd.startsWith("/")) {
        return yield* Effect.fail(
          new RemoteBridgeError({
            code: "invalid_input",
            message: "--cwd must be an absolute path",
          }),
        );
      }
      const accepting = option(args, "--accepting")?.trim();
      if (accepting !== undefined && accepting !== "true" && accepting !== "false") {
        return yield* Effect.fail(
          new RemoteBridgeError({
            code: "invalid_input",
            message: "--accepting must be true or false",
          }),
        );
      }
      const agent = yield* store.heartbeatAgent({
        id,
        label: boundedLabel,
        cwd,
        accepting: accepting !== "false",
        now: Date.now(),
        ttlMs: BRIDGE_AGENT_TTL_MS,
      });
      return {
        id: agent.id,
        label: agent.label,
        accepting: agent.accepting,
        expiresAt: agent.expiresAt,
      };
    });
  }
  if (action === "enable") return store.setEnabled(true);
  if (action === "disable") return store.setEnabled(false);
  if (action === "status") return store.isEnabled();
  return Effect.fail(
    new RemoteBridgeError({
      code: "invalid_input",
      message:
        "usage: pi-bridge agents | send --agent ID --dedupe KEY | result --id ID | register --agent-id ID --label LABEL --cwd PATH | ask --agent ID [--header TEXT] [--options 'A|B'] | answer --agent ID | enable | disable | status",
    }),
  );
};

const run = Effect.either(command(process.argv.slice(2))).pipe(
  Effect.tap((result) =>
    Effect.sync(() => {
      if (Either.isRight(result)) {
        process.stdout.write(`${JSON.stringify({ protocolVersion: 1, ok: true, result: result.right })}\n`);
        return;
      }
      process.stderr.write(
        `${JSON.stringify({
          protocolVersion: 1,
          ok: false,
          error: { code: result.left.code, message: result.left.message.slice(0, 160) },
        })}\n`,
      );
      process.exitCode = 1;
    }),
  ),
);

Effect.runPromise(run);
