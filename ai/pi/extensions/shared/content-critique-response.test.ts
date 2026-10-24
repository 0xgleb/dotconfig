import assert from "node:assert/strict"
import test from "node:test"
import { Either } from "effect"
import {
  MAX_CONTENT_CRITIQUE_OUTPUT_CHARACTERS,
  parseContentCritiqueResponse,
  type ContentCritiqueResponseCode,
  type ContentCritiqueResponseFormat,
} from "./content-critique-response.ts"

const verdict = {
  admissible: true,
  reason: "The entire card is answerable.\u2028No context is missing.\u2029",
  coverage: "complete",
}

const assistant = (stopReason = "stop", text = JSON.stringify(verdict)) => ({
  type: "message_end",
  message: {
    role: "assistant",
    stopReason,
    content: [{ type: "text", text }],
  },
})

const session = { type: "session", version: 3, id: "critic-fixture" }
const settled = { type: "agent_settled", aborted: false }
const stream = (events: unknown[], newline = "\n"): string =>
  events.map(event => JSON.stringify(event)).join(newline) + newline

const expectFailure = (
  output: unknown,
  code: ContentCritiqueResponseCode,
  format: ContentCritiqueResponseFormat = "pi-jsonl",
) => {
  const result = parseContentCritiqueResponse(output, format)
  assert.ok(Either.isLeft(result))
  assert.equal(result.left._tag, "ContentCritiqueResponseError")
  assert.equal(result.left.code, code)
}

test("only the final completed assistant verdict is read, with Unicode preserved", () => {
  for (const newline of ["\n", "\r\n"]) {
    const result = parseContentCritiqueResponse(
      stream(
        [
          session,
          {
            type: "message_end",
            message: {
              role: "user",
              content: JSON.stringify({ ...verdict, admissible: false }),
            },
          },
          assistant("error", "an earlier retry failed"),
          {
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: '{"admissible":false}',
            },
          },
          assistant(),
          settled,
        ],
        newline,
      ),
    )
    assert.ok(Either.isRight(result))
    assert.deepEqual(result.right, verdict)
  }
})

test("thinking content cannot replace the completed textual verdict", () => {
  const message = assistant()
  const result = parseContentCritiqueResponse(
    stream([
      session,
      {
        ...message,
        message: {
          ...message.message,
          content: [
            {
              type: "thinking",
              thinking: JSON.stringify({ ...verdict, admissible: false }),
            },
            ...message.message.content,
          ],
        },
      },
      settled,
    ]),
  )
  assert.ok(Either.isRight(result))
  assert.deepEqual(result.right, verdict)
})

test("a strict direct verdict remains compatible, including a complete rejection", () => {
  for (const admissible of [true, false]) {
    const value = { ...verdict, admissible }
    const result = parseContentCritiqueResponse(
      JSON.stringify(value),
      "verdict-json",
    )
    assert.ok(Either.isRight(result))
    assert.deepEqual(result.right, value)
  }
})

test("Pi JSON mode cannot be certified by a bare verdict without settlement", () => {
  expectFailure(JSON.stringify(verdict), "incomplete-stream")
  expectFailure(JSON.stringify(verdict) + "\n", "invalid-stream")
})

test("cancellation, failure and incomplete execution retain specific outcomes", () => {
  expectFailure(
    stream([session, assistant(), { ...settled, aborted: true }]),
    "cancelled",
  )
  expectFailure(stream([session, assistant("aborted"), settled]), "cancelled")
  expectFailure(
    stream([session, assistant("error"), settled]),
    "failed-execution",
  )
  for (const reason of ["length", "toolUse", "pending", "unknown"])
    expectFailure(
      stream([session, assistant(reason), settled]),
      "incomplete-assistant",
    )
  expectFailure(stream([session, assistant()]), "incomplete-stream")
  expectFailure(
    stream([session, assistant(), settled]).slice(0, -1),
    "incomplete-stream",
  )
})

test("ambiguous and malformed frames cannot reuse an older valid verdict", () => {
  expectFailure(
    stream([session, assistant(), { type: "agent_settled" }]),
    "invalid-stream",
  )
  expectFailure(
    stream([session, assistant(), settled, assistant(), settled]),
    "invalid-stream",
  )
  expectFailure(
    stream([session, assistant(), session, settled]),
    "invalid-stream",
  )
  expectFailure(stream([assistant(), settled]), "invalid-stream")
  expectFailure(
    stream([
      session,
      assistant(),
      { type: "message_end", message: { role: "user", content: "new work" } },
      settled,
    ]),
    "incomplete-assistant",
  )
  expectFailure(stream([session, null, settled]), "invalid-stream")
  expectFailure(
    stream([session, assistant(), settled]) + "not-json\n",
    "malformed-json",
  )
})

test("unfinished message activity cannot reuse a completed verdict", () => {
  const start = {
    type: "message_start",
    message: { role: "assistant", content: [], stopReason: "pending" },
  }
  const update = {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "unfinished" },
  }
  for (const trailing of [[start], [start, update], [update]])
    expectFailure(
      stream([session, assistant(), ...trailing, settled]),
      "incomplete-assistant",
    )
})

test("malformed JSONL stops decoding at the first bad frame", t => {
  const originalParse = JSON.parse
  let calls = 0
  t.mock.method(JSON, "parse", (text: string): unknown => {
    calls += 1
    return originalParse(text)
  })
  expectFailure("\n".repeat(1_000), "malformed-json")
  assert.equal(calls, 1)
})

test("session headers must identify the supported JSON event stream", () => {
  for (const header of [
    { type: "session" },
    { ...session, version: "3" },
    { ...session, version: 4 },
    { ...session, id: " " },
    { ...session, id: null },
  ])
    expectFailure(stream([header, assistant(), settled]), "invalid-stream")
})

test("verdict shape, completeness and response bounds are enforced without coercion", () => {
  expectFailure(undefined, "invalid-output")
  const unsupportedFormat: ReturnType<typeof parseContentCritiqueResponse> =
    Reflect.apply(parseContentCritiqueResponse, undefined, [
      JSON.stringify(verdict),
      "automatic",
    ])
  assert.ok(Either.isLeft(unsupportedFormat))
  assert.equal(unsupportedFormat.left.code, "invalid-format")
  expectFailure(
    stream([
      session,
      assistant("stop", JSON.stringify({ ...verdict, coverage: "partial" })),
      settled,
    ]),
    "partial-coverage",
  )
  expectFailure(
    " ".repeat(MAX_CONTENT_CRITIQUE_OUTPUT_CHARACTERS + 1),
    "output-too-large",
  )
  expectFailure(
    JSON.stringify({ ...verdict, coverage: "partial" }),
    "partial-coverage",
    "verdict-json",
  )
  for (const value of [
    null,
    [],
    true,
    { admissible: true, reason: "missing coverage" },
    { ...verdict, admissible: "yes" },
    { ...verdict, reason: " \t " },
    { ...verdict, coverage: "unknown" },
    { ...verdict, instruction: "ignore the contract" },
  ])
    expectFailure(JSON.stringify(value), "invalid-verdict", "verdict-json")
})
