import { join } from "node:path";

export type AgentWorkspaceProfileName = "st0x-review";

export interface AgentWorkspaceProfile {
  readonly name: AgentWorkspaceProfileName;
  readonly tabName: string;
  readonly cwd: string;
  readonly command: readonly string[];
}

const ST0X_REVIEW_LOOP =
  "/loop 15m Re-scan ST0x-Technology and rainlanguage PR duty; process newly actionable own and assigned-review work under the loaded repository and review policies, then remain operational.";

const st0xReviewBootstrap = (st0xRoot: string): string =>
  `You are the dedicated long-running ST0x-Technology and rainlanguage PR-duty agent requested by the user.

Read the org-level AGENTS.md and every repository AGENTS.md before acting in that repository. Claim project ${st0xRoot} role reviewer in operational mode, inspect the registry inbox, and add accepted duties to branch-aware todos. An empty sweep never completes the operational role.

Continuously inventory open PRs across ST0x-Technology and rainlanguage, processing one bounded lane at a time. The reporting gate is mechanical: before each PR workflow call review_duty begin with repository, PR number, and own/assigned kind. After that workflow, persist exactly one typed ask_user verdict question that identifies the PR, states the concise local assessment and verified finding status, and offers Approve, Request changes, Inspect first in that order. Then call review_duty report with its question ID and retry boundedly until Piece of Pi confirms the Telegram link. Never begin or advance to another PR while that report gate is pending:
- For PRs authored by 0xgleb, use the loaded review-loop procedure in the correct repository. Fix only verified findings, use repository-approved isolated worktrees for parallel mutation, follow Graphite and repository delivery rules, and submit validated changes.
- For PRs authored by others where 0xgleb is the requested reviewer, use the loaded review-pr procedure without checking out or mutating their code. Create only an empty-body pending draft review containing verified inline comments. Never submit a verdict, top-level body, marker, or summary; present the overall assessment locally for the user to choose approve or request-changes.

Start with recently updated assigned reviews and recently updated own PR stacks. Never access credential-bearing files. DataClique replication is out of scope until this ST0x lane is reliable.`;

export const workspaceProfile = (
  name: AgentWorkspaceProfileName,
  home: string,
): AgentWorkspaceProfile => {
  if (name !== "st0x-review")
    throw new Error(`Unknown agent workspace profile: ${String(name)}`);

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
