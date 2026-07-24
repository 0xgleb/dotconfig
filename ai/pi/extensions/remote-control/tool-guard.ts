export interface ToolController {
  readonly getActiveTools: () => string[];
  readonly setActiveTools: (tools: string[]) => void;
}

export interface RemoteToolGuard {
  readonly priorTools: readonly string[];
  readonly enforce: () => void;
  readonly restore: () => void;
}

export const enterRemoteToolGuard = (controller: ToolController): RemoteToolGuard => {
  const priorTools = [...controller.getActiveTools()];
  let restored = false;
  const enforce = (): void => {
    if (!restored) controller.setActiveTools([]);
  };
  const restore = (): void => {
    if (restored) return;
    restored = true;
    controller.setActiveTools([...priorTools]);
  };
  enforce();
  return { priorTools, enforce, restore };
};
