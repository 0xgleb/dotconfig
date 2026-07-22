import { basename, isAbsolute, join } from "node:path";

export const isSafeHandoffName: (name: string) => boolean = (name) =>
  basename(name) === name && !name.startsWith(".") && name.endsWith(".md");

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
