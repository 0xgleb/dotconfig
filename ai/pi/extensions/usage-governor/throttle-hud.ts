import type { Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

import { framedChromeInset } from "../shared/chrome.ts"
import type { UsagePace } from "./core.ts"

const ROLE_NAMES = [
  "general",
  "reviewer",
  "yielduck-operator",
  "moneymentum-operator",
] as const

type ThrottleRole = (typeof ROLE_NAMES)[number]

interface ThrottlePolicy {
  readonly pace: UsagePace
  readonly minimumIntervalMs: number
  readonly throttleRatio: number
  readonly actualRemainingPercent?: number
  readonly targetRemainingPercent?: number
  readonly resetAt?: number
  readonly observedBurnPercentPerHour?: number
  readonly permittedBurnPercentPerHour?: number
  readonly estimatedExhaustionAt?: number
}

interface ThrottleRolePolicy {
  readonly role: ThrottleRole
  readonly baseIntervalMs: number
  readonly weight: number
  readonly effectiveIntervalMs: number
  readonly tokenScale: number
}

interface ThrottleDecision {
  readonly at: number
  readonly kind: "turn" | "workflow" | "provider-call"
  readonly outcome: "admitted" | "deferred" | "scaled" | "settled" | "blocked"
  readonly role: string
  readonly requestedTokens?: number
  readonly grantedTokens?: number
  readonly retryAt?: number
}

interface ThrottleActivity {
  readonly windowMs: number
  readonly inFlightCalls: number
  readonly reservedTokens: number
  readonly counts: Readonly<
    Record<"admitted" | "deferred" | "scaled" | "settled" | "blocked", number>
  >
  readonly pausedRoles: readonly {
    readonly role: string
    readonly retryAt: number
  }[]
  readonly latest?: ThrottleDecision
}

export interface ThrottleControl {
  readonly computedAt: number
  readonly provider: "openai"
  readonly pool: "codex-app-server-weekly" | "chatgpt-shared-weekly"
  readonly source: "codex-app-server" | "manual" | "unavailable"
  readonly profile: {
    readonly kind: "flat-until-reset"
    readonly participants: number
  }
  readonly policy: ThrottlePolicy
  readonly allocation?: {
    readonly configuredWeight: number
    readonly recencyFactor: number
    readonly effectiveWeight: number
  }
  readonly calibration?: {
    readonly observedBurnPercent: number
    readonly observedTokens: number
    readonly tokensPerPercent: number
  }
  readonly providerBudget?: {
    readonly capacityTokens: number
    readonly permittedTokensPerHour: number
    readonly windowMs: number
  }
  readonly roles: readonly ThrottleRolePolicy[]
  readonly activity: ThrottleActivity
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const finite = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum

const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum

const optionalFinite = (
  value: unknown,
  minimum = 0,
  maximum = Number.POSITIVE_INFINITY,
): value is number | undefined =>
  value === undefined || (finite(value, minimum) && value <= maximum)

const optionalInteger = (value: unknown): value is number | undefined =>
  value === undefined || integer(value)

const isPace = (value: unknown): value is UsagePace =>
  value === "unverified" ||
  value === "open" ||
  value === "guarded" ||
  value === "critical" ||
  value === "reserve"

const decodeRole = (value: unknown): ThrottleRolePolicy | undefined => {
  if (
    !isRecord(value) ||
    !ROLE_NAMES.includes(value.role as ThrottleRole) ||
    !integer(value.baseIntervalMs, 1) ||
    !finite(value.weight) ||
    !integer(value.effectiveIntervalMs, 1) ||
    !finite(value.tokenScale) ||
    value.tokenScale > 1
  )
    return undefined
  return value as unknown as ThrottleRolePolicy
}

const decodeDecision = (value: unknown): ThrottleDecision | undefined => {
  if (
    !isRecord(value) ||
    !integer(value.at) ||
    (value.kind !== "turn" &&
      value.kind !== "workflow" &&
      value.kind !== "provider-call") ||
    (value.outcome !== "admitted" &&
      value.outcome !== "deferred" &&
      value.outcome !== "scaled" &&
      value.outcome !== "settled" &&
      value.outcome !== "blocked") ||
    typeof value.role !== "string" ||
    value.role.length < 1 ||
    value.role.length > 80 ||
    !optionalInteger(value.requestedTokens) ||
    !optionalInteger(value.grantedTokens) ||
    !optionalInteger(value.retryAt)
  )
    return undefined
  return value as unknown as ThrottleDecision
}

const decodeActivity = (value: unknown): ThrottleActivity | undefined => {
  if (
    !isRecord(value) ||
    !integer(value.windowMs, 1) ||
    !integer(value.inFlightCalls) ||
    !integer(value.reservedTokens) ||
    !isRecord(value.counts) ||
    !integer(value.counts.admitted) ||
    !integer(value.counts.deferred) ||
    !integer(value.counts.scaled) ||
    !integer(value.counts.settled) ||
    !integer(value.counts.blocked) ||
    !Array.isArray(value.pausedRoles)
  )
    return undefined
  const pausedRoles = value.pausedRoles.flatMap(candidate =>
    isRecord(candidate) &&
    typeof candidate.role === "string" &&
    candidate.role.length >= 1 &&
    candidate.role.length <= 80 &&
    integer(candidate.retryAt)
      ? [{ role: candidate.role, retryAt: candidate.retryAt }]
      : [],
  )
  if (pausedRoles.length !== value.pausedRoles.length) return undefined
  const latest =
    value.latest === undefined ? undefined : decodeDecision(value.latest)
  if (value.latest !== undefined && !latest) return undefined
  return {
    windowMs: value.windowMs,
    inFlightCalls: value.inFlightCalls,
    reservedTokens: value.reservedTokens,
    counts: {
      admitted: value.counts.admitted,
      deferred: value.counts.deferred,
      scaled: value.counts.scaled,
      settled: value.counts.settled,
      blocked: value.counts.blocked,
    },
    pausedRoles,
    ...(latest ? { latest } : {}),
  }
}

export const decodeThrottleControl = (
  value: unknown,
): ThrottleControl | undefined => {
  if (
    !isRecord(value) ||
    !integer(value.computedAt) ||
    value.provider !== "openai" ||
    (value.pool !== "codex-app-server-weekly" &&
      value.pool !== "chatgpt-shared-weekly") ||
    (value.source !== "codex-app-server" &&
      value.source !== "manual" &&
      value.source !== "unavailable") ||
    !isRecord(value.profile) ||
    value.profile.kind !== "flat-until-reset" ||
    !integer(value.profile.participants, 1) ||
    value.profile.participants > 16 ||
    !isRecord(value.policy) ||
    !isPace(value.policy.pace) ||
    !integer(value.policy.minimumIntervalMs) ||
    !finite(value.policy.throttleRatio) ||
    value.policy.throttleRatio > 1 ||
    !optionalFinite(value.policy.actualRemainingPercent, 0, 200) ||
    !optionalFinite(value.policy.targetRemainingPercent, 0, 200) ||
    !optionalInteger(value.policy.resetAt) ||
    !optionalFinite(value.policy.observedBurnPercentPerHour) ||
    !optionalFinite(value.policy.permittedBurnPercentPerHour) ||
    !optionalInteger(value.policy.estimatedExhaustionAt) ||
    !Array.isArray(value.roles)
  )
    return undefined

  const activity = decodeActivity(value.activity)
  if (!activity) return undefined

  const roles = value.roles.map(decodeRole)
  if (
    roles.some(role => role === undefined) ||
    roles.length !== ROLE_NAMES.length ||
    new Set(roles.map(role => role?.role)).size !== ROLE_NAMES.length
  )
    return undefined

  if (value.allocation !== undefined) {
    if (
      !isRecord(value.allocation) ||
      !finite(value.allocation.configuredWeight, 1) ||
      value.allocation.configuredWeight > 2 ||
      !finite(value.allocation.recencyFactor, 0.25) ||
      value.allocation.recencyFactor > 1 ||
      !finite(value.allocation.effectiveWeight, 0.25) ||
      value.allocation.effectiveWeight > 2
    )
      return undefined
  }
  if (value.calibration !== undefined) {
    if (
      !isRecord(value.calibration) ||
      !finite(value.calibration.observedBurnPercent) ||
      !integer(value.calibration.observedTokens) ||
      !finite(value.calibration.tokensPerPercent)
    )
      return undefined
  }
  if (value.providerBudget !== undefined) {
    if (
      !isRecord(value.providerBudget) ||
      !integer(value.providerBudget.capacityTokens, 1) ||
      !integer(value.providerBudget.permittedTokensPerHour, 1) ||
      !integer(value.providerBudget.windowMs, 1)
    )
      return undefined
  }
  return value as unknown as ThrottleControl
}

const poolLabel = (_control: ThrottleControl): string => "OpenAI"

const percent = (value: number, digits = 0): string =>
  `${value.toFixed(digits)}%`

const resetLabel = (timestamp: number | undefined): string =>
  timestamp === undefined
    ? "reset unknown"
    : `reset ${new Date(timestamp).toLocaleString([], {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      })}`

const compactTokens = (value: number): string =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}m`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}k`
      : String(value)

const decisionRoleLabel = (role: string): string =>
  role.replace(/-operator$/u, "")

const decisionAge = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - at) / 1_000))
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`
}

const enforcementNow = (control: ThrottleControl): string => {
  if (control.activity.inFlightCalls > 0)
    return "Agent work is running now at the paced rate"
  const next = control.activity.pausedRoles[0]
  if (next)
    return `Waiting between agent steps · next work ${new Date(next.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
  if (control.activity.latest?.outcome === "scaled")
    return "A larger task was reduced to fit the current pace"
  return "No agent work is waiting on the throttle"
}

const latestDecision = (control: ThrottleControl): string => {
  const latest = control.activity.latest
  if (!latest) return "latest · none"
  const tokenChange =
    latest.requestedTokens !== undefined || latest.grantedTokens !== undefined
      ? ` ${compactTokens(latest.requestedTokens ?? 0)}→${compactTokens(latest.grantedTokens ?? 0)}`
      : ""
  return `latest · ${latest.kind} ${decisionRoleLabel(latest.role)} ${latest.outcome}${tokenChange} · ${decisionAge(latest.at, control.computedAt)}`
}

const currentSpeed = (control: ThrottleControl): number =>
  Math.round(
    control.policy.throttleRatio *
      (control.allocation?.recencyFactor ?? 1) *
      100,
  )

export const throttleStatusText = (control: ThrottleControl): string => {
  const remaining = control.policy.actualRemainingPercent
  const speed = currentSpeed(control)
  return `throttle · ${100 - speed}% slower · ${speed}% of normal · OpenAI ${remaining === undefined ? "unknown" : `${remaining}% left`}`
}

const padBetween = (left: string, right: string, width: number): string => {
  if (width <= 0) return ""
  const rightRoom = Math.min(visibleWidth(right), Math.floor(width * 0.42))
  const boundedRight = truncateToWidth(right, rightRoom, "…")
  const leftRoom = Math.max(0, width - visibleWidth(boundedRight) - 1)
  const boundedLeft = truncateToWidth(left, leftRoom, "…")
  const gap = Math.max(
    1,
    width - visibleWidth(boundedLeft) - visibleWidth(boundedRight),
  )
  return `${boundedLeft}${"─".repeat(gap)}${boundedRight}`
}

const roleLabel = (role: ThrottleRole): string =>
  role === "yielduck-operator"
    ? "yielduck"
    : role === "moneymentum-operator"
      ? "moneymentum"
      : role

export const throttleHudLines = (
  control: ThrottleControl,
  width: number,
  expanded = false,
): string[] => {
  if (!Number.isSafeInteger(width) || width <= 0) return []
  if (width < 38)
    return [truncateToWidth(throttleStatusText(control), width, "…")]

  const inset = framedChromeInset(width)
  const frameWidth = width - inset * 2
  const inner = Math.max(0, frameWidth - 6)
  const margin = " ".repeat(inset)
  const suffix = " ".repeat(width - inset - frameWidth)
  const framed = (line: string): string => `${margin}${line}${suffix}`
  const row = (text: string): string => {
    const content = truncateToWidth(text, inner, "…")
    return framed(
      `│  ${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}  │`,
    )
  }

  const { policy } = control
  const speed = currentSpeed(control)
  const slowdown = 100 - speed
  const remaining =
    policy.actualRemainingPercent === undefined
      ? "?"
      : percent(policy.actualRemainingPercent)
  const delta =
    policy.actualRemainingPercent === undefined ||
    policy.targetRemainingPercent === undefined
      ? "runway unknown"
      : `${Math.abs(
          policy.actualRemainingPercent - policy.targetRemainingPercent,
        ).toFixed(1)}pt ${
          policy.actualRemainingPercent >= policy.targetRemainingPercent
            ? "ahead"
            : "behind"
        }`
  const burn =
    policy.observedBurnPercentPerHour === undefined ||
    policy.permittedBurnPercentPerHour === undefined
      ? "burn unavailable"
      : `burn ${policy.observedBurnPercentPerHour.toFixed(2)}%/h observed · ${policy.permittedBurnPercentPerHour.toFixed(2)}%/h permitted · ${(
          policy.observedBurnPercentPerHour /
          Math.max(policy.permittedBurnPercentPerHour, Number.EPSILON)
        ).toFixed(1)}× over pace`
  const capacity = control.providerBudget
    ? `${compactTokens(control.providerBudget.permittedTokensPerHour)} tok/h · ${compactTokens(control.providerBudget.capacityTokens)}/${Math.round(control.providerBudget.windowMs / 3_600_000)}h`
    : "token capacity calibrating"
  const profile = `${control.profile.kind === "flat-until-reset" ? "flat 24/7" : control.profile.kind} · ${control.profile.participants} ${control.profile.participants === 1 ? "owner" : "owners"}`
  const roles = control.roles
    .map(
      ({ role, tokenScale }) =>
        `${roleLabel(role)} ${percent(tokenScale * 100)}`,
    )
    .join(" · ")
  const { counts } = control.activity
  const activityRollup = `${Math.round(control.activity.windowMs / 60_000)}m · ${counts.admitted} admitted · ${counts.deferred} deferred · ${counts.scaled} scaled · ${counts.settled} settled`

  const lines = [
    framed(
      `╭─ ${padBetween(
        `THROTTLE · ${slowdown}% SLOWER`,
        `${speed}% of normal · /throttle ${expanded ? "compact" : "details"}`,
        inner,
      )} ─╮`,
    ),
    row(`NOW · ${enforcementNow(control)}`),
    row(
      `${poolLabel(control)} ${remaining} left · ${delta} · ${resetLabel(policy.resetAt)}${control.allocation?.configuredWeight === 2 ? " · ST0x receives 2× share" : ""}`,
    ),
  ]
  if (expanded) {
    lines.push(row(`${burn} · ${profile}`))
    lines.push(row(`${latestDecision(control)} · ${activityRollup}`))
    lines.push(row(`capacity ${capacity} · ${roles}`))
  }
  return lines
}

const paceColor = (
  pace: UsagePace,
): "success" | "accent" | "warning" | "error" | "dim" =>
  pace === "open"
    ? "success"
    : pace === "guarded"
      ? "accent"
      : pace === "critical"
        ? "warning"
        : pace === "reserve"
          ? "error"
          : "dim"

const colorThrottleRow = (
  line: string,
  theme: Theme,
  contentColor: "success" | "accent" | "warning" | "error" | "dim",
): string => {
  const firstBorder = line.indexOf("│")
  const lastBorder = line.lastIndexOf("│")
  if (firstBorder < 0 || lastBorder <= firstBorder)
    return theme.fg("borderAccent", line)
  return [
    theme.fg("borderAccent", line.slice(0, firstBorder + 1)),
    theme.fg(contentColor, line.slice(firstBorder + 1, lastBorder)),
    theme.fg("borderAccent", line.slice(lastBorder)),
  ].join("")
}

export class ThrottleHudComponent {
  private readonly control: () => ThrottleControl | undefined
  private readonly expanded: () => boolean
  private readonly theme: Theme

  constructor(
    control: () => ThrottleControl | undefined,
    expanded: () => boolean,
    theme: Theme,
  ) {
    this.control = control
    this.expanded = expanded
    this.theme = theme
  }

  render(width: number): string[] {
    const current = this.control()
    if (!current) return []
    const [headline, ...rows] = throttleHudLines(
      current,
      width,
      this.expanded(),
    )
    if (!headline) return []
    const color = paceColor(current.policy.pace)
    return [
      this.theme.bold(this.theme.fg("borderAccent", headline)),
      ...rows.map(row => colorThrottleRow(row, this.theme, color)),
    ]
  }

  invalidate(): void {}
}
