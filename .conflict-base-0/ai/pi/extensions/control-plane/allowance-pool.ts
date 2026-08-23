export const ALLOWANCE_POOLS = [
  {
    provider: "openai",
    pool: "chatgpt-shared-weekly",
    label: "OpenAI weekly capacity",
  },
  {
    provider: "openai",
    pool: "codex-app-server-weekly",
    label: "OpenAI weekly capacity",
  },
  { provider: "anthropic", pool: "session", label: "Claude session" },
  {
    provider: "anthropic",
    pool: "all-models-weekly",
    label: "Claude all models",
  },
  { provider: "anthropic", pool: "fable-weekly", label: "Claude Fable" },
  { provider: "legacy", pool: "generic", label: "Legacy unscoped history" },
] as const

export type AllowanceProvider = (typeof ALLOWANCE_POOLS)[number]["provider"]
export type AllowancePool = (typeof ALLOWANCE_POOLS)[number]["pool"]
export type AllowanceSource =
  | "manual"
  | "estimated-history"
  | "codex-app-server"
  | "claude-statusline"
  | "legacy-import"

interface ProviderAllowanceCheckpointBase {
  readonly provider: AllowanceProvider
  readonly pool: AllowancePool
  readonly source: AllowanceSource
  readonly capturedAt: number
  readonly remainingPercent: number
}

export type ProviderAllowanceCheckpoint =
  | (ProviderAllowanceCheckpointBase & {
      readonly event: "refill"
    })
  | (ProviderAllowanceCheckpointBase & {
      readonly event?: undefined
      readonly resetAt: number
    })

export type AllowanceControlSelection = Pick<
  ProviderAllowanceCheckpoint,
  "provider" | "pool" | "source"
>

export const isAllowancePool = (
  provider: unknown,
  pool: unknown,
): provider is AllowanceProvider =>
  typeof provider === "string" &&
  typeof pool === "string" &&
  ALLOWANCE_POOLS.some(
    candidate => candidate.provider === provider && candidate.pool === pool,
  )

export const isAllowanceSource = (value: unknown): value is AllowanceSource =>
  value === "manual" ||
  value === "estimated-history" ||
  value === "codex-app-server" ||
  value === "claude-statusline" ||
  value === "legacy-import"

export const allowancePoolKey = (
  checkpoint: Pick<ProviderAllowanceCheckpoint, "provider" | "pool">,
): string => `${checkpoint.provider}:${checkpoint.pool}`

export const allowancePoolLabel = (
  checkpoint: Pick<ProviderAllowanceCheckpoint, "provider" | "pool">,
): string =>
  ALLOWANCE_POOLS.find(
    candidate =>
      candidate.provider === checkpoint.provider &&
      candidate.pool === checkpoint.pool,
  )?.label ?? "Unknown allowance pool"

export const governedAllowanceCheckpoints = (
  checkpoints: readonly ProviderAllowanceCheckpoint[],
): readonly ProviderAllowanceCheckpoint[] =>
  checkpoints.filter(
    ({ provider, pool }) =>
      provider === "openai" && pool === "chatgpt-shared-weekly",
  )

export const providerCallAllowanceCheckpoints = (
  checkpoints: readonly ProviderAllowanceCheckpoint[],
  provider: "openai",
): readonly ProviderAllowanceCheckpoint[] =>
  checkpoints.filter(
    checkpoint =>
      checkpoint.provider === provider &&
      checkpoint.pool === "codex-app-server-weekly" &&
      (checkpoint.source === "codex-app-server" ||
        checkpoint.source === "manual"),
  )

export const selectedAllowanceCheckpoints = (
  checkpoints: readonly ProviderAllowanceCheckpoint[],
  selection: AllowanceControlSelection,
): readonly ProviderAllowanceCheckpoint[] =>
  checkpoints.filter(
    checkpoint =>
      checkpoint.provider === selection.provider &&
      checkpoint.pool === selection.pool &&
      checkpoint.source === selection.source,
  )
