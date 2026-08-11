/**
 * The name of the environment variable the launcher exports to declare that a
 * session is the fleet's local dispatch lane.
 */
export const DISPATCH_LANE_ENVIRONMENT = "PI_DISPATCH_LANE";

/**
 * The only value that declares the local dispatch lane. Any other value, and
 * an unset variable, mean an ordinary session.
 */
export const LOCAL_DISPATCH_LANE = "local";

/**
 * The provider the declared lane is expected to run on. This is a sanity
 * signal, never the definition of the lane.
 */
export const LOCAL_DISPATCH_PROVIDER = "ollama";

/**
 * The model tag the launcher pins the dispatch lane to.
 *
 * `nushell/fj/routing.nu` owns the launcher's side of this pair: it builds
 * `--model ollama/<tag>` and asserts the tag is pulled before a turn is routed
 * through it. The provider registration has to offer the same tag under the
 * same name, or the session runs on a model the registration never described
 * and the served-context check has nothing to compare against.
 * `local-models/core.test.ts` pins the two declarations to each other.
 */
export const LOCAL_DISPATCH_MODEL = "qwen3.5:9b";

export type DispatchLane =
  | { readonly lane: "standard" }
  | {
      readonly lane: "local-dispatch";
      readonly declaration: "consistent" | "unexpected-provider";
    };

/**
 * The dispatch lane is a deployment role, not a model choice. Exactly one
 * pinned session is launched as the fleet's router, and that single fact gates
 * blocking every tool, replacing the whole system prompt, diverting typed pane
 * input into the bridge queue, trimming context, stubbing compaction, and
 * declining the project's registry role. The launcher is what knows the role,
 * so the launcher declares it: `fj clanker --dispatcher` exports
 * `PI_DISPATCH_LANE=local` for the session it pins, and nothing here infers the
 * role from the model that session happens to be running.
 *
 * Inferring the lane from the provider made any session that picked a local
 * model - an offline pass, the 32B local model in the selector, a mid-session
 * model switch - silently become a dispatcher: tools blocked, prompt replaced,
 * owner input swallowed into the bridge, and its project's queue left with no
 * drainer.
 *
 * The provider is checked only in the direction that cannot weaken
 * containment. A declared lane stays the dispatch lane whatever model it runs,
 * so switching a declared session to a paid model cannot unlock the tools the
 * lane is fenced away from; a provider that does not match the expectation is
 * reported as a mismatched declaration for the caller to surface.
 */
export const dispatchLane = (
  provider: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DispatchLane =>
  environment[DISPATCH_LANE_ENVIRONMENT]?.trim() === LOCAL_DISPATCH_LANE
    ? {
        lane: "local-dispatch",
        declaration:
          provider === LOCAL_DISPATCH_PROVIDER
            ? "consistent"
            : "unexpected-provider",
      }
    : { lane: "standard" };

/**
 * Whether this session runs on the local dispatch lane. Extensions use it to
 * swap semantic classification for deterministic policy and to steer remote
 * turns toward routing instead of answering.
 */
export const isLocalDispatchProvider = (provider: string | undefined): boolean =>
  dispatchLane(provider).lane === "local-dispatch";
