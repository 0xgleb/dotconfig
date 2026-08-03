export interface ToolController {
  readonly getActiveTools: () => string[];
  readonly setActiveTools: (tools: string[]) => void;
}

export interface CapabilityRestoreResult {
  readonly status: "restored" | "recovered" | "failed";
  readonly recoveryAttempts: 0 | 1;
  readonly expectedTools: readonly string[];
  readonly activeTools: readonly string[];
}

export interface RemoteToolGuard {
  readonly priorTools: readonly string[];
  readonly enforce: () => void;
  readonly restore: () => CapabilityRestoreResult;
}

const sameTools = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left]
    .sort()
    .every((tool, index) => tool === sortedRight[index]);
};

export const enterRemoteToolGuard = (controller: ToolController): RemoteToolGuard => {
  const priorTools = [...controller.getActiveTools()];
  let restored = false;
  let restoreResult: CapabilityRestoreResult | undefined;
  const enforce = (): void => {
    if (!restored) controller.setActiveTools([]);
  };
  const restore = (): CapabilityRestoreResult => {
    if (restoreResult) return restoreResult;
    if (!restored) {
      restored = true;
      controller.setActiveTools([...priorTools]);
    }
    const restoredTools = [...controller.getActiveTools()];
    if (sameTools(restoredTools, priorTools)) {
      restoreResult = {
        status: "restored",
        recoveryAttempts: 0,
        expectedTools: priorTools,
        activeTools: restoredTools,
      };
      return restoreResult;
    }

    controller.setActiveTools([...priorTools]);
    const recoveredTools = [...controller.getActiveTools()];
    restoreResult = {
      status: sameTools(recoveredTools, priorTools) ? "recovered" : "failed",
      recoveryAttempts: 1,
      expectedTools: priorTools,
      activeTools: recoveredTools,
    };
    return restoreResult;
  };
  enforce();
  return { priorTools, enforce, restore };
};
