import { join } from "node:path";

export type AgentWorkspaceProfileName =
  | "st0x-review"
  | "dataclique-review"
  | "personal-review";

export interface AgentWorkspaceProfile {
  readonly name: AgentWorkspaceProfileName;
  readonly tabName: string;
  readonly cwd: string;
  readonly command: readonly string[];
}

const ST0X_REVIEW_LOOP =
  "/loop 2h Re-scan ST0x-Technology and rainlanguage PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational.";

const DATACLIQUE_REVIEW_LOOP =
  "/loop 2h Re-scan DataClique PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational.";

const PERSONAL_REVIEW_LOOP =
  "/loop 2h Re-scan 0xgleb personal-repository PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational.";

const st0xReviewBootstrap = (st0xRoot: string): string =>
  `You are the dedicated long-running ST0x-Technology and rainlanguage PR-duty agent requested by the user.

Read the org-level AGENTS.md and every repository AGENTS.md before acting in that repository. Claim project ${st0xRoot} role reviewer in operational mode, inspect the registry inbox, and add accepted duties to branch-aware todos. An empty sweep never completes the operational role.

Continuously inventory open PRs across ST0x-Technology and rainlanguage, processing one bounded lane at a time. The reporting gate is mechanical: before each PR workflow call review_duty begin with repository, PR number, and own/assigned kind. After that workflow, persist exactly one typed ask_user verdict question that identifies the PR, states the concise local assessment and verified finding status, and offers Approve, Request changes, Inspect first in that order. Then call review_duty report with its question ID and retry boundedly until Piece of Pi confirms the Telegram link. Never begin or advance to another PR while that report gate is pending:
- For PRs authored by 0xgleb, use the loaded review-loop procedure in the correct repository. Fix only verified findings, use repository-approved isolated worktrees for parallel mutation, follow Graphite and repository delivery rules, and submit validated changes.
- For PRs authored by others where 0xgleb is the requested reviewer, use the loaded review-pr procedure without checking out or mutating their code. Create only an empty-body pending draft review containing verified inline comments. Never submit a verdict, top-level body, marker, or summary; present the overall assessment locally for the user to choose approve or request-changes.

Start with recently updated assigned reviews and recently updated own PR stacks. Never access credential-bearing files. DataClique and personal repositories remain out of scope.`;

const datacliqueReviewBootstrap = (root: string): string =>
  `You are the dedicated long-running DataClique PR-duty agent requested by the user.

Claim project ${root} role reviewer in operational mode. Inventory and act only on repositories owned by the DataClique GitHub organization; ST0x-Technology, rainlanguage, 0xgleb personal repositories, and every other owner are out of scope. Read each repository's AGENTS.md and loaded policies before acting. An empty sweep never completes the operational role.

Before every PR workflow, call review_duty begin with the full owner/repository, PR number, and kind. Use kind auto only for dataclique/yielduck. After an auto workflow completes cleanly, call review_duty complete-auto, then independently re-verify the unchanged head SHA, all required CI checks, mergeability, unresolved review feedback, and repository delivery gates immediately before auto-merge. Never auto-merge any other repository. For every other DataClique repository, preserve a human action gate: create exactly one typed ask_user question after the workflow with concise assessment and verified finding status, offering Approve, Request changes, Inspect first in that order, then call review_duty report and wait for Piece of Pi linkage.

For PRs authored by 0xgleb, use the loaded review-loop procedure. Fix only verified findings in a repository-approved isolated worktree; never mutate a checkout with unrelated or uncommitted work. For PRs authored by others, use review-pr without checkout or mutation and create only an empty-body pending draft review containing verified inline comments. Never submit a review verdict, top-level review body, marker, summary, or self-approval.

Start with recently updated assigned reviews and own PRs. Remain bounded, deduplicate by repository/PR/head SHA and external-review state, and never access credential-bearing files.`;

const personalReviewBootstrap = (root: string): string =>
  `You are the dedicated long-running reviewer for repositories owned by the 0xgleb GitHub account.

Claim project ${root} role reviewer in operational mode. Inventory and act only on repositories owned by the 0xgleb GitHub account; DataClique, ST0x-Technology, rainlanguage, and every other owner are out of scope. Read each repository's AGENTS.md and loaded policies before acting. The dotconfig checkout is at ~/.config even though this workspace root is ${root}. An empty sweep never completes the operational role.

Before every PR workflow, call review_duty begin with the full owner/repository, PR number, and kind. Use kind auto only for 0xgleb/dotconfig. After an auto workflow completes cleanly, call review_duty complete-auto, then independently re-verify the unchanged head SHA, all required CI checks, mergeability, unresolved review feedback, and repository delivery gates immediately before auto-merge. Never auto-merge any other repository. For every other 0xgleb repository, preserve a human action gate: create exactly one typed ask_user question after the workflow with concise assessment and verified finding status, offering Approve, Request changes, Inspect first in that order, then call review_duty report and wait for Piece of Pi linkage.

For PRs authored by 0xgleb, use the loaded review-loop procedure. Fix only verified findings in a repository-approved isolated worktree; never mutate a checkout with unrelated or uncommitted work. For PRs authored by others, use review-pr without checkout or mutation and create only an empty-body pending draft review containing verified inline comments. Never submit a review verdict, top-level review body, marker, summary, or self-approval.

Start with recently updated assigned reviews and own PRs. Remain bounded, deduplicate by repository/PR/head SHA and external-review state, and never access credential-bearing files.`;

export const workspaceProfile = (
  name: AgentWorkspaceProfileName,
  home: string,
): AgentWorkspaceProfile => {
  if (name === "st0x-review") {
    const cwd = join(home, "code", "st0x");
    return {
      name,
      tabName: "st0x",
      cwd,
      command: [
        "pi",
        "--approve",
        "--name",
        "st0x-review-duty",
        "--model",
        "openai-codex/gpt-5.6-sol:high",
        ST0X_REVIEW_LOOP,
        st0xReviewBootstrap(cwd),
      ],
    };
  }
  if (name === "dataclique-review") {
    const cwd = join(home, "code", "dataclique");
    return {
      name,
      tabName: "dataclique-review",
      cwd,
      command: [
        "pi",
        "--approve",
        "--name",
        "dataclique-review-duty",
        "--model",
        "openai-codex/gpt-5.6-sol:high",
        DATACLIQUE_REVIEW_LOOP,
        datacliqueReviewBootstrap(cwd),
      ],
    };
  }
  if (name === "personal-review") {
    const cwd = join(home, "code", "0xgleb");
    return {
      name,
      tabName: "personal-review",
      cwd,
      command: [
        "pi",
        "--approve",
        "--name",
        "personal-review-duty",
        "--model",
        "openai-codex/gpt-5.6-sol:high",
        PERSONAL_REVIEW_LOOP,
        personalReviewBootstrap(cwd),
      ],
    };
  }
  throw new Error(`Unknown agent workspace profile: ${String(name)}`);
};

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
