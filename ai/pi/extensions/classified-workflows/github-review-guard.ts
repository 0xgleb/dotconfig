import path from "node:path";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Data, Effect, Either, Option, Schema } from "effect";
import type { Decision } from "./core.ts";

class ReviewPayloadReadError extends Data.TaggedError("ReviewPayloadReadError")<{
  readonly cause: unknown;
}> {}

const block = (reason: string): Decision => ({ verdict: "block", reason, source: "deterministic" });

const reviewMutationCommand = (command: string): boolean =>
  /(?:\bgh\s+pr\s+review\b|\/pulls\/[^\s'"?]+\/reviews(?:\b|\/)|(?:add|update|submit|delete)PullRequestReview)/i.test(
    command,
  );

const fieldValue = (command: string, name: string): string | undefined => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = command.match(
    new RegExp(`(?:^|\\s)(?:-f|--raw-field|-F|--field)\\s+${escaped}=(?:"([^"]*)"|'([^']*)'|([^\\s;&|]+))`),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

const inputPath = (command: string): string | undefined => {
  const match = command.match(/(?:^|\s)--input(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

const safePayloadPath = (candidate: string, cwd: string): string | undefined => {
  if (/[$`<>*?{}[\]\n\r]/.test(candidate)) return undefined;
  const resolved = path.resolve(cwd, candidate);
  const relative = path.relative(path.resolve(cwd), resolved);
  const insideCwd = relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
  const temporaryRoots = [path.resolve("/tmp"), path.resolve(tmpdir())];
  const insideTmp = temporaryRoots.some((root) => resolved.startsWith(`${root}${path.sep}`));
  if (!insideCwd && !insideTmp) return undefined;
  if (/(?:^|\/)(?:\.env|credentials|secrets|auth|\.npmrc|\.netrc)(?:[./]|$)|\.(?:key|pem|p12|pfx)$/i.test(resolved)) {
    return undefined;
  }
  return resolved;
};

const readJson = async (payloadPath: string): Promise<unknown | undefined> => {
  const result = await Effect.runPromise(
    Effect.either(
      Effect.tryPromise({
        try: () => readFile(payloadPath, "utf8"),
        catch: (cause) => new ReviewPayloadReadError({ cause }),
      }),
    ),
  );
  if (Either.isLeft(result)) return undefined;
  return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.parseJson())(result.right));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Enforce the user's standing PR-review publication boundary before bash runs.
 * Empty-body pending reviews remain subject to normal intent classification.
 */
export const githubReviewGuard = async (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string,
): Promise<Decision | null> => {
  if (toolName !== "bash" || typeof input.command !== "string") return null;
  const command = input.command;
  if (!reviewMutationCommand(command)) return null;

  if (/\bgh\s+pr\s+review\b/i.test(command) || /submitPullRequestReview/i.test(command)) {
    return block("PR review automation may not submit verdicts or publish top-level review bodies");
  }
  if (/\[agent:review-pr\]/i.test(command)) {
    return block("PR review automation may not publish a top-level marker or review body");
  }

  const body = fieldValue(command, "body");
  if (body !== undefined && body.length > 0) {
    return block("PR review automation requires an empty top-level review body");
  }

  const embeddedBody = command.match(/"body"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1];
  if (embeddedBody !== undefined && embeddedBody.length > 0) {
    return block("PR review automation requires an empty top-level review body");
  }

  const payloadOperand = inputPath(command);
  if (payloadOperand === undefined) return null;
  const payloadPath = safePayloadPath(payloadOperand, cwd);
  if (payloadPath === undefined) {
    if (embeddedBody === "" && !/"event"\s*:/.test(command)) return null;
    return block("PR review payload must be a readable literal project or temporary JSON path");
  }
  const payload = await readJson(payloadPath);
  if (!isRecord(payload)) return block("PR review payload could not be decoded before publication");
  if (typeof payload.body === "string" && payload.body.length > 0) {
    return block("PR review automation requires an empty top-level review body");
  }
  if (payload.event !== undefined) {
    return block("PR review automation may create only a pending review; omit the event field");
  }
  return null;
};
