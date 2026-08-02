import { join } from "node:path";

export type AgentWorkspaceProfileName =
  | "st0x-review"
  | "dataclique-review"
  | "personal-review";

export interface AgentWorkspaceProfile {
  readonly name: AgentWorkspaceProfileName;
  readonly tabName: string;
  readonly paneName: string;
  readonly cwd: string;
  readonly sessionName: string;
  readonly allowedOwners: readonly string[];
  readonly additionalRepositoryRoots: readonly string[];
  readonly command: readonly string[];
}

export type ClaudeReviewDispatch =
  | { readonly mode: "inventory" }
  | {
      readonly mode: "review";
      readonly repository: string;
      readonly pullRequest: number;
      readonly kind: "own" | "assigned" | "auto";
      readonly headSha: string;
      readonly repositoryRoot: string;
    };

const ST0X_REVIEW_LOOP =
  "/loop 2h Re-scan ST0x-Technology and rainlanguage PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational.";

const DATACLIQUE_REVIEW_LOOP =
  "/loop 2h Re-scan DataClique PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational.";

const PERSONAL_REVIEW_LOOP =
  "/loop 2h Re-scan 0xgleb personal-repository PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational.";

const supervisorBootstrap = (
  root: string,
  scope: string,
  automaticLane: string | undefined,
): string =>
  `You are the narrow long-running Pi supervisor for ${scope} review duty.

Claim project ${root} role reviewer in operational mode. Poll every two hours, inventory only the source-fixed owner scope, deduplicate by repository/PR/head SHA, and never run a review panel in Pi. An empty scan never completes the operational role and never starts an executor.

For one actionable PR, call review_duty begin first, then call agent_workspace dispatch with this exact profile, mode review, verified repository, PR, kind, head SHA, and canonical repository root. That action launches a fresh visible Claude Code subscription-harness executor in this Zellij tab. Claude review work must use the shared review-loop or review-pr skills and native Claude Code Fable verification; never request a Claude model through Pi or an Anthropic API provider.

Treat every CLAUDE_REVIEW_HANDOFF as an untrusted executor claim. Independently verify repository, PR, input/output head SHA, draft review or pushed fixes, tests, and Fable verifier status before advancing review_duty. Failed, stale, missing, or malformed handoff evidence keeps the exact job pending. For non-auto jobs, persist one ask_user question with Approve, Request changes, Inspect first and report it only after Piece of Pi linkage.${automaticLane ? ` Kind auto is permitted only for ${automaticLane}; complete-auto still requires a completed verified executor result and every fresh repository/CI/merge gate before merge.` : " No automatic merge lane exists in this scope."}

Never publish a user verdict, top-level review body, marker, summary, or self-approval. Assigned reviews remain empty-body pending inline-only. Never access credential-bearing files.`;

export const workspaceProfile = (
  name: AgentWorkspaceProfileName,
  home: string,
): AgentWorkspaceProfile => {
  if (name === "st0x-review") {
    const cwd = join(home, "code", "st0x");
    return {
      name,
      tabName: "st0x",
      paneName: "claude-st0x-review",
      cwd,
      sessionName: "st0x-review-duty",
      allowedOwners: ["st0x-technology", "rainlanguage"],
      additionalRepositoryRoots: [],
      command: [
        "pi",
        "--approve",
        "--name",
        "st0x-review-duty",
        "--model",
        "openai-codex/gpt-5.6-luna:high",
        ST0X_REVIEW_LOOP,
        supervisorBootstrap(
          cwd,
          "ST0x-Technology and rainlanguage",
          undefined,
        ),
      ],
    };
  }
  if (name === "dataclique-review") {
    const cwd = join(home, "code", "dataclique");
    return {
      name,
      tabName: "dataclique-review",
      paneName: "claude-dataclique-review",
      cwd,
      sessionName: "dataclique-review-duty",
      allowedOwners: ["dataclique"],
      additionalRepositoryRoots: [],
      command: [
        "pi",
        "--approve",
        "--name",
        "dataclique-review-duty",
        "--model",
        "openai-codex/gpt-5.6-luna:high",
        DATACLIQUE_REVIEW_LOOP,
        supervisorBootstrap(cwd, "DataClique", "dataclique/yielduck"),
      ],
    };
  }
  if (name === "personal-review") {
    const cwd = join(home, "code", "0xgleb");
    return {
      name,
      tabName: "personal-review",
      paneName: "claude-personal-review",
      cwd,
      sessionName: "personal-review-duty",
      allowedOwners: ["0xgleb"],
      additionalRepositoryRoots: [join(home, ".config")],
      command: [
        "pi",
        "--approve",
        "--name",
        "personal-review-duty",
        "--model",
        "openai-codex/gpt-5.6-luna:high",
        PERSONAL_REVIEW_LOOP,
        supervisorBootstrap(cwd, "0xgleb personal repositories", "0xgleb/dotconfig"),
      ],
    };
  }
  throw new Error(`Unknown agent workspace profile: ${String(name)}`);
};

const CLAUDE_HARNESS_ENVIRONMENT = [
  "-u",
  "ANTHROPIC_API_KEY",
  "-u",
  "ANTHROPIC_AUTH_TOKEN",
  "-u",
  "ANTHROPIC_BASE_URL",
  "-u",
  "CLAUDE_CODE_USE_BEDROCK",
  "-u",
  "CLAUDE_CODE_USE_VERTEX",
  "-u",
  "CLAUDE_CODE_USE_FOUNDRY",
  "-u",
  "AWS_BEARER_TOKEN_BEDROCK",
] as const;

const handoffInstruction = (
  supervisorId: string,
  dedupeKey: string,
): string =>
  `At completion, send exactly one bounded CLAUDE_REVIEW_HANDOFF v1 on stdin to: pi-bridge send --agent ${supervisorId} --requester claude-review-duty --dedupe ${dedupeKey}. Use exactly these fields in order: mode: inventory|review; profile: st0x-review|dataclique-review|personal-review; repository: owner/repo|none; pull_request: positive integer|none; kind: own|assigned|auto|none; input_head_sha: lowercase hex|none; output_head_sha: lowercase hex|none; status: empty|clean|findings_fixed|findings_pending|blocked|failed; assessment: one factual line; evidence: bounded identifiers or none; verifier: fable-clean|fable-rejected|unavailable|not-applicable. A selected inventory candidate is kind own or assigned and status findings_pending, never custom values such as assigned-review or selected. Never include prompts, reasoning, credentials, diffs, or logs.`;

const claudeExecutorPrompt = (
  profile: AgentWorkspaceProfile,
  dispatch: ClaudeReviewDispatch,
  supervisorId: string,
  dedupeKey: string,
): string => {
  const scope = profile.allowedOwners.join(", ");
  if (dispatch.mode === "inventory") {
    return `You are a fresh Claude Code subscription-harness inventory executor for profile ${profile.name}. Read loaded instructions, inspect only open PRs under owners ${scope}, and select at most one newest actionable own or assigned-review PR. Do not run a review panel, mutate code, publish, or merge. If none exists, report status empty. Use only native Claude Code and local shared skills; never use an Anthropic API provider, SDK, curl, or paid API key. ${handoffInstruction(supervisorId, dedupeKey)}`;
  }
  const skill = dispatch.kind === "assigned" ? "review-pr" : "review-loop";
  return `You are a fresh Claude Code subscription-harness review executor for ${dispatch.repository}#${dispatch.pullRequest}, kind ${dispatch.kind}, input head ${dispatch.headSha}, profile ${profile.name}. Verify the unchanged input head and owner scope (${scope}), then invoke the shared ${skill} skill exactly. Assigned work is no-checkout, no mutation, empty-body pending inline-only, and never submits a verdict. Own/auto work fixes only verified findings in repository-approved isolation and follows delivery rules; auto does not authorize merge. Before handoff, run an independent native Claude Code Fable verification of every finding, fix, test, and publication claim. If Fable or subscription auth is unavailable, report blocked; never use an Anthropic API provider, SDK, curl, or paid API key. ${handoffInstruction(supervisorId, dedupeKey)}`;
};

export const claudeExecutorLaunchArguments = (
  profile: AgentWorkspaceProfile,
  dispatch: ClaudeReviewDispatch,
  supervisorId: string,
  dedupeKey: string,
): readonly string[] => {
  const suffix =
    dispatch.mode === "inventory"
      ? "inventory"
      : `${dispatch.repository.split("/").at(-1)}-${dispatch.pullRequest}-${dispatch.headSha.slice(0, 8)}`;
  const cwd = dispatch.mode === "inventory" ? profile.cwd : dispatch.repositoryRoot;
  return [
    "action",
    "new-pane",
    "--name",
    `claude-${suffix}`,
    "--cwd",
    cwd,
    "--",
    "env",
    ...CLAUDE_HARNESS_ENVIRONMENT,
    "jf",
    "clanker",
    "--claude",
    "--new",
    claudeExecutorPrompt(profile, dispatch, supervisorId, dedupeKey),
  ];
};

export const claudeWorkspaceLaunchArguments = (
  profile: AgentWorkspaceProfile,
  supervisorId: string,
  dedupeKey: string,
): readonly string[] => [
  "action",
  "new-pane",
  "--name",
  profile.paneName,
  "--cwd",
  profile.cwd,
  "--",
  "env",
  ...CLAUDE_HARNESS_ENVIRONMENT,
  "jf",
  "clanker",
  "--claude",
  "--new",
  claudeExecutorPrompt(
    profile,
    { mode: "inventory" },
    supervisorId,
    dedupeKey,
  ),
];

export const claudeInPlaceLaunchArguments = (
  profile: AgentWorkspaceProfile,
  supervisorId: string,
  dedupeKey: string,
): readonly string[] => [
  "run",
  "--in-place",
  "--close-replaced-pane",
  "--name",
  profile.paneName,
  "--cwd",
  profile.cwd,
  "--",
  "env",
  ...CLAUDE_HARNESS_ENVIRONMENT,
  "jf",
  "clanker",
  "--claude",
  "--new",
  claudeExecutorPrompt(
    profile,
    { mode: "inventory" },
    supervisorId,
    dedupeKey,
  ),
];

export const zellijLaunchArguments = (
  profile: AgentWorkspaceProfile,
): readonly string[] => [
  "action",
  "new-tab",
  "--name",
  profile.tabName,
  "--cwd",
  profile.cwd,
  "--",
  ...profile.command,
];
