import assert from "node:assert/strict"
import test from "node:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import registryExtension from "./index.ts"
import {
  BRANCH_TODO_BACKLOG_EVENT,
  CANONICAL_BACKLOG_EVENT,
  MESSAGE_BACKLOG_EVENT,
} from "../shared/backlog-events.ts"
import {
  REGISTRY_DELEGATE_REQUEST_EVENT,
  REGISTRY_IDENTITY_REQUEST_EVENT,
  REGISTRY_INTENT_REQUEST_EVENT,
  REGISTRY_OUTCOME_EVENT,
  REGISTRY_PROJECTS_REQUEST_EVENT,
} from "../shared/registry-intent-events.ts"
import { RUNTIME_VERSION_REQUEST_EVENT } from "../shared/runtime-version.ts"

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0]

const registration = () => {
  const subscriptions = new Set<string>()
  const hooks = new Set<string>()
  const tools = new Map<string, RegisteredTool>()
  const api = {
    events: {
      on: (name: string) => {
        subscriptions.add(name)
        return () => subscriptions.delete(name)
      },
      emit: () => {},
    },
    on: (name: string) => hooks.add(name),
    registerMessageRenderer: () => {},
    registerCommand: () => {},
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
  }
  Reflect.apply(registryExtension, undefined, [api])
  return { subscriptions, hooks, tools }
}

test("registry registration subscribes only to current coordination events", () => {
  const runtime = registration()
  assert.deepEqual(
    runtime.subscriptions,
    new Set([
      RUNTIME_VERSION_REQUEST_EVENT,
      MESSAGE_BACKLOG_EVENT,
      CANONICAL_BACKLOG_EVENT,
      BRANCH_TODO_BACKLOG_EVENT,
      REGISTRY_INTENT_REQUEST_EVENT,
      REGISTRY_IDENTITY_REQUEST_EVENT,
      REGISTRY_DELEGATE_REQUEST_EVENT,
      REGISTRY_OUTCOME_EVENT,
      REGISTRY_PROJECTS_REQUEST_EVENT,
    ]),
  )
  assert.equal(runtime.hooks.has("tool_result"), false)
  assert.equal(runtime.hooks.has("agent_end"), false)
  assert.equal(runtime.hooks.has("agent_settled"), true)
})

test("registry tool keeps coordination authority without injected support routing", () => {
  const tool = registration().tools.get("agent_registry")
  assert.ok(tool)
  const guidelines = tool.promptGuidelines?.join("\n")
  assert.ok(guidelines)
  assert.doesNotMatch(
    guidelines,
    /pi-support|delegate.*(?:classifier|TUI|reload).*bugs/is,
  )
  assert.match(
    guidelines,
    /Registry ownership never grants tools or production authority/,
  )
})
