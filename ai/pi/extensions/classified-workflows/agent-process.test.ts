import assert from "node:assert/strict"
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import {
  AGENT_PROCESS_STDIO,
  AgentProcessError,
  agentRequestWithEffectiveCwd,
  buildAgentArguments,
  buildAgentExecutionPlan,
  LOCAL_LANE_PROVIDER,
  localLaneWorkflowRefusal,
  resolveAgentModel as resolveAgentModelEffect,
  resolveWorkflowThinking,
  runAgentExecutionPlan,
  WORKFLOW_CHILD_SYSTEM_PROMPT,
} from "./agent-process.ts"

const run = <T>(effect: Effect.Effect<T, unknown>): T => Effect.runSync(effect)
const resolveAgentModel = (
  ...args: Parameters<typeof resolveAgentModelEffect>
): string | undefined => run(resolveAgentModelEffect(...args))

test("workflow orchestration is refused on the local Ollama lane", () => {
  const refusal = localLaneWorkflowRefusal(LOCAL_LANE_PROVIDER)
  assert.ok(refusal, "local lane must receive a refusal message")
  assert.match(refusal ?? "", /route/i)
  assert.match(refusal ?? "", /agent_registry/)
})

test("workflow orchestration stays available to full-capability providers", () => {
  assert.equal(localLaneWorkflowRefusal("openai-codex"), undefined)
  assert.equal(localLaneWorkflowRefusal("anthropic"), undefined)
  assert.equal(localLaneWorkflowRefusal(undefined), undefined)
})

test("workflow children load only the classified workflow extension explicitly", () => {
  assert.deepEqual(
    run(
      buildAgentArguments(
        {
          task: "inspect",
          tools: ["read", "bash"],
          model: "reviewer",
          thinking: "high",
        },
        "/repo/classified-workflows/index.ts",
      ),
    ),
    [
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--no-extensions",
      "--extension",
      "/repo/classified-workflows/index.ts",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--system-prompt",
      WORKFLOW_CHILD_SYSTEM_PROMPT,
      "--tools",
      "read,bash",
      "--model",
      "reviewer",
      "--thinking",
      "high",
      "inspect",
    ],
  )
})

test("workflow children receive a bounded isolated prompt contract", () => {
  const args = run(buildAgentArguments({ task: "inspect" }, "/repo/index.ts"))
  assert.ok(args.includes("--no-context-files"))
  assert.ok(args.includes("--system-prompt"))
  assert.match(WORKFLOW_CHILD_SYSTEM_PROMPT, /batch independent reads/i)
  assert.match(
    WORKFLOW_CHILD_SYSTEM_PROMPT,
    /native grep\/find\/ls.*cwd root.*exact.*path.*bash rg/i,
  )
  assert.match(WORKFLOW_CHILD_SYSTEM_PROMPT, /return.*before exhausting/i)
})

test("workflow execution uses one canonical cwd for the prompt and process", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-cwd-"))
  const repository = join(root, "repository")
  const worktree = join(repository, "worktree")
  const linkedWorktree = join(root, "linked-worktree")
  try {
    mkdirSync(worktree, { recursive: true })
    symlinkSync(worktree, linkedWorktree)
    const plan = run(
      buildAgentExecutionPlan(
        { task: "Read .tmp/review/pipeline.diff", cwd: linkedWorktree },
        repository,
        "/repo/classified-workflows/index.ts",
      ),
    )
    const systemPrompt =
      plan.args[plan.args.indexOf("--system-prompt") + 1] ?? ""
    assert.equal(plan.cwd, realpathSync(worktree))
    assert.equal(plan.request.cwd, plan.cwd)
    assert.match(
      systemPrompt,
      /source-fixed effective child working directory/i,
    )
    assert.ok(systemPrompt.includes(JSON.stringify(plan.cwd)))
    assert.match(
      systemPrompt,
      /resolve every relative task and tool path from exactly this directory/i,
    )
    assert.match(systemPrompt, /do not rebase.*repository root/i)
    assert.equal(plan.args.at(-1), "Read .tmp/review/pipeline.diff")
    let spawnedArgs: string[] | undefined
    let spawnedCwd: string | undefined
    const result = await runAgentExecutionPlan(plan, async (args, cwd) => {
      spawnedArgs = args
      spawnedCwd = cwd
      return "completed"
    })
    assert.equal(result, "completed")
    assert.equal(spawnedCwd, plan.cwd)
    assert.ok(spawnedArgs)
    assert.equal(
      spawnedArgs[spawnedArgs.indexOf("--system-prompt") + 1],
      systemPrompt,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("workflow cwd validation rejects malformed and nonexistent boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-cwd-invalid-"))
  const file = join(root, "not-a-directory")
  writeFileSync(file, "data")
  try {
    for (const cwd of [
      null,
      "",
      "bad\0cwd",
      "x".repeat(4_097),
      file,
      join(root, "missing"),
    ]) {
      const error = run(
        Effect.flip(
          agentRequestWithEffectiveCwd({ task: "inspect", cwd }, root),
        ),
      )
      assert.ok(error instanceof AgentProcessError)
      assert.equal(error.code, "invalid_input")
    }
    const oversizedDefaultError = run(
      Effect.flip(
        agentRequestWithEffectiveCwd({ task: "inspect" }, "x".repeat(4_097)),
      ),
    )
    assert.ok(oversizedDefaultError instanceof AgentProcessError)
    assert.equal(oversizedDefaultError.code, "invalid_input")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("workflow relative cwd resolves against the parent cwd before canonicalization", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-cwd-relative-"))
  const worktree = join(root, "nested", "worktree")
  try {
    mkdirSync(worktree, { recursive: true })
    const request = run(
      agentRequestWithEffectiveCwd(
        { task: "inspect", cwd: "nested/other/../worktree" },
        root,
      ),
    )
    assert.equal(request.cwd, realpathSync(worktree))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("workflow children activate only requested source tools and not extension control-plane tools", () => {
  const args = run(
    buildAgentArguments(
      { task: "inspect one source", tools: ["read"] },
      "/repo/classified-workflows/index.ts",
    ),
  )
  assert.equal(args[args.indexOf("--tools") + 1], "read")
  for (const tool of [
    "workflow",
    "workflow_audit",
    "review_duty",
    "artifact_provenance",
  ]) {
    assert.equal(
      args[args.indexOf("--tools") + 1].split(",").includes(tool),
      false,
    )
  }
})

test("structured workflow children receive an explicit JSON-only contract", () => {
  const args = run(
    buildAgentArguments(
      { task: "inspect", schema: { type: "object", required: ["findings"] } },
      "/repo/index.ts",
    ),
  )
  assert.match(
    args.at(-1) ?? "",
    /Return only valid JSON matching this JSON Schema/,
  )
  assert.match(args.at(-1) ?? "", /\"required\":\[\"findings\"\]/)
})

test("workflow model preflight resolves only authenticated available providers", () => {
  const available = [
    { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { provider: "openai-codex", id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    {
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
    },
    {
      provider: "anthropic",
      id: "claude-sonnet-4-5-20250929",
      name: "Claude Sonnet 4.5",
    },
  ]
  assert.equal(
    resolveAgentModel("gpt-5.6-sol", "openai-codex", available),
    "openai-codex/gpt-5.6-sol",
  )
  assert.equal(
    resolveAgentModel("openai/gpt-5.6-sol", "openai-codex", available),
    "openai-codex/gpt-5.6-sol",
  )
  for (const legacyMini of [
    "gpt-5.4-mini",
    "openai/gpt-5.4-mini",
    "openai-codex/gpt-5.4-mini",
  ]) {
    assert.equal(
      resolveAgentModel(legacyMini, "openai-codex", [
        ...available,
        {
          provider: "openai-codex",
          id: "gpt-5.4-mini",
          name: "GPT-5.4 Mini",
        },
      ]),
      "openai-codex/gpt-5.6-luna",
      "legacy mini requests must stay on the lightweight tier without launching a pre-5.6 model",
    )
  }
  assert.throws(
    () => resolveAgentModel("other/gpt-5.4-mini", "openai-codex", available),
    /unavailable or has no configured authentication/i,
  )
  assert.throws(
    () =>
      resolveAgentModel("openai/gpt-5.6-missing", "openai-codex", available),
    /unavailable or has no configured authentication/i,
  )
  assert.throws(
    () => resolveAgentModel("other/gpt-5.6-sol", "openai-codex", available),
    /unavailable or has no configured authentication/i,
  )
  assert.equal(
    resolveAgentModel("fable", "openai-codex", available),
    "openai-codex/gpt-5.6-luna",
  )
  assert.equal(
    resolveAgentModel("sonnet", "openai-codex", available),
    "openai-codex/gpt-5.6-luna",
  )
  assert.equal(
    resolveAgentModel("opus", "openai-codex", available),
    "openai-codex/gpt-5.6-luna",
  )
  assert.throws(
    () =>
      resolveAgentModel(
        "anthropic/claude-sonnet-4-6",
        "openai-codex",
        available,
      ),
    /external claude -p subscription lane/i,
  )
  assert.equal(
    resolveAgentModel(undefined, "openai-codex", available),
    "openai-codex/gpt-5.6-terra",
  )
  assert.throws(
    () => resolveAgentModel(undefined, "anthropic", available),
    /cannot inherit Anthropic API models/i,
  )
  assert.throws(
    () => resolveAgentModel("amazon-bedrock/sonnet", "openai-codex", available),
    /external claude -p subscription lane/i,
  )
  assert.throws(
    () =>
      resolveAgentModel("fable", "openai-codex", [
        { provider: "openai-codex", id: "gpt-5.6-sol" },
      ]),
    /requires authenticated openai-codex\/gpt-5\.6-luna/i,
  )
  assert.throws(
    () => resolveAgentModel("nonexistent", "openai-codex", available),
    /inherit the parent/i,
  )
})

test("workflow reasoning defaults follow the selected model tier", () => {
  assert.equal(
    resolveWorkflowThinking(undefined, "openai-codex/gpt-5.6-terra"),
    "medium",
  )
  assert.equal(
    resolveWorkflowThinking(undefined, "openai-codex/gpt-5.6-luna"),
    "high",
  )
  assert.equal(
    resolveWorkflowThinking("xhigh", "openai-codex/gpt-5.6-terra"),
    "xhigh",
  )
})

test("JSON workflow children stay hidden behind captured pipes", () => {
  assert.deepEqual(AGENT_PROCESS_STDIO, ["ignore", "pipe", "pipe"])
  assert.equal(
    run(buildAgentArguments({ task: "inspect" }, "/repo/index.ts")).includes(
      "json",
    ),
    true,
  )
})

test("workflow children normalize comma-delimited tools at the process boundary", () => {
  const args = run(
    buildAgentArguments(
      { task: "inspect", tools: "read,grep,find,ls" },
      "/repo/index.ts",
    ),
  )
  assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls")
})

test("workflow children reject unsupported tools", () => {
  assert.throws(
    () =>
      run(
        buildAgentArguments(
          { task: "inspect", tools: ["read", "unknown"] },
          "/repo/index.ts",
        ),
      ),
    /unsupported tool/i,
  )
})
