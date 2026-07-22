import { basename, isAbsolute, join } from "node:path";

export const isSafeHandoffName: (name: string) => boolean = (name) =>
  basename(name) === name &&
  !name.startsWith(".") &&
  name.endsWith(".md") &&
  /(?:pi|handoff)/i.test(name);

export const parseSeenHandoffNames: (value: unknown) => string[] = (value) => {
  if (typeof value !== "object" || value === null || !("names" in value) || !Array.isArray(value.names)) return [];
  return value.names.every((name) => typeof name === "string" && isSafeHandoffName(name)) ? value.names : [];
};

export const unseenHandoffNames: (names: readonly string[], seen: ReadonlySet<string>) => string[] = (names, seen) =>
  names.filter((name) => isSafeHandoffName(name) && !seen.has(name)).sort();

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
