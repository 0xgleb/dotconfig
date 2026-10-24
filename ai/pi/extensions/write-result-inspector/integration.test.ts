import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import type {
  ExecOptions,
  ExecResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent"
import {
  cancelRuntime,
  createRuntime,
  inspectSuccessfulMutation,
  type InspectorHost,
} from "./index.ts"

const cwd = "/Users/0xgleb/.config"
const path = "ai/pi/extensions/write-result-inspector/index.ts"

const processOutput = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [
      {
        type: "text",
        text: JSON.stringify({ findings: [], contextRequests: [] }),
      },
    ],
    stopReason: "stop",
    usage: {
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 110,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
  },
})

const mutationEvent = (toolCallId: string): ToolResultEvent => ({
  type: "tool_result",
  toolCallId,
  toolName: "edit",
  input: {
    path,
    edits: [
      {
        oldText: "const previous = 1",
        newText: "const next = 2",
      },
    ],
  },
  content: [{ type: "text", text: "Applied edit" }],
  details: undefined,
  isError: false,
})

test("real middleware batch patches only its leader and accounts one model call", async () => {
  let deterministicCalls = 0
  let modelCalls = 0
  const host: InspectorHost = {
    exec: async (
      command: string,
      _args: string[],
      _options?: ExecOptions,
    ): Promise<ExecResult> => {
      if (command === "prettier") {
        deterministicCalls += 1
        return { code: 0, stdout: "", stderr: "", killed: false }
      }
      assert.equal(command, "pi")
      modelCalls += 1
      return { code: 0, stdout: processOutput, stderr: "", killed: false }
    },
  }
  const runtime = Effect.runSync(createRuntime(host, cwd))
  runtime.parentProvider = "openai-codex"
  runtime.contextFiles = [
    { path: `${cwd}/AGENTS.md`, content: "Use strict TypeScript." },
  ]

  const first = inspectSuccessfulMutation(mutationEvent("first"), runtime)
  const second = inspectSuccessfulMutation(mutationEvent("second"), runtime)
  const [firstPatch, secondPatch] = await Promise.all([first, second])

  assert.ok(firstPatch)
  assert.equal(secondPatch, undefined)
  assert.equal(deterministicCalls, 1)
  assert.equal(modelCalls, 1)
  assert.equal(firstPatch.usage?.totalTokens, 110)
  assert.equal(firstPatch.details.writeResultInspection.status, "clean")

  cancelRuntime(runtime)
  assert.equal(
    await inspectSuccessfulMutation(mutationEvent("after-cancel"), runtime),
    undefined,
  )
})
