import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Data, Effect } from "effect";
import { Type } from "typebox";

import { registerRuntimeVersion } from "../shared/runtime-version.ts";
import {
  workspaceProfile,
  zellijLaunchArguments,
  type AgentWorkspaceProfileName,
} from "./profiles.ts";

const QUERY_TIMEOUT_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 15_000;

class AgentWorkspaceError extends Data.TaggedError("AgentWorkspaceError")<{
  readonly code: "not_in_zellij" | "query_failed" | "launch_failed";
  readonly message: string;
}> {}

interface AgentWorkspaceParams {
  readonly action: "start" | "status";
  readonly profile: AgentWorkspaceProfileName;
}

const tabNames = (stdout: string): readonly string[] =>
  stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

export default function agentWorkspace(pi: ExtensionAPI): void {
  registerRuntimeVersion(pi, "agent-workspace", "2026.08.01.3");

  pi.registerTool({
    name: "agent_workspace",
    label: "Agent workspace",
    description:
      "Start or inspect a source-fixed dedicated Pi agent workspace. Profiles fix cwd, model, prompt, Zellij tab, and operational duty in reviewed source; arbitrary commands are not accepted.",
    promptSnippet:
      "Start or inspect a reviewed dedicated Pi workspace profile without arbitrary terminal commands",
    promptGuidelines: [
      "Use agent_workspace start only when the user explicitly requests the named dedicated agent; role ownership never grants additional authority.",
    ],
    parameters: Type.Object({
      action: StringEnum(["start", "status"] as const),
      profile: StringEnum(
        ["st0x-review", "dataclique-review", "personal-review"] as const,
      ),
    }),
    async execute(_toolCallId, params: AgentWorkspaceParams) {
      const profile = workspaceProfile(params.profile, homedir());
      const operation = Effect.gen(function* () {
        if (!process.env.ZELLIJ_SESSION_NAME) {
          return yield* Effect.fail(
            new AgentWorkspaceError({
              code: "not_in_zellij",
              message:
                "Dedicated agent workspaces require an existing Zellij session",
            }),
          );
        }

        const queried = yield* Effect.tryPromise({
          try: () =>
            pi.exec("zellij", ["action", "query-tab-names"], {
              timeout: QUERY_TIMEOUT_MS,
            }),
          catch: () =>
            new AgentWorkspaceError({
              code: "query_failed",
              message: "Could not query Zellij tab names",
            }),
        });
        if (queried.code !== 0) {
          return yield* Effect.fail(
            new AgentWorkspaceError({
              code: "query_failed",
              message: "Zellij tab query failed",
            }),
          );
        }

        const existing = tabNames(queried.stdout).includes(profile.tabName);
        if (params.action === "status" || existing) {
          return { status: existing ? "running" : "stopped" } as const;
        }

        const launched = yield* Effect.tryPromise({
          try: () =>
            pi.exec("zellij", [...zellijLaunchArguments(profile)], {
              timeout: LAUNCH_TIMEOUT_MS,
            }),
          catch: () =>
            new AgentWorkspaceError({
              code: "launch_failed",
              message: "Could not launch the dedicated agent workspace",
            }),
        });
        if (launched.code !== 0) {
          return yield* Effect.fail(
            new AgentWorkspaceError({
              code: "launch_failed",
              message: "Zellij rejected the dedicated agent workspace launch",
            }),
          );
        }
        return { status: "started" } as const;
      });

      const outcome = await Effect.runPromise(operation);
      return {
        content: [
          {
            type: "text" as const,
            text: `${profile.name}: ${outcome.status} in Zellij tab ${profile.tabName}`,
          },
        ],
        details: {
          profile: profile.name,
          tabName: profile.tabName,
          status: outcome.status,
        },
      };
    },
  });
}
