import { createHash } from "node:crypto"
import { sanitizeProcessDiagnostic } from "./protocol.ts"
import {
  runtimeCommandLocationForSubject,
  unsafeRuntimeCommandLocationBlockReason,
  type RuntimeCommandLocation,
} from "./project-context.ts"

const FIELD_PATTERN =
  /"(id|login|isResolved|databaseId|number|url)"\s*:\s*("(?:[^"\\]|\\.)*"|true|false|null|-?\d+)/gi

export const boundedExecutionEvidence = (
  text: string,
  maxCharacters = 4_000,
): string => {
  const sanitized = sanitizeProcessDiagnostic(text).replace(/\s+/g, " ").trim()
  if (sanitized.length <= maxCharacters) return sanitized

  const fields: string[] = []
  for (const match of sanitized.matchAll(FIELD_PATTERN)) {
    fields.push(`${match[1]}=${match[2]}`)
    if (fields.length >= 120) break
  }
  const structured =
    fields.length > 0 ? ` [structured fields: ${fields.join(", ")}]` : ""
  if (structured) {
    const structuredTail = structured.slice(0, Math.max(0, maxCharacters - 64))
    const headLimit = Math.max(
      0,
      Math.min(192, maxCharacters - structuredTail.length - 24),
    )
    return `${sanitized.slice(0, headLimit)} …[bounded]${structuredTail}`.slice(
      0,
      maxCharacters,
    )
  }
  const half = Math.max(0, Math.floor((maxCharacters - 24) / 2))
  return `${sanitized.slice(0, half)} …[bounded] ${sanitized.slice(-half)}`.slice(
    0,
    maxCharacters,
  )
}

const EVIDENCE_STOP_WORDS = new Set([
  "action",
  "bash",
  "command",
  "content",
  "false",
  "input",
  "inputdigest",
  "result",
  "scope",
  "snapshot",
  "status",
  "success",
  "toolname",
  "true",
])

const evidenceTerms = (value: unknown): ReadonlySet<string> => {
  const serialized = JSON.stringify(value)?.toLowerCase() ?? ""
  const terms = (serialized.match(/[a-z0-9_./:#-]{4,}/g) ?? [])
    .map(term => term.replace(/^[-./:#]+|[-./:#]+$/g, ""))
    .filter(term => term.length >= 4 && !EVIDENCE_STOP_WORDS.has(term))
  return new Set(
    terms.flatMap(term => [
      term,
      ...term
        .split(/[./:#_-]+/g)
        .filter(
          component =>
            component.length >= 4 && !EVIDENCE_STOP_WORDS.has(component),
        ),
    ]),
  )
}

const focusedEvidenceTerms = (value: unknown): readonly string[] => {
  const serialized = JSON.stringify(value)?.toLowerCase() ?? ""
  return [
    ...new Set(
      (serialized.match(/[a-z0-9_./:#-]{3,}/g) ?? [])
        .map(term => term.replace(/^[-./:#]+|[-./:#]+$/g, ""))
        .filter(term => term.length >= 3 && !EVIDENCE_STOP_WORDS.has(term)),
    ),
  ].sort((left, right) => right.length - left.length)
}

/** Preserve the parts of a large result that share exact anchors with the proposed action. */
export const boundedRelevantExecutionEvidence = (
  text: string,
  subject: unknown,
  maxCharacters = 4_000,
): string => {
  const sanitized = sanitizeProcessDiagnostic(text).replace(/\s+/g, " ").trim()
  if (sanitized.length <= maxCharacters) return sanitized
  const lower = sanitized.toLowerCase()
  const windows: Array<{ start: number; end: number }> = []
  for (const term of focusedEvidenceTerms(subject)) {
    let offset = 0
    while (windows.length < 8) {
      const index = lower.indexOf(term, offset)
      if (index < 0) break
      const start = Math.max(0, index - 180)
      const end = Math.min(sanitized.length, index + term.length + 220)
      if (!windows.some(window => start <= window.end && end >= window.start))
        windows.push({ start, end })
      offset = index + term.length
    }
    if (windows.length >= 8) break
  }
  if (windows.length === 0)
    return boundedExecutionEvidence(sanitized, maxCharacters)
  const focused = windows
    .sort((left, right) => left.start - right.start)
    .map(({ start, end }) => sanitized.slice(start, end))
    .join(" … ")
  return `…[subject-focused] ${focused}`.slice(0, maxCharacters)
}

const canonicalInput: (value: unknown) => unknown = value => {
  if (Array.isArray(value)) return value.map(canonicalInput)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalInput(entry)]),
  )
}

export const toolInputDigest: (toolName: string, input: unknown) => string = (
  toolName,
  input,
) =>
  createHash("sha256")
    .update(toolName)
    .update("\0")
    .update(JSON.stringify(canonicalInput(input)) ?? "undefined")
    .digest("hex")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const missingInstructionPaths = (reason: string): readonly string[] => {
  if (
    !/(?:not|never|without|must|needs?\s+to).{0,48}(?:read|load(?:ed)?)|(?:read|load(?:ed)?).{0,48}(?:missing|required)/i.test(
      reason,
    )
  )
    return []
  return [
    ...new Set(
      (reason.match(/[a-z0-9._/-]+\/(?:AGENTS|SKILL)\.md/gi) ?? []).map(path =>
        path.replaceAll("\\", "/"),
      ),
    ),
  ]
}

/** A typed successful read of the exact named instruction file disproves only a classifier claim that it was unread. */
export const currentInstructionReadDisprovesMissingReadBlock = ({
  reason,
  branch,
}: {
  readonly reason: string
  readonly branch: readonly unknown[]
}): boolean => {
  const missingPaths = missingInstructionPaths(reason)
  if (missingPaths.length === 0) return false

  const readPathsByCallId = new Map<string, string>()
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message") continue
    const message = entry.message
    if (!isRecord(message) || message.role !== "assistant") continue
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (
        !isRecord(part) ||
        part.type !== "toolCall" ||
        typeof part.id !== "string" ||
        (part.name !== "read" && part.name !== "functions.read") ||
        !isRecord(part.arguments) ||
        typeof part.arguments.path !== "string"
      )
        continue
      readPathsByCallId.set(part.id, part.arguments.path.replaceAll("\\", "/"))
    }
  }

  return branch.some(entry => {
    if (!isRecord(entry) || entry.type !== "message") return false
    const message = entry.message
    if (
      !isRecord(message) ||
      message.role !== "toolResult" ||
      message.isError !== false ||
      typeof message.toolCallId !== "string"
    )
      return false
    const readPath = readPathsByCallId.get(message.toolCallId)
    return (
      readPath !== undefined &&
      missingPaths.some(missingPath => readPath.endsWith(missingPath))
    )
  })
}

export interface ToolResultExecutionEvidenceInput {
  readonly toolName: unknown
  readonly text: string
  readonly isError: unknown
  readonly input?: unknown
  readonly inputDigest?: string
  readonly subject: unknown
  readonly scope?: string
  readonly maxCharacters?: number
}

type VerificationTargetCoverage = "all" | "lib" | "default" | `custom-${string}`
type VerificationFeatureCoverage = "all" | "default" | `custom-${string}`
type VerificationPackageCoverage = "workspace" | readonly string[]

interface VerificationDescriptor {
  readonly kind: "cargo-test" | "cargo-clippy"
  readonly packages: VerificationPackageCoverage
  readonly targets: VerificationTargetCoverage
  readonly features: VerificationFeatureCoverage
  readonly focus: readonly string[]
  readonly scope: string
}

const boundedShellWords = (command: string): readonly string[] | undefined => {
  if (command.length === 0 || command.length > 4_000) return undefined
  const words: string[] = []
  let current = ""
  let quote: "single" | "double" | undefined
  let started = false
  const finishWord = (): boolean => {
    if (!started) return true
    if (current.length > 512 || words.length >= 128) return false
    words.push(current)
    current = ""
    started = false
    return true
  }
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? ""
    if (quote === "single") {
      if (character === "'") quote = undefined
      else current += character
      started = true
      continue
    }
    if (quote === "double") {
      if (character === '"') {
        quote = undefined
        started = true
        continue
      }
      if (character === "$" || character === "`") return undefined
      if (character === "\\") {
        const next = command[index + 1]
        if (next === undefined || next === "\n" || next === "\r")
          return undefined
        current += next
        started = true
        index += 1
        continue
      }
      current += character
      started = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character === "'" ? "single" : "double"
      started = true
      continue
    }
    if (character === " " || character === "\t") {
      if (!finishWord()) return undefined
      continue
    }
    if (
      /[;&|<>\n\r`$*?\[\]{}()]/u.test(character) ||
      (character === "#" && !started) ||
      (character === "~" && !started)
    )
      return undefined
    if (character === "\\") {
      const next = command[index + 1]
      if (next === undefined || next === "\n" || next === "\r") return undefined
      current += next
      started = true
      index += 1
      continue
    }
    current += character
    started = true
  }
  return quote || !finishWord() ? undefined : words
}

const cargoArguments = (command: string): readonly string[] | undefined => {
  const words = boundedShellWords(command)
  if (!words) return undefined
  const executable = words[0] ?? ""
  if (executable === "cargo") return words.slice(1)
  if (
    executable === "direnv" &&
    words[1] === "exec" &&
    words[2] === "." &&
    words[3] === "cargo"
  )
    return words.slice(4)
  if (executable !== "nix" || words[1] !== "develop") return undefined
  const commandIndex = words.indexOf("--command", 2)
  if (commandIndex < 2 || words[commandIndex + 1] !== "cargo") return undefined
  let flakeReferenceSeen = false
  for (const argument of words.slice(2, commandIndex)) {
    if (argument === "--impure") continue
    if (!argument.startsWith("-") && !flakeReferenceSeen) {
      flakeReferenceSeen = true
      continue
    }
    return undefined
  }
  return words.slice(commandIndex + 2)
}

const cargoSelectionIsCovered = (
  kind: "cargo-test" | "cargo-clippy",
  args: readonly string[],
): boolean => {
  const flags = new Set([
    "--workspace",
    "--all-targets",
    "--lib",
    "--all-features",
    "--no-default-features",
    "--bins",
    "--tests",
    "--benches",
    "--examples",
    "--doc",
  ])
  const valueOptions = new Set([
    "-p",
    "--package",
    "--features",
    "-F",
    "--bin",
    "--test",
    "--bench",
    "--example",
    ...(kind === "cargo-test" ? ["-E", "--filter-expr"] : []),
  ])
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ""
    if (flags.has(argument)) continue
    if (valueOptions.has(argument)) {
      if (!args[index + 1]) return false
      index += 1
      continue
    }
    if (
      /^(?:-p|--package=|-F)[A-Za-z0-9_-]+$/u.test(argument) ||
      /^--features=[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*$/u.test(argument) ||
      /^--(?:bin|test|bench|example)=[A-Za-z0-9_-]+$/u.test(argument) ||
      (kind === "cargo-test" && /^--filter-expr=\S+$/u.test(argument))
    )
      continue
    return false
  }
  return true
}

const customDigest = (values: readonly string[]): string =>
  createHash("sha256").update(values.join("\0")).digest("hex").slice(0, 16)

const selectedPackages = (
  args: readonly string[],
): VerificationPackageCoverage | undefined => {
  const packages: string[] = []
  let workspace = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ""
    if (argument === "--workspace") {
      workspace = true
      continue
    }
    if (argument === "--exclude" || argument.startsWith("--exclude="))
      return undefined
    if (argument === "-p" || argument === "--package") {
      const packageName = args[index + 1]
      if (!packageName || !/^[A-Za-z0-9_-]+$/u.test(packageName))
        return undefined
      packages.push(packageName)
      index += 1
      continue
    }
    const packageName = /^(?:-p|--package=)([A-Za-z0-9_-]+)$/u.exec(
      argument,
    )?.[1]
    if (packageName) packages.push(packageName)
    else if (argument.startsWith("-p") || argument.startsWith("--package="))
      return undefined
  }
  if (workspace && packages.length > 0) return undefined
  if (workspace) return "workspace"
  return packages.length > 0 ? [...new Set(packages)].sort() : undefined
}

const selectedTargets = (
  args: readonly string[],
): VerificationTargetCoverage | undefined => {
  if (args.includes("--all-targets")) return "all"
  const includesLibrary = args.includes("--lib")
  const custom: string[] = []
  const selectors = new Set(["--bin", "--test", "--bench", "--example"])
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ""
    if (
      ["--bins", "--tests", "--benches", "--examples", "--doc"].includes(
        argument,
      )
    ) {
      custom.push(argument)
      continue
    }
    if (selectors.has(argument)) {
      const value = args[index + 1]
      if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) return undefined
      custom.push(`${argument}=${value}`)
      index += 1
      continue
    }
    if (/^--(?:bin|test|bench|example)=/u.test(argument)) {
      if (!/^--(?:bin|test|bench|example)=[A-Za-z0-9_-]+$/u.test(argument))
        return undefined
      custom.push(argument)
    }
  }
  if (custom.length > 0) {
    const selection = includesLibrary ? [...custom, "--lib"] : custom
    return `custom-${customDigest(selection.toSorted())}`
  }
  return includesLibrary ? "lib" : "default"
}

const selectedFeatures = (
  args: readonly string[],
): VerificationFeatureCoverage | undefined => {
  const allFeatures = args.includes("--all-features")
  const noDefaultFeatures = args.includes("--no-default-features")
  const features: string[] = []
  if (noDefaultFeatures) features.push("mode:no-default-features")
  let featureSelectorSeen = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ""
    let value: string | undefined
    if (argument === "--features" || argument === "-F") {
      featureSelectorSeen = true
      value = args[index + 1]
      index += 1
    } else {
      const inline = /^(?:--features=|-F)(.+)$/u.exec(argument)?.[1]
      if (inline) {
        featureSelectorSeen = true
        value = inline
      }
    }
    if (value) {
      const selected = value.split(/[\s,]+/u).filter(Boolean)
      if (
        selected.length === 0 ||
        selected.some(feature => !/^[A-Za-z0-9_-]+$/u.test(feature))
      )
        return undefined
      features.push(...selected.map(feature => `feature:${feature}`))
    }
  }
  if (featureSelectorSeen && features.length === 0) return undefined
  if (allFeatures)
    return featureSelectorSeen || noDefaultFeatures ? undefined : "all"
  return features.length > 0
    ? `custom-${customDigest([...new Set(features)].sort())}`
    : "default"
}

const cargoVerificationDescriptor = (
  command: string,
  scope: string,
): VerificationDescriptor | undefined => {
  const args = cargoArguments(command)
  if (!args) return undefined
  const kind =
    args[0] === "clippy"
      ? "cargo-clippy"
      : args[0] === "nextest" && args[1] === "run"
        ? "cargo-test"
        : undefined
  if (!kind) return undefined
  const verificationArgs = args.slice(kind === "cargo-test" ? 2 : 1)
  const separator = verificationArgs.indexOf("--")
  const selectionArgs =
    separator < 0 ? verificationArgs : verificationArgs.slice(0, separator)
  const compilerArgs =
    separator < 0 ? [] : verificationArgs.slice(separator + 1)
  if (
    !cargoSelectionIsCovered(kind, selectionArgs) ||
    (kind === "cargo-test" && compilerArgs.length > 0) ||
    (kind === "cargo-clippy" &&
      (compilerArgs.length !== 2 ||
        compilerArgs[0] !== "-D" ||
        compilerArgs[1] !== "warnings"))
  )
    return undefined
  const packages = selectedPackages(selectionArgs)
  const targets = selectedTargets(selectionArgs)
  const features = selectedFeatures(selectionArgs)
  if (!packages || !targets || !features) return undefined
  const filters = selectionArgs.flatMap((argument, index) => {
    if (argument === "-E" || argument === "--filter-expr")
      return selectionArgs[index + 1] ? [selectionArgs[index + 1]] : []
    return argument.startsWith("--filter-expr=")
      ? [argument.slice("--filter-expr=".length)]
      : []
  })
  if (filters.length > 1) return undefined
  const filter = filters[0]
  const focus =
    kind === "cargo-test" && filter
      ? filter.split("|").flatMap(atom => {
          const match = /^\s*test\(([A-Za-z0-9_.:-]+)\)\s*$/u.exec(atom)
          return match?.[1] ? [match[1]] : []
        })
      : []
  if (
    kind === "cargo-test" &&
    filter !== undefined &&
    (focus.length === 0 || focus.length !== filter.split("|").length)
  )
    return undefined
  return {
    kind,
    packages,
    targets,
    features,
    focus,
    scope,
  }
}

const verificationMarker = (
  toolName: string,
  input: Readonly<Record<string, unknown>> | undefined,
  scope: string | undefined,
): string => {
  if (
    toolName.replace(/^functions\./, "") !== "bash" ||
    typeof input?.command !== "string" ||
    !scope
  )
    return ""
  const descriptor = cargoVerificationDescriptor(
    input.command,
    evidenceScopeDigest(scope),
  )
  if (!descriptor) return ""
  const packages =
    descriptor.packages === "workspace"
      ? "workspace"
      : descriptor.packages.join(",")
  return ` verification=${descriptor.kind} packages=${packages} targets=${descriptor.targets} features=${descriptor.features} focus=${descriptor.focus.join(",") || "*"}`
}

const VERIFICATION_MARKER =
  /\bverification=(cargo-test|cargo-clippy) packages=(workspace|[A-Za-z0-9_,-]+) targets=(all|lib|default|custom-[0-9a-f]{16}) features=(all|default|custom-[0-9a-f]{16}) focus=([A-Za-z0-9_.:,-]+|\*)/u

const verificationDescriptor = (
  candidate: string,
): VerificationDescriptor | undefined => {
  const inputBoundary = candidate.indexOf(" input=")
  if (inputBoundary < 0) return undefined
  const prefix = candidate.slice(0, inputBoundary)
  const marker = VERIFICATION_MARKER.exec(prefix)
  const scope = /\bscope=([0-9a-f]{16})\b/i.exec(prefix)?.[1]
  if (
    !scope ||
    !marker?.[1] ||
    !marker[2] ||
    !marker[3] ||
    !marker[4] ||
    !marker[5]
  )
    return undefined
  const targetMarker = marker[3]
  const featureMarker = marker[4]
  const targets: VerificationTargetCoverage =
    targetMarker === "all" ||
    targetMarker === "lib" ||
    targetMarker === "default"
      ? targetMarker
      : `custom-${targetMarker.slice("custom-".length)}`
  const features: VerificationFeatureCoverage =
    featureMarker === "all" || featureMarker === "default"
      ? featureMarker
      : `custom-${featureMarker.slice("custom-".length)}`
  return {
    kind: marker[1] === "cargo-clippy" ? "cargo-clippy" : "cargo-test",
    packages: marker[2] === "workspace" ? "workspace" : marker[2].split(","),
    targets,
    features,
    focus: marker[5] === "*" ? [] : marker[5].split(","),
    scope,
  }
}

const packagesCover = (
  successful: VerificationPackageCoverage,
  failed: VerificationPackageCoverage,
): boolean => {
  if (successful === "workspace") return true
  if (failed === "workspace") return false
  const successfulPackages = new Set(successful)
  return failed.every(packageName => successfulPackages.has(packageName))
}

const focusCovers = (
  successful: readonly string[],
  failed: readonly string[],
): boolean => {
  if (failed.length === 0) return successful.length === 0
  if (successful.length === 0) return true
  return failed.every(failedTerm =>
    successful.some(successfulTerm => failedTerm === successfulTerm),
  )
}

const targetCoverageIncludes = (
  successful: VerificationTargetCoverage,
  failed: VerificationTargetCoverage,
): boolean => {
  if (successful === "all") return true
  if (failed === "all") return false
  if (failed.startsWith("custom-")) return successful === failed
  if (failed === "default") return successful === "default"
  return successful === "lib" || successful === "default"
}

const featureCoverageIncludes = (
  successful: VerificationFeatureCoverage,
  failed: VerificationFeatureCoverage,
): boolean => successful === failed

const verificationCovers = (
  successful: VerificationDescriptor,
  failed: VerificationDescriptor,
): boolean =>
  successful.scope === failed.scope &&
  successful.kind === failed.kind &&
  packagesCover(successful.packages, failed.packages) &&
  targetCoverageIncludes(successful.targets, failed.targets) &&
  featureCoverageIncludes(successful.features, failed.features) &&
  focusCovers(successful.focus, failed.focus)

const sameVerificationSuite = (
  left: VerificationDescriptor,
  right: VerificationDescriptor,
): boolean =>
  left.scope === right.scope &&
  left.kind === right.kind &&
  left.targets === right.targets &&
  left.features === right.features &&
  (left.packages === "workspace" || right.packages === "workspace"
    ? left.packages === right.packages
    : left.packages.length === right.packages.length &&
      left.packages.every(packageName => right.packages.includes(packageName)))

interface StateSnapshotIdentity {
  readonly kind:
    | "git-status"
    | "git-path-status"
    | "git-index-paths"
    | "git-index-blobs"
    | "git-object-hashes"
    | "gitbutler-status"
    | "gitbutler-uncommitted"
    | "pull-request-view"
    | "registry-completion"
    | "registry-claim"
    | "registry-phase"
    | "registry-terminal"
    | "registry-version"
    | "git-current-branch"
    | "git-head"
    | "git-history"
    | "git-push"
    | "git-remote-sha"
  readonly anchor?: string
}

const FULL_REGISTRY_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isRegistryRequestSnapshotKind = (kind: string): boolean =>
  kind === "registry-claim" ||
  kind === "registry-phase" ||
  kind === "registry-terminal" ||
  kind === "registry-completion"

const hashedSnapshotAnchor = (label: string, value: string): string =>
  `${label}:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`

const boundedOnelineHistoryCount = (command: string): number | undefined => {
  const tokens = command.split(/\s+/)
  if (!/^(?:\^)?git$/i.test(tokens[0] ?? "") || tokens[1] !== "log")
    return undefined
  let oneline = false
  const counts: number[] = []
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ""
    if (token === "--oneline" && !oneline) {
      oneline = true
      continue
    }
    const shortCount = /^-(\d{1,2})$/.exec(token)?.[1]
    const equalsCount = /^--max-count=(\d{1,2})$/.exec(token)?.[1]
    if (shortCount || equalsCount) {
      counts.push(Number(shortCount ?? equalsCount))
      continue
    }
    if (token === "--max-count" && /^\d{1,2}$/.test(tokens[index + 1] ?? "")) {
      counts.push(Number(tokens[index + 1]))
      index += 1
      continue
    }
    return undefined
  }
  return oneline && counts.length === 1 && (counts[0] ?? 0) <= 50
    ? counts[0]
    : undefined
}

const safeRelativeStatusPaths = (
  pathspec: string,
): readonly string[] | undefined => {
  const paths = pathspec.split(/\s+/).filter(Boolean)
  return paths.length > 0 &&
    paths.every(
      path =>
        !path.startsWith("-") &&
        !path.startsWith("/") &&
        !/^[a-z]:/i.test(path) &&
        !path.split("/").includes(".."),
    )
    ? paths
    : undefined
}

const GIT_STATUS_OPTIONS = new Set([
  "--short",
  "-s",
  "--branch",
  "-b",
  "--porcelain",
  "--porcelain=v1",
  "--porcelain=v2",
  "--untracked-files=no",
  "--untracked-files=normal",
  "--untracked-files=all",
  "--ignore-submodules=none",
  "--ignore-submodules=untracked",
  "--ignore-submodules=dirty",
  "--ignore-submodules=all",
])

const gitStatusPaths = (
  command: string,
): readonly string[] | null | undefined => {
  const tokens = command.split(/\s+/)
  if (!/^(?:\^)?git$/i.test(tokens[0] ?? "") || tokens[1] !== "status")
    return undefined
  const paths: string[] = []
  let readingPaths = false
  for (const token of tokens.slice(2)) {
    if (!readingPaths && token === "--") {
      readingPaths = true
      continue
    }
    if (!readingPaths && GIT_STATUS_OPTIONS.has(token)) continue
    if (token.startsWith("-")) return undefined
    readingPaths = true
    paths.push(token)
  }
  if (paths.length === 0) return null
  return safeRelativeStatusPaths(paths.join(" "))
}

const stateSnapshotIdentity = (
  toolName: string,
  input: Readonly<Record<string, unknown>> | undefined,
  scope: string | undefined,
): StateSnapshotIdentity | undefined => {
  const normalizedToolName = toolName.replace(/^functions\./, "")
  if (normalizedToolName === "agent_registry") {
    if (
      scope &&
      typeof input?.requestId === "string" &&
      FULL_REGISTRY_REQUEST_ID.test(input.requestId) &&
      (input.action === "claim_request" ||
        input.action === "start_request" ||
        input.action === "review_request" ||
        input.action === "publish_request" ||
        input.action === "fail_request" ||
        input.action === "cancel_request")
    )
      return {
        kind:
          input.action === "claim_request"
            ? "registry-claim"
            : input.action === "fail_request" ||
                input.action === "cancel_request"
              ? "registry-terminal"
              : "registry-phase",
        anchor: `request:${input.requestId.toLowerCase()}`,
      }
    if (
      input?.action === "complete_request" &&
      typeof input.requestId === "string" &&
      FULL_REGISTRY_REQUEST_ID.test(input.requestId)
    )
      return {
        kind: "registry-completion",
        anchor: `request:${input.requestId.toLowerCase()}`,
      }
    if (
      input?.action === "list" &&
      typeof input.project === "string" &&
      input.project === scope
    )
      return {
        kind: "registry-version",
        anchor: hashedSnapshotAnchor("project", input.project),
      }
    return undefined
  }
  if (
    normalizedToolName !== "bash" ||
    typeof input?.command !== "string" ||
    !scope
  )
    return undefined
  const command = input.command.trim()
  const pinnedButStatus =
    /^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-gitbutler-cli-\d+\.\d+\.\d+\/bin\/but status --json( \| from json \| get uncommittedChanges \| to json)?$/.exec(
      command,
    )
  if (pinnedButStatus)
    return {
      kind: pinnedButStatus[1] ? "gitbutler-uncommitted" : "gitbutler-status",
    }
  if (
    command ===
    "but status --json | from json | get uncommittedChanges | to json"
  )
    return { kind: "gitbutler-uncommitted" }
  if (!/^[a-z0-9_./,:#= -]+$/i.test(command)) return undefined
  const statusPaths = gitStatusPaths(command)
  if (statusPaths === null) return { kind: "git-status" }
  if (statusPaths)
    return {
      kind: "git-path-status",
      anchor: `paths:${createHash("sha256").update(statusPaths.join("\0")).digest("hex").slice(0, 16)}`,
    }
  if (/^git\s+diff\s+--(?:cached|staged)\s+--name-only$/i.test(command))
    return { kind: "git-index-paths" }
  if (
    /^git\s+diff\s+--(?:cached|staged)\s+--raw\s+--abbrev=(?:40|64)$/i.test(
      command,
    )
  )
    return { kind: "git-index-blobs" }
  const hashPaths = /^git\s+hash-object\s+(.+)$/i.exec(command)?.[1]
  if (hashPaths && safeRelativeStatusPaths(hashPaths))
    return {
      kind: "git-object-hashes",
      anchor: hashedSnapshotAnchor("paths", hashPaths),
    }
  if (/^(?:\^)?but\s+status(?:\s+[^;&|`<>\n]+)?$/i.test(command))
    return { kind: "gitbutler-status" }
  if (/^(?:\^)?git\s+branch\s+--show-current$/i.test(command))
    return { kind: "git-current-branch" }
  if (/^(?:\^)?git\s+rev-parse(?:\s+--verify)?\s+HEAD$/i.test(command))
    return { kind: "git-head" }
  if (boundedOnelineHistoryCount(command) !== undefined)
    return { kind: "git-history" }
  if (
    /^(?:\^)?git\s+push(?:\s+(?:-u|--set-upstream))?\s+[a-z0-9_][a-z0-9_.-]*\s+[a-z0-9_][a-z0-9_./-]*$/i.test(
      command,
    )
  )
    return {
      kind: "git-push",
      anchor: hashedSnapshotAnchor("command", command),
    }
  if (
    /^(?:\^)?git\s+ls-remote\s+[a-z0-9_.-]+\s+refs\/heads\/[a-z0-9_./-]+$/i.test(
      command,
    )
  )
    return {
      kind: "git-remote-sha",
      anchor: hashedSnapshotAnchor("command", command),
    }
  const pullRequest = /^(?:\^)?gh\s+pr\s+view\s+#?(\d+)\b([^;&|`<>\n]*)$/i.exec(
    command,
  )
  return pullRequest &&
    !/(?:^|\s)(?:--repo(?:\s|=)|-R(?:\s|=|\S))/i.test(pullRequest[2] ?? "")
    ? { kind: "pull-request-view", anchor: `pr:${pullRequest[1]}` }
    : undefined
}

const evidenceScopeDigest = (scope: string): string =>
  createHash("sha256").update(scope).digest("hex").slice(0, 16)

/** Preserve execution status separately from untrusted result wording. */
export const toolResultExecutionEvidence: (
  input: ToolResultExecutionEvidenceInput,
) => string = input => renderToolResultExecutionEvidence(input)

const renderToolResultExecutionEvidence: (
  input: ToolResultExecutionEvidenceInput,
  commandLocation?: RuntimeCommandLocation,
) => string = (
  {
    toolName,
    text,
    isError,
    input,
    inputDigest,
    subject,
    scope,
    maxCharacters = 2_400,
  },
  commandLocation,
) => {
  const name =
    sanitizeProcessDiagnostic(String(toolName ?? "tool"))
      .replace(/\s+/g, " ")
      .slice(0, 64) || "tool"
  const status =
    isError === true ? "error" : isError === false ? "success" : "unknown"
  const digestIdentity =
    inputDigest && /^[0-9a-f]{64}$/.test(inputDigest)
      ? ` inputDigest=${inputDigest}`
      : ""
  const inputRecord =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined
  const selectedInput = inputRecord
    ? Object.fromEntries(
        [
          "action",
          "command",
          "file_path",
          "id",
          "limit",
          "offset",
          "path",
          "project",
          "requestId",
        ]
          .filter(key => inputRecord[key] !== undefined)
          .map(key => [key, inputRecord[key]]),
      )
    : {}
  const encodedInput = sanitizeProcessDiagnostic(JSON.stringify(selectedInput))
    .replace(/\s+/g, " ")
    .slice(0, 1_000)
  const inputIdentity = encodedInput !== "{}" ? ` input=${encodedInput}` : ""
  const snapshot =
    status === "success"
      ? stateSnapshotIdentity(name, inputRecord, scope)
      : undefined
  const verification = verificationMarker(name, inputRecord, scope)
  const scopeIdentity = scope ? ` scope=${evidenceScopeDigest(scope)}` : ""
  const snapshotMarker = snapshot
    ? ` snapshot=${snapshot.kind}${snapshot.anchor ? ` anchor=${snapshot.anchor}` : ""}`
    : ""
  const commandScopeMarker =
    commandLocation && scope === commandLocation.commandCwd
      ? " commandScope=verified"
      : ""
  const evidenceText = text.trim() || "(no textual output)"
  return `${name} result status=${status}${digestIdentity}${scopeIdentity}${snapshotMarker}${commandScopeMarker}${verification}${inputIdentity}: ${boundedRelevantExecutionEvidence(evidenceText, subject, maxCharacters)}`
}

export const branchExecutionEvidence = ({
  branch,
  subject,
  scope,
  maxCharacters = 2_400,
}: {
  readonly branch: readonly unknown[]
  readonly subject: unknown
  readonly scope: string
  readonly maxCharacters?: number
}): readonly string[] => {
  const toolCalls = new Map<
    string,
    { readonly input: unknown; readonly digest: string }
  >()
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message") continue
    const message = entry.message
    if (!isRecord(message) || message.role !== "assistant") continue
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (
        !isRecord(part) ||
        part.type !== "toolCall" ||
        typeof part.id !== "string" ||
        typeof part.name !== "string"
      )
        continue
      toolCalls.set(part.id, {
        input: part.arguments,
        digest: toolInputDigest(part.name, part.arguments),
      })
    }
  }

  return branch.flatMap(entry => {
    if (!isRecord(entry) || entry.type !== "message") return []
    const message = entry.message
    if (!isRecord(message)) return []
    if (message.role === "assistant") {
      const text = Array.isArray(message.content)
        ? message.content
            .flatMap(part =>
              isRecord(part) &&
              part.type === "text" &&
              typeof part.text === "string"
                ? [part.text]
                : [],
            )
            .join("\n")
        : typeof message.content === "string"
          ? message.content
          : ""
      return text
        ? [
            `assistant report (untrusted): ${boundedRelevantExecutionEvidence(text, subject, maxCharacters)}`,
          ]
        : []
    }
    if (message.role !== "toolResult") return []
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .flatMap(part =>
                isRecord(part) &&
                part.type === "text" &&
                typeof part.text === "string"
                  ? [part.text]
                  : [],
              )
              .join("\n")
          : ""
    const toolCall =
      typeof message.toolCallId === "string"
        ? toolCalls.get(message.toolCallId)
        : undefined
    const input = isRecord(toolCall?.input) ? toolCall.input : undefined
    const commandSubject = {
      toolName: message.toolName,
      input,
    }
    if (unsafeRuntimeCommandLocationBlockReason(scope, commandSubject))
      return []
    const commandLocation = runtimeCommandLocationForSubject(
      scope,
      commandSubject,
    )
    const snapshotInput =
      input && commandLocation
        ? { ...input, command: commandLocation.command }
        : input
    return [
      renderToolResultExecutionEvidence(
        {
          toolName: message.toolName,
          text,
          isError: message.isError,
          input: snapshotInput,
          ...(toolCall?.digest ? { inputDigest: toolCall.digest } : {}),
          subject,
          scope: commandLocation?.commandCwd ?? scope,
          maxCharacters,
        },
        commandLocation,
      ),
    ]
  })
}

const successfulMutationScope = (candidate: string): string | undefined => {
  const mutation =
    /^(?:functions\.)?(?:edit|write) result status=success\b/i.test(
      candidate,
    ) ||
    (/^(?:functions\.)?lsp result status=success\b/i.test(candidate) &&
      /\binput=.*"action":"apply"/i.test(candidate))
  if (!mutation) return undefined
  return /\bscope=([0-9a-f]{16})\b/i.exec(candidate)?.[1] ?? "*"
}

const supersededFailureIndexes = (
  candidates: readonly string[],
): ReadonlySet<number> => {
  const laterSuccessfulInputs = new Set<string>()
  const laterSuccessfulVerifications: VerificationDescriptor[] = []
  const laterMutationScopes = new Set<string>()
  const superseded = new Set<number>()
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index] ?? ""
    const mutationScope = successfulMutationScope(candidate)
    if (mutationScope) laterMutationScopes.add(mutationScope)
    const match = candidate.match(
      /^\S+ result status=(success|error) inputDigest=([0-9a-f]{64})(?: scope=([0-9a-f]{16}))?\b/,
    )
    if (!match) continue
    const [, status, inputDigest, scope] = match
    if (!inputDigest || !scope) continue
    const identity = `${inputDigest}:${scope}`
    const verification = verificationDescriptor(candidate)
    if (status === "success") {
      if (laterMutationScopes.has("*") || laterMutationScopes.has(scope))
        continue
      laterSuccessfulInputs.add(identity)
      if (verification) laterSuccessfulVerifications.push(verification)
    } else if (
      laterSuccessfulInputs.has(identity) ||
      (verification &&
        laterSuccessfulVerifications.some(successful =>
          verificationCovers(successful, verification),
        ))
    )
      superseded.add(index)
  }
  return superseded
}

const STRUCTURED_RESULT_EVIDENCE =
  /^(?:functions\.)?\S+ result status=(?:success|error|unknown)\b/i

const STATE_SNAPSHOT_MARKER =
  /^(?:functions\.)?\S+ result status=success(?: inputDigest=[0-9a-f]{64})? scope=([0-9a-f]{16}) snapshot=(git-status|git-path-status|git-index-paths|git-index-blobs|git-object-hashes|gitbutler-status|gitbutler-uncommitted|pull-request-view|registry-completion|registry-claim|registry-phase|registry-terminal|registry-version|git-current-branch|git-head|git-history|git-push|git-remote-sha)(?: anchor=([a-z0-9_./:-]{1,128}))?\b/i

interface StateSnapshotMarker {
  readonly kind: string
  readonly scope: string
  readonly anchor?: string
}

const stateSnapshotMarker = (
  candidate: string,
): StateSnapshotMarker | undefined => {
  const match = STATE_SNAPSHOT_MARKER.exec(candidate)
  if (!match?.[1] || !match[2]) return undefined
  const kind = match[2].toLowerCase()
  if (
    isRegistryRequestSnapshotKind(kind) &&
    (!match[3]?.startsWith("request:") ||
      !FULL_REGISTRY_REQUEST_ID.test(match[3].slice("request:".length)) ||
      !/^(?:\s|$)/.test(candidate.slice(match[0].length)))
  )
    return undefined
  return {
    kind,
    scope: match[1].toLowerCase(),
    ...(match[3]
      ? {
          anchor: isRegistryRequestSnapshotKind(kind)
            ? match[3].toLowerCase()
            : match[3],
        }
      : {}),
  }
}

/** Keep a small recency window plus older evidence that shares concrete identifiers with the proposed boundary. */
export const selectRelevantExecutionEvidence = (
  candidates: readonly string[],
  subject: unknown,
  recentCount = 8,
  relevantCount = 8,
): readonly string[] => {
  const superseded = supersededFailureIndexes(candidates)
  const nonSupersededCandidates = candidates.filter(
    (_, index) => !superseded.has(index),
  )
  const subjectRecord = isRecord(subject) ? subject : undefined
  const subjectCwd =
    typeof subjectRecord?.cwd === "string" ? subjectRecord.cwd : undefined
  const originalSubjectInput = isRecord(subjectRecord?.input)
    ? subjectRecord.input
    : undefined
  const normalizedToolName =
    typeof subjectRecord?.toolName === "string"
      ? subjectRecord.toolName.replace(/^functions\./, "")
      : undefined
  const subjectCommand =
    typeof originalSubjectInput?.command === "string"
      ? originalSubjectInput.command
      : typeof subjectRecord?.command === "string"
        ? subjectRecord.command
        : undefined
  const isBashSubject =
    normalizedToolName === "bash" ||
    (normalizedToolName === undefined && subjectCommand !== undefined)
  const normalizedSubject =
    subjectRecord && isBashSubject && subjectCommand !== undefined
      ? {
          ...subjectRecord,
          toolName: "bash",
          input: { ...originalSubjectInput, command: subjectCommand },
        }
      : subject
  const subjectHasGitCommand =
    isBashSubject &&
    typeof subjectCommand === "string" &&
    /(?:^|[\s;&|($`])\^?(?:git|(?:[^\s;&|$()]+\/)+git)(?=[\s;&|$()]|$)/i.test(
      subjectCommand.replace(/["'\\]/g, ""),
    )
  const subjectHasUnsafeGitLocation =
    (subjectHasGitCommand && !subjectCwd) ||
    Boolean(
      subjectCwd &&
      unsafeRuntimeCommandLocationBlockReason(subjectCwd, normalizedSubject),
    )
  const subjectCommandLocation =
    subjectCwd && !subjectHasUnsafeGitLocation
      ? runtimeCommandLocationForSubject(subjectCwd, normalizedSubject)
      : undefined
  const subjectScope =
    subjectCwd && !subjectHasUnsafeGitLocation
      ? evidenceScopeDigest(subjectCommandLocation?.commandCwd ?? subjectCwd)
      : undefined
  const supersededSnapshotIndexes = new Set<number>()
  if (subjectScope) {
    const latestSnapshotIndexes = new Map<string, number>()
    const terminalRequestAnchors = new Set<string>()
    nonSupersededCandidates.forEach((candidate, index) => {
      const marker = stateSnapshotMarker(candidate)
      if (!marker || marker.scope !== subjectScope) return
      if (
        (marker.kind === "registry-claim" ||
          marker.kind === "registry-phase") &&
        marker.anchor !== undefined &&
        terminalRequestAnchors.has(marker.anchor)
      ) {
        supersededSnapshotIndexes.add(index)
        return
      }
      if (
        (marker.kind === "registry-completion" ||
          marker.kind === "registry-terminal") &&
        marker.anchor !== undefined
      ) {
        terminalRequestAnchors.add(marker.anchor)
        for (const kind of ["registry-claim", "registry-phase"]) {
          const key = `${kind}:${marker.anchor ?? "scope"}`
          const prior = latestSnapshotIndexes.get(key)
          if (prior !== undefined) supersededSnapshotIndexes.add(prior)
          latestSnapshotIndexes.delete(key)
        }
      }
      if (marker.kind === "gitbutler-status") {
        const projectionKey = "gitbutler-uncommitted:scope"
        const projection = latestSnapshotIndexes.get(projectionKey)
        if (projection !== undefined) supersededSnapshotIndexes.add(projection)
        latestSnapshotIndexes.delete(projectionKey)
      }
      const identity = `${marker.kind}:${marker.anchor ?? "scope"}`
      const prior = latestSnapshotIndexes.get(identity)
      if (prior !== undefined) supersededSnapshotIndexes.add(prior)
      latestSnapshotIndexes.set(identity, index)
    })
  }
  const currentCandidates = nonSupersededCandidates.filter(
    (candidate, index) => {
      if (supersededSnapshotIndexes.has(index)) return false
      const marker = stateSnapshotMarker(candidate)
      const declaredKind =
        STATE_SNAPSHOT_MARKER.exec(candidate)?.[2]?.toLowerCase()
      if (
        declaredKind &&
        isRegistryRequestSnapshotKind(declaredKind) &&
        !marker
      )
        return false
      if (
        marker &&
        (marker.kind === "gitbutler-uncommitted" ||
          isRegistryRequestSnapshotKind(marker.kind)) &&
        marker.scope !== subjectScope
      )
        return false
      const hasVcsCommandResult =
        /^(?:functions\.)?bash result\b.*\b(?:git|gt|but)\b/i.test(candidate)
      const verifiedCommandScope =
        /^(?:functions\.)?bash result status=(?:success|error|unknown)(?: inputDigest=[0-9a-f]{64})? scope=([0-9a-f]{16})(?: snapshot=[a-z-]+(?: anchor=[a-z0-9_./:-]{1,128})?)? commandScope=verified\b/i.exec(
          candidate,
        )?.[1]
      if (
        subjectHasUnsafeGitLocation &&
        (marker?.kind.startsWith("git") || hasVcsCommandResult)
      )
        return false
      if (
        subjectHasGitCommand &&
        hasVcsCommandResult &&
        (!subjectScope ||
          (marker?.scope !== subjectScope &&
            verifiedCommandScope !== subjectScope))
      )
        return false
      return !subjectScope || !marker || marker.scope === subjectScope
    },
  )
  const recentIndexes = new Set<number>()
  for (const structured of [true, false]) {
    const indexes = currentCandidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) =>
        structured
          ? STRUCTURED_RESULT_EVIDENCE.test(candidate)
          : !STRUCTURED_RESULT_EVIDENCE.test(candidate),
      )
      .slice(-recentCount)
      .map(({ index }) => index)
    for (const index of indexes) recentIndexes.add(index)
  }
  const terms = evidenceTerms(subject)
  const olderEntries = currentCandidates
    .map((candidate, index) => ({ candidate, currentIndex: index }))
    .filter(({ currentIndex }) => !recentIndexes.has(currentIndex))
  const olderCandidates = olderEntries.map(({ candidate }) => candidate)
  const scoredOlderCandidates = olderCandidates.map((candidate, index) => ({
    candidate,
    index,
    score: [...terms].reduce(
      (score, term) => score + (candidate.toLowerCase().includes(term) ? 1 : 0),
      0,
    ),
  }))
  const selectedOlderIndexes = new Set(
    scoredOlderCandidates
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) => right.score - left.score || right.index - left.index,
      )
      .slice(0, relevantCount)
      .map(({ index }) => index),
  )
  // Identical command text is not an identical source snapshot. Keep bounded
  // later mutation evidence beside the latest matching success, even when its
  // path shares fewer query terms than the command itself. This is chronology
  // evidence only: mutations in the caller workspace may be unrelated, and the
  // classifier must still establish relevance and independent authority.
  const subjectInputDigest = subjectRecord?.inputDigest
  if (
    subjectScope &&
    subjectCwd &&
    typeof subjectInputDigest === "string" &&
    /^[0-9a-f]{64}$/.test(subjectInputDigest)
  ) {
    let latestMatchingSuccessIndex = -1
    currentCandidates.forEach((candidate, index) => {
      const success =
        /^\S+ result status=success inputDigest=([0-9a-f]{64}) scope=([0-9a-f]{16})\b/.exec(
          candidate,
        )
      if (success?.[1] === subjectInputDigest && success[2] === subjectScope)
        latestMatchingSuccessIndex = index
    })
    // A retained pass with a different filter/wrapper still needs its later
    // edits visible. Coverage identifies the suite, not unchanged source or
    // permission to omit the project's required execution environment.
    const requestedVerification =
      isBashSubject && subjectCommand
        ? cargoVerificationDescriptor(
            subjectCommandLocation?.command ?? subjectCommand,
            subjectScope,
          )
        : undefined
    // Different later focuses do not revalidate an older focus after edits.
    // Preserve chronology for the earliest retained suite pass; an exact
    // current-command success still takes precedence above it.
    const retainedSuitePass = requestedVerification
      ? olderEntries.find(({ candidate }, index) => {
          if (
            !selectedOlderIndexes.has(index) ||
            !/^\S+ result status=success\b/.test(candidate)
          )
            return false
          const observed = verificationDescriptor(candidate)
          if (!observed) return false
          return sameVerificationSuite(observed, requestedVerification)
        })
      : undefined
    const mutationAnchorIndex =
      latestMatchingSuccessIndex >= 0
        ? latestMatchingSuccessIndex
        : (retainedSuitePass?.currentIndex ?? -1)
    if (mutationAnchorIndex >= 0) {
      const callerScope = evidenceScopeDigest(subjectCwd)
      const mutationWitnesses = olderEntries
        .map((entry, index) => ({ ...entry, index }))
        .filter(({ candidate, currentIndex }) => {
          const mutationScope = successfulMutationScope(candidate)
          return (
            currentIndex > mutationAnchorIndex &&
            (mutationScope === subjectScope || mutationScope === callerScope)
          )
        })
        .slice(-8)
      for (const { index } of mutationWitnesses) selectedOlderIndexes.add(index)
    }
  }
  const ttddRedPhaseIndexes = scoredOlderCandidates
    .filter(
      ({ candidate, score }) =>
        score > 0 &&
        /^bash result status=error\b/i.test(candidate) &&
        /\b(?:cargo\s+(?:nextest\s+run|test)|nextest\s+run|bun\s+(?:run\s+)?test|pnpm\s+test|npm\s+test|pytest)\b/i.test(
          candidate,
        ),
    )
    .slice(-4)
    .map(({ index }) => index)
  for (const index of ttddRedPhaseIndexes) selectedOlderIndexes.add(index)
  const vcsTopologyIndexes = olderCandidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) =>
      /\b(?:gt parent|git merge-base|git branch --show-current|git rev-parse --abbrev-ref)\b/i.test(
        candidate,
      ),
    )
    .slice(-4)
    .map(({ index }) => index)
  for (const index of vcsTopologyIndexes) selectedOlderIndexes.add(index)
  const instructionReadIndexes = olderCandidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) =>
      /^(?:functions\.)?read result status=success\b.*\binput=.*(?:AGENTS|SKILL)\.md/i.test(
        candidate,
      ),
    )
    .slice(-4)
    .map(({ index }) => index)
  for (const index of instructionReadIndexes) selectedOlderIndexes.add(index)
  if (subjectScope) {
    const latestSnapshotByKind = new Map<string, number>()
    const scopedSnapshotIndexes: number[] = []
    olderCandidates.forEach((candidate, index) => {
      const marker = stateSnapshotMarker(candidate)
      if (marker?.scope !== subjectScope) return
      latestSnapshotByKind.set(marker.kind, index)
      scopedSnapshotIndexes.push(index)
    })
    for (const index of latestSnapshotByKind.values())
      selectedOlderIndexes.add(index)
    for (const index of scopedSnapshotIndexes.slice(-8))
      selectedOlderIndexes.add(index)
  }
  const selectedCurrentIndexes = new Set(recentIndexes)
  olderEntries.forEach(({ currentIndex }, olderIndex) => {
    if (selectedOlderIndexes.has(olderIndex))
      selectedCurrentIndexes.add(currentIndex)
  })
  return currentCandidates.filter((_candidate, index) =>
    selectedCurrentIndexes.has(index),
  )
}
