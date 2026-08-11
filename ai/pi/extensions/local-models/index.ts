import { Effect, Either } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  OLLAMA_ORIGIN,
  parseServedContext,
  runningModels,
  servedContextVerdict,
  type ContextProbeStage,
  type ServedContext,
} from "./core.ts";
import {
  LOCAL_DISPATCH_MODEL,
  LOCAL_DISPATCH_PROVIDER,
} from "../shared/local-lane.ts";

const STATUS_KEY = "local-models";

const DECLARED_MODELS = [
  {
    id: LOCAL_DISPATCH_MODEL,
    name: "Qwen3.5 9B (local router)",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 40960,
    maxTokens: 4096,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  },
  {
    id: "qwen3:4b",
    name: "Qwen3 4B (local router)",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 40960,
    maxTokens: 4096,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  },
  {
    id: "qwen3:32b",
    name: "Qwen3 32B (local)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 24576,
    maxTokens: 512,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  },
] as const;

/**
 * Registers the local Ollama provider so its models appear in the selector
 * immediately (models.json is Home Manager generated and only updates on a
 * rebuild; this extension keeps the local lane usable without one). The
 * server itself is started on demand by `fj clanker --dispatcher`.
 *
 * A declared context window is a claim about a server this extension does not
 * start and cannot configure: the OpenAI-compatible endpoint takes no
 * context-length parameter, so a server someone else launched keeps whatever
 * window it was given and truncates longer prompts server-side without an
 * error. Sessions running on this provider therefore check the declared window
 * against what the server reports it is serving, and say so loudly when it is
 * short, instead of letting the router answer about a prompt whose head it
 * never saw.
 */
const localModels: (pi: ExtensionAPI) => void = (pi) => {
  pi.registerProvider("ollama", {
    name: "Ollama (local)",
    baseUrl: `${OLLAMA_ORIGIN}/v1`,
    apiKey: "ollama",
    api: "openai-completions",
    models: DECLARED_MODELS.map((model) => ({ ...model, input: [...model.input] })),
  });

  let reported = false;

  const verifyServedContext = async (
    ctx: ExtensionContext,
    stage: ContextProbeStage,
  ): Promise<void> => {
    const model = ctx.model;
    if (reported || model?.provider !== LOCAL_DISPATCH_PROVIDER) return;
    const declared = declaredContextWindow(model.id);
    if (declared === undefined) return;
    const probed = await Effect.runPromise(
      Effect.either(runningModels(OLLAMA_ORIGIN)),
    );
    const served: ServedContext = Either.isRight(probed)
      ? parseServedContext(model.id, probed.right)
      : { served: "unreadable", detail: probed.left.message };
    const verdict = servedContextVerdict({
      modelId: model.id,
      declared,
      stage,
      served,
    });
    if (verdict.verdict === "retry") return;
    reported = true;
    if (verdict.verdict === "sufficient") return;
    ctx.ui.setStatus(
      STATUS_KEY,
      verdict.verdict === "short"
        ? "ollama:context-short"
        : "ollama:context-unverified",
    );
    ctx.ui.notify(
      verdict.notice,
      verdict.verdict === "short" ? "error" : "warning",
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    reported = false;
    await verifyServedContext(ctx, "session-start");
  });

  pi.on("agent_end", async (_event, ctx) => {
    await verifyServedContext(ctx, "after-turn");
  });

  pi.on("model_select", () => {
    reported = false;
  });
};

/**
 * The context window this registration offers Pi for a model, if it declares
 * that model at all. An undeclared model has no claim to check, so the served
 * window is not probed for it: the tag the launcher pins must stay among the
 * declared ones or the check silently covers nothing, which is what
 * `core.test.ts` pins against `nushell/fj/routing.nu`.
 */
export const declaredContextWindow = (modelId: string): number | undefined =>
  DECLARED_MODELS.find((model) => model.id === modelId)?.contextWindow;

export default localModels;
