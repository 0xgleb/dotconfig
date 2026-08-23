export type ThrottleDecisionKind = "turn" | "workflow" | "provider-call"
export type ThrottleDecisionOutcome =
  | "admitted"
  | "deferred"
  | "scaled"
  | "settled"
  | "blocked"

export interface ThrottleDecision {
  readonly at: number
  readonly kind: ThrottleDecisionKind
  readonly outcome: ThrottleDecisionOutcome
  readonly role: string
  readonly requestedTokens?: number
  readonly grantedTokens?: number
  readonly retryAt?: number
}

export interface ThrottleActivitySnapshot {
  readonly windowMs: number
  readonly inFlightCalls: number
  readonly reservedTokens: number
  readonly ownerInteractionAt?: number
  readonly counts: Readonly<Record<ThrottleDecisionOutcome, number>>
  readonly pausedRoles: readonly {
    readonly role: string
    readonly retryAt: number
  }[]
  readonly latest?: ThrottleDecision
}

const WINDOW_MS = 15 * 60_000
const MAX_EVENTS = 128

const validTimestamp = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0

const validTokens = (value: number | undefined): boolean =>
  value === undefined || (Number.isSafeInteger(value) && value >= 0)

export class ThrottleActivity {
  private readonly events: ThrottleDecision[] = []
  private readonly active = new Map<
    string,
    { readonly role: string; readonly tokens: number }
  >()
  private latestOwnerInteractionAt: number | undefined

  ownerInteracted(at: number, now: number): void {
    if (!validTimestamp(at) || !validTimestamp(now) || at > now) return
    if (
      this.latestOwnerInteractionAt === undefined ||
      at > this.latestOwnerInteractionAt
    )
      this.latestOwnerInteractionAt = at
  }

  record(decision: ThrottleDecision): void {
    if (
      !validTimestamp(decision.at) ||
      !decision.role ||
      !validTokens(decision.requestedTokens) ||
      !validTokens(decision.grantedTokens) ||
      (decision.retryAt !== undefined &&
        (!validTimestamp(decision.retryAt) || decision.retryAt < decision.at))
    )
      return
    this.events.push(decision)
    if (this.events.length > MAX_EVENTS)
      this.events.splice(0, this.events.length - MAX_EVENTS)
  }

  providerReserved(
    reservationId: string,
    role: string,
    tokens: number,
    at: number,
  ): void {
    if (!reservationId || !role || !validTokens(tokens) || tokens < 1) return
    this.active.set(reservationId, { role, tokens })
    this.record({
      at,
      kind: "provider-call",
      outcome: "admitted",
      role,
      requestedTokens: tokens,
      grantedTokens: tokens,
    })
  }

  providerSettled(reservationId: string, at: number): void {
    const active = this.active.get(reservationId)
    if (!active) return
    this.active.delete(reservationId)
    this.record({
      at,
      kind: "provider-call",
      outcome: "settled",
      role: active.role,
      grantedTokens: active.tokens,
    })
  }

  snapshot(now: number): ThrottleActivitySnapshot {
    const since = Math.max(0, now - WINDOW_MS)
    const recent = this.events.filter(
      event => event.at >= since && event.at <= now,
    )
    const counts: Record<ThrottleDecisionOutcome, number> = {
      admitted: 0,
      deferred: 0,
      scaled: 0,
      settled: 0,
      blocked: 0,
    }
    for (const event of recent) counts[event.outcome] += 1

    const paused = new Map<string, number>()
    for (const event of recent) {
      if (
        event.outcome === "deferred" &&
        event.retryAt !== undefined &&
        event.retryAt > now
      )
        paused.set(event.role, event.retryAt)
      else paused.delete(event.role)
    }
    const latest = recent.at(-1)

    return {
      windowMs: WINDOW_MS,
      inFlightCalls: this.active.size,
      reservedTokens: [...this.active.values()].reduce(
        (total, call) => total + call.tokens,
        0,
      ),
      ...(this.latestOwnerInteractionAt === undefined
        ? {}
        : { ownerInteractionAt: this.latestOwnerInteractionAt }),
      counts,
      pausedRoles: [...paused.entries()]
        .map(([role, retryAt]) => ({ role, retryAt }))
        .sort((left, right) => left.retryAt - right.retryAt),
      ...(latest === undefined ? {} : { latest }),
    }
  }
}
