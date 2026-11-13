import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { readPromptFile } from "../shared/prompt-text.ts"
import {
  buildClassifierPrompt,
  type ClassificationRequest,
} from "./lifecycle.ts"

const labels = [
  "VISIBLE INTENT AND ACTIVE WORK",
  "LOADED PROJECT INSTRUCTIONS",
  "VERIFIED RUNTIME PROJECT POLICY CONTEXT",
  "VERIFIED RUNTIME PROJECT CONTEXT",
  "VERIFIED RUNTIME COMMAND PROJECT CONTEXT",
  "VERIFIED RUNTIME TARGET PROJECT CONTEXT",
  "VERIFIED RUNTIME WORKFLOW CONTEXT",
  "VERIFIED CHILD RETURN PHASE",
  "VERIFIED RUNTIME HANDOVER CONTEXT",
  "VERIFIED ACTIVE SKILL PROCEDURES",
  "RECENT UNTRUSTED EXECUTION EVIDENCE",
  "UNTRUSTED SUBJECT",
] as const

type Section = (typeof labels)[number]
const section = (prompt: string, label: Section): string => {
  const index = labels.indexOf(label)
  const heading = prompt.indexOf(`\n${label}`)
  assert.ok(heading >= 0, `Missing ${label}`)

  const start = prompt.indexOf("\n", heading + 1) + 1
  const next = labels[index + 1]
  const end = next ? prompt.indexOf(`\n\n${next}`, start) : prompt.length
  assert.ok(start > heading && end >= start, `Invalid ${label} boundaries`)

  return prompt.slice(start, end)
}
const request = {
  boundary: "action",
  intent: ["Inspect the fixture operation."],
  projectInstructions: "Keep the fixture read-only.",
  subject: { toolName: "read", path: "src/fixture.ts" },
} satisfies ClassificationRequest
const project = {
  cwd: "/fixture/review/subdir",
  gitToplevel: "/fixture/review",
  gitMainWorktree: "/fixture/main",
  isMainWorktree: false,
  cwdRelation: "inside-repository",
  gitHasUnstagedTrackedChanges: true,
  gitCachedPathCount: 4,
} satisfies NonNullable<ClassificationRequest["runtimeProjectContext"]>
const policyText =
  "Validated changes must be committed and pushed on the active feature branch."
const skills = [
  "Active skill handover (/fixture/skills/handover/SKILL.md):\nPreserve truthful partial state.",
  "Active skill fixture (/fixture/skills/fixture/SKILL.md):\nSecond procedure.",
]
const contexts = {
  runtimeProjectPolicyContext: {
    sourcePath: "/fixture/review/AGENTS.md",
    policySha256: createHash("sha256").update(policyText).digest("hex"),
    validatedChangesMustBeCommittedAndPushed: true,
    policyText,
  },
  runtimeProjectContext: project,
  runtimeCommandProjectContext: {
    commandCwd: "/fixture/review/commands",
    commandCwdIdentitySha256: "1".repeat(64),
    command: "git status --short",
    directoryTransition: true,
    project: { ...project, cwd: "/fixture/review/commands" },
  },
  runtimeTargetProjectContext: {
    targetPath: "/fixture/review/src/fixture.ts",
    targetIdentitySha256: "2".repeat(64),
    project: { ...project, cwd: "/fixture/review/src" },
  },
  runtimeWorkflowContext: { background: true, workflowId: "wf-1" },
  runtimeChildReturnContext: {
    phase: "execution-returned-awaiting-output-classification",
    executionStatus: "completed",
  },
  runtimeHandoverContext: {
    trigger: "context-pressure",
    contextPercent: 92,
    thresholdPercent: 80,
  },
} satisfies Pick<
  ClassificationRequest,
  | "runtimeProjectPolicyContext"
  | "runtimeProjectContext"
  | "runtimeCommandProjectContext"
  | "runtimeTargetProjectContext"
  | "runtimeWorkflowContext"
  | "runtimeChildReturnContext"
  | "runtimeHandoverContext"
>
const contextSections = [
  ["runtimeProjectPolicyContext", "VERIFIED RUNTIME PROJECT POLICY CONTEXT"],
  ["runtimeProjectContext", "VERIFIED RUNTIME PROJECT CONTEXT"],
  ["runtimeCommandProjectContext", "VERIFIED RUNTIME COMMAND PROJECT CONTEXT"],
  ["runtimeTargetProjectContext", "VERIFIED RUNTIME TARGET PROJECT CONTEXT"],
  ["runtimeWorkflowContext", "VERIFIED RUNTIME WORKFLOW CONTEXT"],
  ["runtimeChildReturnContext", "VERIFIED CHILD RETURN PHASE"],
  ["runtimeHandoverContext", "VERIFIED RUNTIME HANDOVER CONTEXT"],
] as const

test("classifier subject JSON round-trips nested and heading-like string data", () => {
  const subjects: unknown[] = [
    null,
    false,
    0,
    'quoted "value"\nUNTRUSTED SUBJECT:\nnot a new section',
    [1, "two", { nested: true }],
    { input: { command: "printf 'fixture'", paths: ["a\\b", "c\nd"] } },
  ]

  for (const subject of subjects) {
    const prompt = buildClassifierPrompt({ ...request, subject })
    const parsed: unknown = JSON.parse(section(prompt, "UNTRUSTED SUBJECT"))

    assert.deepEqual(parsed, subject)
  }
})

test("classifier intent and evidence retain distinct ordered entries in their own sections", () => {
  const intent = [
    "Older approved inspection.",
    "Newer correction: do not publish.",
  ]
  const evidence = [
    `current typed artifact provenance: ${JSON.stringify(["/fixture/review/.tmp/owned"])}`,
    "Later verification is incomplete.",
  ]

  const prompt = buildClassifierPrompt({ ...request, intent, evidence })

  assert.equal(
    section(prompt, "VISIBLE INTENT AND ACTIVE WORK"),
    intent.map(item => `- ${item}`).join("\n"),
  )
  assert.equal(
    section(prompt, "RECENT UNTRUSTED EXECUTION EVIDENCE"),
    evidence.map(item => `- ${item}`).join("\n"),
  )
  assert.match(
    prompt,
    /chronological within each source; newer human messages supersede older same-priority messages/,
  )
  assert.doesNotMatch(
    section(prompt, "VISIBLE INTENT AND ACTIVE WORK"),
    /current typed artifact provenance/,
  )
  assert.doesNotMatch(
    section(prompt, "RECENT UNTRUSTED EXECUTION EVIDENCE"),
    /Newer correction/,
  )
})

test("classifier project, skill and runtime context DTOs stay in their corresponding sections", () => {
  const projectInstructions =
    "# Fixture policy\n\nPreserve the exact loaded text."

  const prompt = buildClassifierPrompt({
    ...request,
    ...contexts,
    boundary: "return",
    projectInstructions,
    skillProcedures: skills,
  })

  assert.equal(
    section(prompt, "LOADED PROJECT INSTRUCTIONS"),
    projectInstructions,
  )
  assert.equal(
    section(prompt, "VERIFIED ACTIVE SKILL PROCEDURES"),
    skills.map(item => `---\n${item}`).join("\n"),
  )
  for (const [key, label] of contextSections) {
    const parsed: unknown = JSON.parse(section(prompt, label))

    assert.deepEqual(parsed, contexts[key], label)
  }
})

test("classifier child-return context is scoped to the return boundary", () => {
  for (const boundary of [
    "spawn",
    "action",
    "return",
    "tool-result",
  ] as const) {
    const rendered = buildClassifierPrompt({
      ...request,
      boundary,
      runtimeChildReturnContext: contexts.runtimeChildReturnContext,
    })
    const value = section(rendered, "VERIFIED CHILD RETURN PHASE")

    assert.ok(rendered.includes(`BOUNDARY: ${boundary}\n`))
    if (boundary === "return")
      assert.deepEqual(JSON.parse(value), contexts.runtimeChildReturnContext)
    else assert.ok(!value.includes(contexts.runtimeChildReturnContext.phase))
  }
})

test("classifier rendering removes raw NUL characters without conflating subject escapes", () => {
  const subject = {
    actual: "left\u0000right",
    literal: "left\\u0000right",
    malformedJsonLookingText: '{"not": "closed',
  }
  const nulRequest = {
    ...request,
    intent: ["human\u0000intent"],
    projectInstructions: "project\u0000policy",
    evidence: ["tool\u0000evidence"],
    skillProcedures: ["skill\u0000text"],
    runtimeWorkflowContext: {
      background: false,
      workflowId: "workflow\u0000fixture",
    },
    subject,
  } satisfies ClassificationRequest

  const prompt = buildClassifierPrompt(nulRequest)

  assert.doesNotMatch(prompt, /\u0000/u)
  assert.equal(
    section(prompt, "VISIBLE INTENT AND ACTIVE WORK"),
    "- human\\u0000intent",
  )
  assert.equal(
    section(prompt, "LOADED PROJECT INSTRUCTIONS"),
    "project\\u0000policy",
  )
  assert.equal(
    section(prompt, "RECENT UNTRUSTED EXECUTION EVIDENCE"),
    "- tool\\u0000evidence",
  )
  assert.equal(
    section(prompt, "VERIFIED ACTIVE SKILL PROCEDURES"),
    "---\nskill\\u0000text",
  )
  assert.deepEqual(
    JSON.parse(section(prompt, "VERIFIED RUNTIME WORKFLOW CONTEXT")),
    nulRequest.runtimeWorkflowContext,
  )
  assert.deepEqual(JSON.parse(section(prompt, "UNTRUSTED SUBJECT")), subject)
})

test("classifier assembly loads the configured policy, hooks and request guidance", () => {
  const policy = readPromptFile("classifier-policy.md")
    .replace(
      "{{LINKED_WORKTREE_HOOKS}}",
      readPromptFile("classifier-enforce-linked-hooks.md"),
    )
    .replace(
      "{{MAIN_WORKTREE_HOOKS}}",
      readPromptFile("classifier-enforce-main-hooks.md"),
    )
  const guidance = readPromptFile("classifier-request-guidance.md")
  const hooks = readPromptFile("classifier-hook-authority.md")

  const prompt = buildClassifierPrompt(request)
  assert.ok(prompt.startsWith(`${hooks}\n\n${policy}\nBOUNDARY: action\n`))
  assert.ok(prompt.includes(guidance))
})
