import type { TurnLane } from "./core.ts"

const MAX_PROVIDER_TOKENS = 2_000_000

export interface ProviderCallReservationPayload {
  readonly reservationId: string
  readonly agentId: string
  readonly cwd: string
  readonly role: string
  readonly provider: "openai"
  readonly requestedTokens: number
  readonly lane: TurnLane
  readonly ownerInteractionAt: number | null
}

export const providerCallReservationPayload = (
  input: Omit<
    ProviderCallReservationPayload,
    "provider" | "ownerInteractionAt"
  > & {
    readonly ownerInteractionAt: number | undefined
  },
): ProviderCallReservationPayload => ({
  ...input,
  provider: "openai",
  ownerInteractionAt: input.ownerInteractionAt ?? null,
})

export interface PendingProviderCall {
  readonly reservationId: string
  readonly actualTokens?: number
}

export interface SettledProviderCall extends PendingProviderCall {
  readonly actualTokens: number
}

export type ProviderCallAction =
  | { readonly action: "skip" }
  | { readonly action: "reserve" }
  | { readonly action: "block-unresolved" }
  | {
      readonly action: "retry-settlement"
      readonly reservationId: string
      readonly actualTokens: number
    }

export const isOpenAiProvider = (provider: string): boolean =>
  provider === "openai" || provider.startsWith("openai-")

export const providerCallAction = (
  pending: PendingProviderCall | undefined,
  lane: TurnLane,
  provider: string,
): ProviderCallAction => {
  if (!isOpenAiProvider(provider)) return { action: "skip" }
  if (!pending) return { action: "reserve" }
  if (pending.actualTokens === undefined) return { action: "block-unresolved" }
  return {
    action: "retry-settlement",
    reservationId: pending.reservationId,
    actualTokens: pending.actualTokens,
  }
}

export const providerCallSettlement = (
  pending: PendingProviderCall,
  usage: {
    readonly provider: string
    readonly totalTokens: number
  },
): SettledProviderCall | undefined =>
  isOpenAiProvider(usage.provider) &&
  Number.isSafeInteger(usage.totalTokens) &&
  usage.totalTokens >= 0 &&
  usage.totalTokens <= MAX_PROVIDER_TOKENS
    ? {
        reservationId: pending.reservationId,
        actualTokens: usage.totalTokens,
      }
    : undefined
