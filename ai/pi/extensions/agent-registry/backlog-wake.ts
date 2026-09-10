import { createHash } from "node:crypto"
import { Effect } from "effect"
import {
  CAPABILITY_CIRCUIT_ENTRY,
  decodeCapabilityCircuit,
} from "../shared/capability-state.ts"
import {
  CONTINUATION_PAUSE_ENTRY,
  parseContinuationPause,
} from "../shared/continuation-pause.ts"
import type { BacklogState } from "./backlog.ts"
import {
  RegistryError,
  prioritizedActiveReceiptLeases,
  registryReceiptAvailable,
  type RegistryReceiptAvailability,
  type RegistrySnapshot,
} from "./registry.ts"

export interface BacklogWakeInput {
  readonly state: BacklogState
  readonly snapshot: RegistrySnapshot
  readonly agentId: string
  readonly project: string
  readonly now: number
  readonly lifecycle: "active" | "retired"
  readonly availability: RegistryReceiptAvailability
  readonly entries: readonly unknown[]
  readonly toolsAvailable: boolean
  readonly lastFingerprint: string | undefined
}

export interface BacklogWakePlan {
  readonly fingerprint: string
  readonly actionable: number
  readonly role: string
}

export interface BacklogWakeHost {
  readonly on: (
    event: "session_start" | "session_shutdown",
    handler: () => void,
  ) => void
  readonly sendMessage: (
    message: {
      customType: string
      content: string
      display: boolean
      details: { kind: string; fingerprint: string; actionable: number }
    },
    options: { triggerTurn: true; deliverAs: "followUp" },
  ) => void
}

export const makeBacklogWakeController = (host: BacklogWakeHost) => {
  let active = false
  let generation = 0
  let lastFingerprint: string | undefined
  host.on("session_start", () => {
    generation += 1
    active = true
    lastFingerprint = undefined
  })
  host.on("session_shutdown", () => {
    generation += 1
    active = false
    lastFingerprint = undefined
  })
  return {
    reconcile: (
      input: Omit<BacklogWakeInput, "lastFingerprint">,
    ): Effect.Effect<void, RegistryError> => {
      const expectedGeneration = generation
      return Effect.gen(function* () {
        if (!active || expectedGeneration !== generation) return
        const wake = yield* operationalBacklogWake({
          ...input,
          lastFingerprint,
        })
        if (!wake || !active || expectedGeneration !== generation) return
        yield* Effect.try({
          try: () =>
            host.sendMessage(
              {
                customType: "agent-registry.message",
                content: `The current project has ${wake.actionable} external actionable backlog items available to this operational role. Inspect the declared backlog, reconcile current tasks, and continue independently authorized work. This bounded reconciliation wake does not claim work, authorize backlog content, or establish complete source coverage.`,
                display: true,
                details: {
                  kind: "backlog-reconciliation",
                  fingerprint: wake.fingerprint,
                  actionable: wake.actionable,
                },
              },
              { triggerTurn: true, deliverAs: "followUp" },
            ),
          catch: () =>
            new RegistryError({
              code: "io",
              message: "Could not deliver external backlog reconciliation wake",
            }),
        })
        if (active && expectedGeneration === generation)
          lastFingerprint = wake.fingerprint
      })
    },
  }
}

export const operationalBacklogWake = (
  input: BacklogWakeInput,
): Effect.Effect<BacklogWakePlan | undefined, RegistryError> =>
  Effect.gen(function* () {
    if (
      input.lifecycle !== "active" ||
      !input.toolsAvailable ||
      !registryReceiptAvailable(input.availability)
    )
      return undefined
    const seen = new Set<string>()
    for (let index = input.entries.length - 1; index >= 0; index -= 1) {
      const entry = input.entries[index]
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("type" in entry) ||
        entry.type !== "custom" ||
        !("customType" in entry)
      )
        continue
      const kind = entry.customType
      if (
        (kind !== CONTINUATION_PAUSE_ENTRY &&
          kind !== CAPABILITY_CIRCUIT_ENTRY) ||
        seen.has(kind)
      )
        continue
      seen.add(kind)
      const data = "data" in entry ? entry.data : undefined
      if (kind === CONTINUATION_PAUSE_ENTRY) {
        const pause = parseContinuationPause(data)
        if (
          !pause ||
          !Number.isSafeInteger(pause.updatedAt) ||
          pause.updatedAt < 0
        )
          return yield* Effect.fail(
            new RegistryError({
              code: "corrupt_state",
              message:
                "Invalid continuation pause state; automatic backlog wake refused",
            }),
          )
        if (pause.paused) return undefined
      } else {
        const circuit = decodeCapabilityCircuit(data)
        if (!circuit)
          return yield* Effect.fail(
            new RegistryError({
              code: "corrupt_state",
              message:
                "Invalid capability circuit state; automatic backlog wake refused",
            }),
          )
        if (circuit.open) return undefined
      }
    }
    const leases = prioritizedActiveReceiptLeases(
      input.snapshot,
      input.agentId,
    ).filter(
      lease =>
        lease.project === input.project &&
        lease.mode === "operational" &&
        lease.expiresAt > input.now,
    )
    const lease = leases[0]
    if (!lease) return undefined
    const external = new Set(
      input.state.sources
        .filter(source => source.kind !== "branch-todo")
        .map(source => source.itemId),
    )
    const items = input.state.items.filter(item => {
      if (item.project !== input.project || !external.has(item.id)) return false
      const state = item.state
      if (state.kind === "ready") return true
      return (
        (state.kind === "assigned" ||
          state.kind === "implementing" ||
          state.kind === "in-review" ||
          state.kind === "publishing") &&
        state.agentId === input.agentId &&
        leases.some(owned => owned.id === state.leaseId)
      )
    })
    if (items.length === 0) return undefined
    const requirements = new Map<string, string[]>()
    for (const requirement of input.state.requirements) {
      const digests = requirements.get(requirement.itemId) ?? []
      digests.push(requirement.digest)
      requirements.set(requirement.itemId, digests)
    }
    const content = items
      .map(item => ({
        id: item.id,
        state: item.state.kind,
        priority: item.priority,
        requirements: [...new Set(requirements.get(item.id) ?? [])].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          input.project,
          lease.role,
          lease.id,
          input.agentId,
          content,
        ]),
      )
      .digest("hex")
    if (fingerprint === input.lastFingerprint) return undefined
    return { fingerprint, actionable: items.length, role: lease.role }
  })
