import { Data, Effect } from "effect";

/**
 * The local Ollama server's origin.
 *
 * The launcher's readiness probe waits on the IPv4 loopback literal, and
 * Ollama's default binding answers only there. The provider registration and
 * this verification use the same literal so the address Pi talks to is the one
 * that was proven ready: a dual-stack host can resolve `localhost` to `::1`
 * first, where nothing is listening.
 */
export const OLLAMA_ORIGIN = "http://127.0.0.1:11434";

const PROBE_TIMEOUT_MS = 2_000;

export class OllamaProbeError extends Data.TaggedError("OllamaProbeError")<{
  readonly message: string;
}> {}

/** What the running server reports about one model's context window. */
export type ServedContext =
  | { readonly served: "unreadable"; readonly detail: string }
  | { readonly served: "absent" }
  | { readonly served: "unreported" }
  | { readonly served: "tokens"; readonly tokens: number };

/**
 * When the verification runs. A model is loaded on demand, so nothing is
 * expected to be running when a session opens; after a turn has completed on
 * this provider the model has been served, and an answer that still names no
 * context window is a real gap rather than a cold start.
 */
export type ContextProbeStage = "session-start" | "after-turn";

export type ContextVerdict =
  | { readonly verdict: "sufficient" }
  | { readonly verdict: "retry" }
  | { readonly verdict: "short"; readonly notice: string }
  | { readonly verdict: "unverified"; readonly notice: string };

/**
 * Asks the native API which models are loaded and with what context window.
 *
 * The OpenAI-compatible endpoint Pi streams through carries no context-length
 * parameter: the server fixes the window when it loads a runner, from
 * `OLLAMA_CONTEXT_LENGTH` or the model's own parameters, and truncates anything
 * longer with no HTTP error and nothing in the response. The window declared to
 * Pi is therefore a claim about a process this extension does not own, and the
 * running-model report is the only place that claim can be checked.
 */
export const runningModels = (
  origin: string,
): Effect.Effect<unknown, OllamaProbeError> =>
  Effect.tryPromise({
    try: () =>
      fetch(`${origin}/api/ps`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }),
    catch: () =>
      new OllamaProbeError({
        message: "the local Ollama server did not answer",
      }),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.tryPromise({
            try: () => response.json() as Promise<unknown>,
            catch: () =>
              new OllamaProbeError({
                message: "the running-model report was not readable JSON",
              }),
          })
        : Effect.fail(
            new OllamaProbeError({
              message: `the running-model report returned status ${response.status}`,
            }),
          ),
    ),
  );

/**
 * Narrows the running-model report to what one model is served with. Only a
 * context length the server itself names is believed; an entry without one
 * leaves the window unreported rather than assumed, because assuming it is
 * exactly the silent truncation this check exists to catch.
 */
export const parseServedContext = (
  modelId: string,
  payload: unknown,
): ServedContext => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("models" in payload) ||
    !Array.isArray(payload.models)
  ) {
    return {
      served: "unreadable",
      detail: "the running-model report named no models",
    };
  }
  const entry = payload.models.find(
    (candidate) => runningModelId(candidate) === modelId,
  );
  if (entry === undefined) return { served: "absent" };
  const tokens = servedTokens(entry);
  return tokens === undefined
    ? { served: "unreported" }
    : { served: "tokens", tokens };
};

/**
 * Decides what to say about a declared context window once the server has been
 * asked. A served window shorter than the declared one is reported with the
 * remedy, since the symptom on its own - a router answering about a batch whose
 * head it never saw - reads as a model that routed badly.
 */
export const servedContextVerdict = (input: {
  readonly modelId: string;
  readonly declared: number;
  readonly stage: ContextProbeStage;
  readonly served: ServedContext;
}): ContextVerdict => {
  if (input.served.served === "tokens") {
    return input.served.tokens >= input.declared
      ? { verdict: "sufficient" }
      : {
          verdict: "short",
          notice: `${input.modelId} is served with a ${input.served.tokens} token context window but is offered to Pi as ${input.declared}. Anything longer is truncated by the server without an error. Stop the running Ollama server and let \`fj clanker --dispatcher\` start one, or export OLLAMA_CONTEXT_LENGTH=${input.declared} before \`ollama serve\`.`,
        };
  }
  return input.stage === "session-start"
    ? { verdict: "retry" }
    : {
        verdict: "unverified",
        notice: `${input.modelId} is offered to Pi as ${input.declared} tokens of context, and the running Ollama server did not confirm it: ${unverifiedDetail(input.served)}. That is not evidence the served window is short, only that it could not be read, and a prompt past whatever the server does serve is truncated without an error. ${unverifiedRemedy(input.served, input.declared)}`,
      };
};

const unverifiedDetail = (served: ServedContext): string => {
  if (served.served === "unreadable") return served.detail;
  return served.served === "absent"
    ? "the model is not among the running models"
    : "the running-model report named no context window";
};

/**
 * What to do about a window that could not be read. The running-model report is
 * the only place a live server names its window, and a server that does not
 * name one leaves nothing to check: the remedy is then to set the window rather
 * than to read it back.
 */
const unverifiedRemedy = (served: ServedContext, declared: number): string => {
  if (served.served === "unreadable") {
    return "Check that the server answering the local Ollama port is the one `fj clanker --dispatcher` starts.";
  }
  if (served.served === "absent") {
    return "The model was not loaded when the report was read; a turn that ran on another model explains it.";
  }
  return `Not every Ollama build names a context length for a running model, so this session cannot confirm one. Start the server through \`fj clanker --dispatcher\`, or export OLLAMA_CONTEXT_LENGTH=${declared} before \`ollama serve\`, so the window is set rather than read back.`;
};

const runningModelId = (candidate: unknown): string | undefined => {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const record = candidate as Readonly<Record<string, unknown>>;
  const model = record.model ?? record.name;
  return typeof model === "string" ? model : undefined;
};

/**
 * The context length a running-model entry names, when it names one.
 *
 * The field is read opportunistically: no Ollama version is assumed to report
 * it, and an entry without it is left unreported rather than treated as
 * confirmation. The check can therefore only ever tighten - it turns a window
 * the server itself named into a verdict - and never loosens into assuming the
 * declared window is what is being served.
 */
const servedTokens = (candidate: unknown): number | undefined => {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const tokens = (candidate as Readonly<Record<string, unknown>>).context_length;
  return typeof tokens === "number" &&
    Number.isSafeInteger(tokens) &&
    tokens > 0
    ? tokens
    : undefined;
};
