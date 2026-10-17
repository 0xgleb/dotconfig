/**
 * Shared model-tier resolution.
 *
 * Three tiers (top, mid, light) each expose one model per configured
 * provider, drawn only from each provider's latest series. Zai currently
 * publishes no mid-tier model in its latest series, so its mid tier reuses
 * the top-tier model. Resolution candidates order providers by the most
 * recently succeeded preference (cached for one hour, not probed per
 * request) and always end with the session's own model as the last resort
 * that is guaranteed to be available while the session runs.
 */

export type ModelTier = "top" | "mid" | "light"

export interface TierResolutionContext {
  /** Injectable clock so tests and callers control time. */
  readonly now: () => number
  /** Provider-qualified id of the model the calling session is running on. */
  readonly sessionModel?: string
}

const TIER_PREFERENCE_TTL_MS = 60 * 60 * 1000

/**
 * Latest-series models per provider and tier. Keep every entry on the
 * provider's current series only; legacy series must not appear here.
 */
const TIER_MODELS: Readonly<
  Record<string, Readonly<Record<ModelTier, string>>>
> = {
  "openai-codex": {
    top: "openai-codex/gpt-6.1-sol",
    mid: "openai-codex/gpt-6.1-sol",
    light: "openai-codex/gpt-6.1-sol",
  },
  "zai": {
    top: "zai/glm-5.3",
    // Zai's latest series has no mid-tier model; mid reuses top.
    mid: "zai/glm-5.3",
    light: "zai/glm-5.3-flash",
  },
}

export const MODEL_TIER_PROVIDERS: readonly string[] = Object.keys(TIER_MODELS)

let preferred:
  { readonly provider: string; readonly expiresAt: number } | undefined

const providerOf = (model: string): string => {
  const separator = model.indexOf("/")
  return separator === -1 ? model : model.slice(0, separator)
}

export const clearTierCaches = (): void => {
  preferred = undefined
}

export const preferredProvider = (now: () => number): string | undefined =>
  preferred && now() < preferred.expiresAt ? preferred.provider : undefined

/** Record that `model`'s provider just served a request successfully. */
export const markPreferredProvider = (
  model: string,
  now: () => number,
): void => {
  preferred = {
    provider: providerOf(model),
    expiresAt: now() + TIER_PREFERENCE_TTL_MS,
  }
}

export const tierModel = (
  tier: ModelTier,
  provider: string,
): string | undefined => TIER_MODELS[provider]?.[tier]

/**
 * Candidate models for a tier: the cached preferred provider's model first,
 * then every other configured provider, then the session model exactly once.
 */
export const tierCandidates = (
  tier: ModelTier,
  context: TierResolutionContext,
): string[] => {
  const cache = preferredProvider(context.now)
  const providers = [...MODEL_TIER_PROVIDERS].sort((left, right) => {
    if (left === cache) return -1
    if (right === cache) return 1
    return 0
  })
  const models = providers
    .map(provider => tierModel(tier, provider))
    .filter((model): model is string => model !== undefined)
  if (context.sessionModel && !models.includes(context.sessionModel)) {
    models.push(context.sessionModel)
  }
  return models
}
