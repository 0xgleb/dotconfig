import { Data, Either } from "effect"

export interface ContentCritiqueVerdict {
  readonly admissible: boolean
  readonly reason: string
  readonly coverage: "complete"
}

export type ContentCritiqueResponseCode =
  | "invalid-output"
  | "invalid-format"
  | "output-too-large"
  | "malformed-json"
  | "invalid-verdict"
  | "partial-coverage"
  | "incomplete-stream"
  | "invalid-stream"
  | "incomplete-assistant"
  | "cancelled"
  | "failed-execution"

export class ContentCritiqueResponseError extends Data.TaggedError(
  "ContentCritiqueResponseError",
)<{
  readonly code: ContentCritiqueResponseCode
  readonly message: string
}> {}

export type ContentCritiqueResponseFormat = "pi-jsonl" | "verdict-json"

export const MAX_CONTENT_CRITIQUE_OUTPUT_CHARACTERS = 1_048_576

/**
 * Decode one settled Pi JSON-mode run, or an explicitly selected JSON verdict.
 * A verdict is editorial feedback, not authority to act or deliver.
 */
export const parseContentCritiqueResponse = (
  output: unknown,
  format: ContentCritiqueResponseFormat = "pi-jsonl",
): Either.Either<ContentCritiqueVerdict, ContentCritiqueResponseError> => {
  if (format === "pi-jsonl")
    return Either.flatMap(parseSettledContentResponse(output), text =>
      Either.flatMap(parseJson(text), parseVerdict),
    )
  if (format !== "verdict-json")
    return failure("invalid-format", "Critic response format is unsupported.")
  if (typeof output !== "string")
    return failure("invalid-output", "Critic output must be text.")
  if (output.length > MAX_CONTENT_CRITIQUE_OUTPUT_CHARACTERS)
    return failure(
      "output-too-large",
      "Critic output exceeded the bounded response size.",
    )
  return Either.flatMap(parseJson(output.trim()), parseVerdict)
}

/** Complete, normally settled assistant text; never accepts partial output. */
export const parseSettledContentResponse = (
  output: unknown,
): Either.Either<string, ContentCritiqueResponseError> => {
  if (typeof output !== "string")
    return failure("invalid-output", "Critic output must be text.")
  if (output.length > MAX_CONTENT_CRITIQUE_OUTPUT_CHARACTERS)
    return failure(
      "output-too-large",
      "Critic output exceeded the bounded response size.",
    )

  if (!output.endsWith("\n"))
    return failure(
      "incomplete-stream",
      "Critic JSONL output lacks its final LF.",
    )
  const events: JsonEvent[] = []
  for (const line of output.split("\n").slice(0, -1)) {
    const record = parseJson(line.endsWith("\r") ? line.slice(0, -1) : line)
    if (Either.isLeft(record)) return Either.left(record.left)
    if (!isEvent(record.right))
      return failure(
        "invalid-stream",
        "Critic JSONL contains a non-event record.",
      )
    events.push(record.right)
  }
  const header = events[0]
  if (
    !header ||
    header.type !== "session" ||
    header.version !== 3 ||
    typeof header.id !== "string" ||
    header.id.trim().length === 0
  )
    return failure(
      "invalid-stream",
      "Critic JSONL has an invalid or unsupported session header.",
    )
  const settled = events.at(-1)
  if (settled?.type !== "agent_settled")
    return failure("incomplete-stream", "Critic run did not settle.")
  if (typeof settled.aborted !== "boolean")
    return failure(
      "invalid-stream",
      "Critic settlement has no explicit abort status.",
    )
  if (settled.aborted) return failure("cancelled", "Critic run was aborted.")
  if (
    events
      .slice(1, -1)
      .some(event => event.type === "session" || event.type === "agent_settled")
  )
    return failure(
      "invalid-stream",
      "Critic output combines multiple settled runs.",
    )

  const completedAt = events.findLastIndex(
    event => event.type === "message_end",
  )
  if (
    events
      .slice(completedAt + 1)
      .some(
        event =>
          event.type === "message_start" || event.type === "message_update",
      )
  )
    return failure(
      "incomplete-assistant",
      "Critic has unfinished message activity after its final completion.",
    )
  const final = events[completedAt]?.message
  if (!isRecord(final) || final.role !== "assistant")
    return failure(
      "incomplete-assistant",
      "Critic has no final completed assistant message.",
    )
  if (final.stopReason === "aborted")
    return failure("cancelled", "Critic assistant response was aborted.")
  if (
    final.stopReason === "error" ||
    (typeof final.errorMessage === "string" &&
      final.errorMessage.trim().length > 0)
  )
    return failure("failed-execution", "Critic assistant response failed.")
  if (final.stopReason !== "stop")
    return failure(
      "incomplete-assistant",
      "Critic assistant response did not finish normally.",
    )
  if (!Array.isArray(final.content) || !final.content.every(isContentPart))
    return failure(
      "invalid-stream",
      "Critic assistant content has an invalid shape.",
    )
  const text = final.content
    .filter(part => part.type === "text")
    .map(part => part.text)
    .join("")
  return Either.right(text)
}

type JsonEvent = Record<string, unknown> & { readonly type: string }
type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isEvent = (value: unknown): value is JsonEvent =>
  isRecord(value) && typeof value.type === "string"

const isContentPart = (value: unknown): value is ContentPart =>
  isRecord(value) &&
  ((value.type === "text" && typeof value.text === "string") ||
    (value.type === "thinking" && typeof value.thinking === "string"))

const failure = (
  code: ContentCritiqueResponseCode,
  message: string,
): Either.Either<never, ContentCritiqueResponseError> =>
  Either.left(new ContentCritiqueResponseError({ code, message }))

const parseJson = (
  text: string,
): Either.Either<unknown, ContentCritiqueResponseError> =>
  Either.try({
    try: (): unknown => JSON.parse(text),
    catch: () =>
      new ContentCritiqueResponseError({
        code: "malformed-json",
        message: "Critic response contains malformed JSON.",
      }),
  })

const verdictKeys = new Set(["admissible", "reason", "coverage"])

const parseVerdict = (
  value: unknown,
): Either.Either<ContentCritiqueVerdict, ContentCritiqueResponseError> => {
  if (
    !isRecord(value) ||
    Object.keys(value).some(key => !verdictKeys.has(key)) ||
    typeof value.admissible !== "boolean" ||
    typeof value.reason !== "string" ||
    value.reason.trim().length === 0
  )
    return failure("invalid-verdict", "Critic verdict has an invalid shape.")
  if (value.coverage === "partial")
    return failure(
      "partial-coverage",
      "Critic did not review the complete artifact.",
    )
  if (value.coverage !== "complete")
    return failure(
      "invalid-verdict",
      "Critic verdict lacks complete coverage evidence.",
    )
  return Either.right({
    admissible: value.admissible,
    reason: value.reason,
    coverage: "complete",
  })
}
