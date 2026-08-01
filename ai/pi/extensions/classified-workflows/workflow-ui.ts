import { alignChromeLine } from "../shared/chrome.ts";

export type WorkflowUiStatus = "running" | "completed" | "failed" | "cancelled";

export interface WorkflowUiItem {
  readonly id: string;
  readonly label: string;
  readonly status: WorkflowUiStatus;
  readonly elapsed: string;
  readonly limits: string;
  readonly outcome?: string;
  readonly progress?: string;
}

export const activeWorkflowLines: (
  items: ReadonlyArray<WorkflowUiItem>,
) => string[] = (items) => {
  const running = items.filter(({ status }) => status === "running");
  if (running.length === 0) return [];
  return [
    `Workflows: ${running.length} active · /workflows for history`,
    ...running.map(
      ({ id, label, elapsed, limits, progress }) =>
        `● ${id} · ${label} · ${elapsed} · ${limits}${progress ? ` · ${progress}` : ""}`,
    ),
  ];
};

export const activeWorkflowPanelLines = (
  items: ReadonlyArray<WorkflowUiItem>,
  width: number,
): string[] =>
  activeWorkflowLines(items).map((line) => alignChromeLine(line, width));

export const backgroundWorkflowStartedText: (
  id: string,
  label: string,
) => string = (id, label) =>
  `Started background workflow ${id}: ${label}. It owns the delegated task; keep the foreground focused and do not duplicate that work unless the workflow fails or the user reprioritizes it. Use /workflows status, /workflows result ${id}, or /workflows cancel ${id}.`;

export const workflowHistoryText: (
  items: ReadonlyArray<WorkflowUiItem>,
) => string = (items) => {
  if (items.length === 0)
    return "No background workflow history in this session.";
  return items
    .flatMap((item) => {
      const icon = {
        running: "●",
        completed: "✓",
        failed: "✕",
        cancelled: "◌",
      }[item.status];
      const summary = `${icon} ${item.id} · ${item.status} · ${item.label} · ${item.elapsed} · ${item.limits}`;
      return item.outcome
        ? [summary, `  ${compactOutcome(item.outcome)}`]
        : [summary];
    })
    .join("\n");
};

const compactOutcome: (outcome: string) => string = (outcome) => {
  const singleLine = outcome.replace(/\s+/g, " ").trim();
  return singleLine.length <= 240
    ? singleLine
    : `${singleLine.slice(0, 237)}...`;
};
