import { dirname, isAbsolute, relative, sep } from "node:path"

export const HOST_MIGRATION_DRAFT_ENV = "PI_HOST_MIGRATION_EDITOR_DRAFT"
export const HOST_MIGRATION_RESUME_ENV = "PI_HOST_MIGRATION_RESUME"

const belongsToRoot = (candidate: string, root: string): boolean => {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) &&
      fromRoot !== ".." &&
      !isAbsolute(fromRoot))
  )
}

export const piPackageRoot = (entrypoint: string): string =>
  dirname(dirname(entrypoint))

export const isInteractiveHostRuntime = ({
  mode,
  stdinIsTTY,
  stdoutIsTTY,
}: {
  readonly mode: string | undefined
  readonly stdinIsTTY: boolean | undefined
  readonly stdoutIsTTY: boolean | undefined
}): boolean =>
  mode === "tui" ||
  (mode === undefined && stdinIsTTY === true && stdoutIsTTY === true)

export const needsManagedHostMigration = (input: {
  readonly currentEntrypoint: string
  readonly stableEntrypoint: string
}): boolean => {
  const currentRoot = piPackageRoot(input.currentEntrypoint)
  const stableRoot = piPackageRoot(input.stableEntrypoint)
  const currentIsManagedNixHost =
    isAbsolute(input.currentEntrypoint) &&
    currentRoot.startsWith(`${sep}nix${sep}store${sep}`)
  return (
    currentIsManagedNixHost &&
    !belongsToRoot(input.currentEntrypoint, stableRoot)
  )
}

export const verifiedHostArtifacts = (input: {
  readonly launcher: string
  readonly expectedWrappedEntrypoint: string
  readonly tui: string
  readonly mainScreen: string
}): boolean =>
  input.launcher.includes(input.expectedWrappedEntrypoint) &&
  input.tui.includes("renderSafely()") &&
  input.tui.includes("this.renderSafely();") &&
  input.mainScreen.includes("const pending = [root];")

export const hostMigrationArgv = (
  stableEntrypoint: string,
  sessionFile: string,
): string[] => [stableEntrypoint, "--session", sessionFile]

export const hostMigrationEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  editorDraft: string,
  resume: boolean,
): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ),
  [HOST_MIGRATION_DRAFT_ENV]: editorDraft,
  ...(resume ? { [HOST_MIGRATION_RESUME_ENV]: "1" } : {}),
})
