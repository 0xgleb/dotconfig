import { readFileSync } from "node:fs"

export type PromptFile =
  | "classifier-policy.md"
  | "classifier-enforce-linked-hooks.md"
  | "classifier-enforce-main-hooks.md"
  | "classifier-hook-authority.md"
  | "classifier-request-guidance.md"
  | "manager-system.md"
  | "manager-round-summary.md"

/** Trusted repository assets, never a filename or template supplied by a model.
 * Missing assets are external I/O failures; callers' existing execution boundary
 * handles them. Do not substitute an empty or weaker policy.
 */
export const readPromptFile = (name: PromptFile): string =>
  readFileSync(
    new URL(`../../prompts/${name}`, import.meta.url),
    "utf8",
  ).trimEnd()
