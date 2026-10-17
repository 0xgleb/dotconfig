import { Effect } from "effect"
import {
  RegistryError,
  registrySnapshotForProject,
  type RegistryRequest,
  type RegistrySnapshot,
} from "./registry.ts"
import { registryListText, registryRequestDetailText } from "./presentation.ts"

export interface RegistryListQuery {
  readonly action: "list" | "requests"
  readonly project?: string
  readonly role?: string
  readonly requestStatus?: "open" | "all" | RegistryRequest["status"]
  readonly requestId?: string
  readonly limit?: number
  readonly offset?: number
}

export const registryListingResult = (
  snapshot: RegistrySnapshot,
  query: RegistryListQuery,
  agentId: string,
  now: number,
) =>
  Effect.gen(function* () {
    const limit = query.limit === undefined ? 20 : query.limit
    const offset = query.offset === undefined ? 0 : query.offset
    const status =
      query.requestStatus === undefined ? "open" : query.requestStatus
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      ![
        "open",
        "all",
        "queued",
        "claimed",
        "completed",
        "failed",
        "cancelled",
      ].includes(status)
    ) {
      return yield* Effect.fail(
        new RegistryError({
          code: "invalid_input",
          message:
            "Listing requires limit 1–20, nonnegative safe-integer offset, and a valid requestStatus.",
        }),
      )
    }
    for (const [name, value] of [
      ["project", query.project],
      ["role", query.role],
      ["requestId", query.requestId],
    ] as const) {
      if (
        value !== undefined &&
        (typeof value !== "string" ||
          value.trim().length === 0 ||
          value.length > 1024)
      ) {
        return yield* Effect.fail(
          new RegistryError({
            code: "invalid_input",
            message: `Invalid listing ${name}.`,
          }),
        )
      }
    }
    const project = query.project?.trim()
    const role = query.role?.trim()
    const scoped: RegistrySnapshot =
      query.action === "requests"
        ? {
            version: 1,
            leases: [],
            requests: snapshot.requests.filter(
              request => project === undefined || request.project === project,
            ),
          }
        : project
          ? registrySnapshotForProject(snapshot, project)
          : snapshot
    const leases = scoped.leases.filter(
      lease => role === undefined || lease.role === role,
    )
    const owners = new Set(leases.map(lease => lease.owner.id))
    const requests = scoped.requests.filter(
      request => role === undefined || request.role === role,
    )
    const requested = query.requestId?.trim()
    if (requested !== undefined) {
      if (
        query.offset !== undefined ||
        query.limit !== undefined ||
        query.requestStatus !== undefined
      ) {
        return yield* Effect.fail(
          new RegistryError({
            code: "invalid_input",
            message:
              "Exact request lookup cannot be combined with pagination or requestStatus.",
          }),
        )
      }
      const matches = requests.filter(
        ({ id }) => id === requested || id.startsWith(requested),
      )
      const request = matches[0]
      if (matches.length !== 1 || request === undefined) {
        return yield* Effect.fail(
          new RegistryError({
            code: matches.length === 0 ? "not_found" : "invalid_input",
            message:
              matches.length === 0
                ? "request not found"
                : "request prefix is ambiguous",
          }),
        )
      }
      return {
        content: [
          { type: "text" as const, text: registryRequestDetailText(request) },
        ] satisfies [{ type: "text"; text: string }],
        details: {
          outcome: "success",
          action: query.action,
          kind: "registry-request-detail",
          requestId: request.id,
        },
      }
    }
    const orderedRequests = requests
      .filter(
        request =>
          status === "all" ||
          (status === "open"
            ? request.status === "queued" || request.status === "claimed"
            : request.status === status),
      )
      .sort(
        (left, right) =>
          Number(right.priority === "urgent") -
            Number(left.priority === "urgent") ||
          left.createdAt - right.createdAt ||
          compareId(left.id, right.id),
      )
    const agents =
      query.action === "requests"
        ? []
        : (scoped.agents ?? [])
            .filter(
              agent => role === undefined || owners.has(agent.identity.id),
            )
            .toSorted((left, right) =>
              compareId(left.identity.id, right.identity.id),
            )
    const orderedLeases =
      query.action === "requests"
        ? []
        : leases.toSorted((left, right) => compareId(left.id, right.id))
    const page: RegistrySnapshot = {
      version: 1,
      agents: agents.slice(offset, offset + limit),
      leases: orderedLeases.slice(offset, offset + limit),
      requests: orderedRequests.slice(offset, offset + limit),
    }
    const totals = {
      agents: agents.length,
      roles: orderedLeases.length,
      requests: orderedRequests.length,
    }
    const returned = {
      agents: page.agents?.length ?? 0,
      roles: page.leases.length,
      requests: page.requests.length,
    }
    const total = Math.max(totals.agents, totals.roles, totals.requests)
    if (offset > 0 && offset >= total) {
      return yield* Effect.fail(
        new RegistryError({
          code: "invalid_input",
          message:
            "Listing offset is outside the current result; restart at offset 0.",
        }),
      )
    }
    const nextOffset = offset + limit < total ? offset + limit : undefined
    const partial = offset > 0 || nextOffset !== undefined
    const counts = `agents: ${returned.agents} of ${totals.agents}; roles: ${returned.roles} of ${totals.roles}; requests: ${returned.requests} of ${totals.requests}`
    const header = `Registry page (${partial ? "partial" : "complete matching registry rows"}) · offset ${offset} · ${counts}`
    const text = registryListText(page, agentId, now, "all")
      .split("\n")
      .map(boundedLine)
      .join("\n")
    const continuation =
      nextOffset === undefined
        ? "End of current matching registry rows."
        : `Next page: repeat the same filters with limit=${limit}, offset=${nextOffset}.`
    return {
      content: [
        {
          type: "text" as const,
          text: `${header}\n${text}\n${continuation}\nLive offset pagination: results can change between calls; restart at offset 0 after changes. Counts describe registry rows only, not total external backlog or source coverage. Rows are capped at 512 bytes; use requestId for the full request.`,
        },
      ] satisfies [{ type: "text"; text: string }],
      details: {
        outcome: "success",
        action: query.action,
        kind: "registry-list-page",
        offset,
        limit,
        totals,
        returned,
        partial,
        ...(nextOffset === undefined ? {} : { nextOffset }),
      },
    }
  })

const compareId = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const boundedLine = (text: string): string => {
  const line = text.replace(/[\u0000-\u001f\u007f]/gu, " ")
  if (Buffer.byteLength(line, "utf8") <= 512) return line
  let result = ""
  let bytes = 0
  for (const character of line) {
    const size = Buffer.byteLength(character, "utf8")
    if (bytes + size > 509) break
    result += character
    bytes += size
  }
  return `${result}...`
}
