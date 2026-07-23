import { basename, isAbsolute, join, relative, sep } from "node:path";
import { todoWorkSnapshot } from "../classified-workflows/goal.ts";
import { isContinuationPaused } from "../shared/continuation-pause.ts";

export const HANDOFF_GLOBS = ["*.md", "handoffs/*.md"] as const;

export const isSafeHandoffName: (name: string) => boolean = (name) => {
  const segments = name.split("/");
  const fileName = segments.at(-1) ?? "";
  const directPiRequest = segments.length === 1 && /(?:pi|handoff)/i.test(fileName);
  const dedicatedInboxRequest = segments.length === 2 && segments[0] === "handoffs";
  return (
    (directPiRequest || dedicatedInboxRequest) &&
    basename(fileName) === fileName &&
    !fileName.startsWith(".") &&
    fileName.endsWith(".md")
  );
};

export const parseSeenHandoffNames: (value: unknown) => string[] = (value) => {
  if (typeof value !== "object" || value === null || !("names" in value) || !Array.isArray(value.names)) return [];
  return value.names.every((name) => typeof name === "string" && isSafeHandoffName(name)) ? value.names : [];
};

export const unseenHandoffNames: (names: readonly string[], seen: ReadonlySet<string>) => string[] = (names, seen) =>
  names.filter((name) => isSafeHandoffName(name) && !seen.has(name)).sort();

export interface ManagedReloadSummary {
  readonly labels: readonly string[];
  readonly createdAt: number;
  readonly announced: boolean;
}

export const managedPiChangeLabel: (changedPath: string, aiRoot: string) => string = (changedPath, aiRoot) => {
  const parts = relative(aiRoot, changedPath).split(sep);
  if (parts[0] === "pi" && parts[1] === "extensions" && parts[2]) return `${parts[2]} extension`;
  if (parts[0] === "skills" && parts[1]) return `${parts[1]} skill`;
  if (parts[0] === "pi" && parts[1] === "themes") return "Pi theme";
  if (parts.at(-1) === "AGENTS.md") return "agent instructions";
  if (parts.at(-1) === "pi.settings.json") return "Pi settings";
  return "Pi configuration";
};

export const parseManagedReloadSummary: (value: unknown) => ManagedReloadSummary | undefined = (value) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("labels" in value) ||
    !Array.isArray(value.labels) ||
    !value.labels.every((label) => typeof label === "string") ||
    !("createdAt" in value) ||
    !Number.isFinite(value.createdAt) ||
    !("announced" in value) ||
    typeof value.announced !== "boolean"
  ) {
    return undefined;
  }
  return { labels: [...new Set(value.labels)].sort(), createdAt: Number(value.createdAt), announced: value.announced };
};

const hasActiveWorkflowState = (entries: readonly unknown[], customType: string): boolean => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "custom") continue;
    if (!("customType" in entry) || entry.customType !== customType || !("data" in entry)) continue;
    const data = entry.data;
    return typeof data === "object" && data !== null && "status" in data && data.status === "active";
  }
  return false;
};

export const shouldDispatchReloadFollowUp: (reason: string, entries: readonly unknown[]) => boolean = (reason, entries) =>
  reason === "reload" &&
  !isContinuationPaused(entries) &&
  (todoWorkSnapshot(entries).pending.length > 0 ||
    hasActiveWorkflowState(entries, "classified-workflows.goal") ||
    hasActiveWorkflowState(entries, "classified-workflows.loop"));

export const managedPiWatchPaths: (aiRoot: string) => string[] = (aiRoot) =>
  isAbsolute(aiRoot)
    ? [
        join(aiRoot, "AGENTS.md"),
        join(aiRoot, "pi.settings.json"),
        join(aiRoot, "pi", "AGENTS.md"),
        join(aiRoot, "pi", "extensions"),
        join(aiRoot, "pi", "themes"),
        join(aiRoot, "skills"),
      ]
    : [];
