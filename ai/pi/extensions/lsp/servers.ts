import { access, realpath } from "node:fs/promises"
import { dirname, extname, join, relative, resolve } from "node:path"
import { Data, Effect } from "effect"

export interface ServerProfile {
  readonly id: "typescript" | "rust" | "nix"
  readonly command: string
  readonly args: readonly string[]
  readonly extensions: readonly string[]
  readonly rootMarkers: readonly string[]
  readonly languageId: (path: string) => string
}

export class ServerSelectionError extends Data.TaggedError(
  "ServerSelectionError",
)<{
  readonly code: "unsupported_file" | "outside_workspace" | "root_not_found"
  readonly message: string
  readonly cause?: unknown
}> {}

const typescriptLanguageId = (path: string): string => {
  const extension = extname(path).toLowerCase()
  if (extension === ".tsx") return "typescriptreact"
  if (extension === ".jsx") return "javascriptreact"
  if ([".js", ".mjs", ".cjs"].includes(extension)) return "javascript"
  return "typescript"
}

export const SERVER_PROFILES: readonly ServerProfile[] = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    languageId: typescriptLanguageId,
  },
  {
    id: "rust",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    rootMarkers: ["rust-analyzer.toml", "Cargo.toml"],
    languageId: () => "rust",
  },
  {
    id: "nix",
    command: "nixd",
    args: [],
    extensions: [".nix"],
    rootMarkers: ["flake.nix", "default.nix", "shell.nix"],
    languageId: () => "nix",
  },
]

const isContainedByOrEqual = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate)
  return child === "" || (!child.startsWith("..") && !child.startsWith("/"))
}

export const profileForFile = (file: string): ServerProfile | undefined => {
  const extension = extname(file).toLowerCase()
  return SERVER_PROFILES.find(profile => profile.extensions.includes(extension))
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export const selectServer = (input: {
  readonly cwd: string
  readonly file: string
}): Effect.Effect<
  {
    readonly profile: ServerProfile
    readonly root: string
    readonly file: string
  },
  ServerSelectionError
> =>
  Effect.gen(function* () {
    const [cwd, file] = yield* Effect.all([
      Effect.tryPromise({
        try: () => realpath(resolve(input.cwd)),
        catch: cause =>
          new ServerSelectionError({
            code: "root_not_found",
            message: "Could not resolve the LSP workspace root",
            cause,
          }),
      }),
      Effect.tryPromise({
        try: () => realpath(resolve(input.cwd, input.file)),
        catch: cause =>
          new ServerSelectionError({
            code: "root_not_found",
            message: "Could not resolve the LSP file",
            cause,
          }),
      }),
    ])
    if (!isContainedByOrEqual(cwd, file))
      return yield* Effect.fail(
        new ServerSelectionError({
          code: "outside_workspace",
          message: "LSP file must be inside the current workspace",
        }),
      )
    const profile = profileForFile(file)
    if (!profile)
      return yield* Effect.fail(
        new ServerSelectionError({
          code: "unsupported_file",
          message: `No managed language server profile for ${extname(file) || "this file"}`,
        }),
      )
    let current = dirname(file)
    while (isContainedByOrEqual(cwd, current)) {
      for (const marker of profile.rootMarkers)
        if (yield* Effect.promise(() => exists(join(current, marker))))
          return { profile, root: current, file }
      if (current === cwd) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return { profile, root: cwd, file }
  })
