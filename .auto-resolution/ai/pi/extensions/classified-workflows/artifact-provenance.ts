import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs"
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path"

export const ARTIFACT_PROVENANCE_ENTRY =
  "classified-workflows.artifact-provenance"

export interface ArtifactRecord {
  readonly path: string
  readonly recordedAt: number
}

export interface ArtifactProvenanceState {
  readonly artifacts: readonly ArtifactRecord[]
}

export const emptyArtifactProvenanceState: ArtifactProvenanceState = {
  artifacts: [],
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const decodeArtifactProvenanceState = (
  value: unknown,
): ArtifactProvenanceState | undefined => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length > 512
  )
    return undefined
  const artifacts: ArtifactRecord[] = []
  for (const artifact of value.artifacts) {
    if (
      !isRecord(artifact) ||
      typeof artifact.path !== "string" ||
      !isAbsolute(artifact.path) ||
      typeof artifact.recordedAt !== "number" ||
      !Number.isSafeInteger(artifact.recordedAt) ||
      artifact.recordedAt < 0
    ) {
      return undefined
    }
    artifacts.push({
      path: normalize(artifact.path),
      recordedAt: artifact.recordedAt,
    })
  }
  return { artifacts }
}

export const restoreArtifactProvenance = (
  entries: readonly unknown[],
): ArtifactProvenanceState => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      isRecord(entry) &&
      entry.type === "custom" &&
      entry.customType === ARTIFACT_PROVENANCE_ENTRY &&
      "data" in entry
    ) {
      return (
        decodeArtifactProvenanceState(entry.data) ??
        emptyArtifactProvenanceState
      )
    }
  }
  return emptyArtifactProvenanceState
}

const isAtOrWithin = (root: string, candidate: string): boolean => {
  const child = relative(resolve(root), resolve(candidate))
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  )
}

export const canonicalRepositoryScratchArtifactPath = (
  candidate: string,
  repositoryRoot: string,
): string | undefined => {
  if (!isAbsolute(candidate)) return undefined
  const scratchRoot = resolve(repositoryRoot, ".tmp")
  const canonical = resolve(candidate)
  const child = relative(scratchRoot, canonical)
  return child &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
    ? canonical
    : undefined
}

export const canonicalScratchArtifactPath = (
  cwd: string,
  candidate: string,
  repositoryRoot = cwd,
): string | undefined => {
  if (!isAtOrWithin(cwd, repositoryRoot)) return undefined
  return canonicalRepositoryScratchArtifactPath(
    resolve(cwd, candidate),
    repositoryRoot,
  )
}

export const repositoryRootCandidateForScratchArtifact = (
  candidate: string,
): string | undefined => {
  if (!isAbsolute(candidate)) return undefined
  let current = resolve(candidate)
  while (dirname(current) !== current) {
    if (current.endsWith(`${sep}.tmp`)) return dirname(current)
    current = dirname(current)
  }
  return undefined
}

export type ArtifactDirectoryCreationValidation =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string }

export const validateArtifactDirectoryCreationPath = (
  candidate: string,
  repositoryRoot: string,
): ArtifactDirectoryCreationValidation => {
  const canonical = canonicalRepositoryScratchArtifactPath(
    candidate,
    repositoryRoot,
  )
  if (!canonical) {
    return {
      ok: false,
      error: "artifact directory must be beneath repository .tmp",
    }
  }
  const scratchRoot = resolve(repositoryRoot, ".tmp")
  const child = relative(scratchRoot, canonical)
  const ancestors = [
    scratchRoot,
    ...child
      .split(sep)
      .map((_segment, index, segments) =>
        join(scratchRoot, ...segments.slice(0, index + 1)),
      ),
  ]
  try {
    for (const ancestor of ancestors) {
      if (!existsSync(ancestor)) continue
      const stat = lstatSync(ancestor)
      if (stat.isSymbolicLink()) {
        return {
          ok: false,
          error: "artifact creation ancestors must not be symbolic links",
        }
      }
      if (!stat.isDirectory()) {
        return {
          ok: false,
          error: "artifact creation ancestors must be directories",
        }
      }
    }
  } catch {
    return { ok: false, error: "artifact creation ancestor validation failed" }
  }
  return { ok: true, path: canonical }
}

export const createArtifactDirectory = (
  candidate: string,
  repositoryRoot: string,
): ArtifactDirectoryCreationValidation => {
  const validation = validateArtifactDirectoryCreationPath(
    candidate,
    repositoryRoot,
  )
  if (!validation.ok) return validation
  try {
    mkdirSync(validation.path, { recursive: true })
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "artifact directory creation failed",
    }
  }
  return validation
}

export type ExistingArtifactValidation =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string }

export const validateExistingArtifact = (
  candidate: string,
  repositoryRoot: string,
  runtimeStartedAt: number,
): ExistingArtifactValidation => {
  try {
    const stat = lstatSync(candidate)
    if (stat.isSymbolicLink()) {
      return { ok: false, error: "artifact must not be a symbolic link" }
    }
    const scratchRoot = realpathSync(resolve(repositoryRoot, ".tmp"))
    const actual = realpathSync(candidate)
    const child = relative(scratchRoot, actual)
    if (!child || child === ".." || child.startsWith(`..${sep}`)) {
      return { ok: false, error: "artifact resolves outside project .tmp" }
    }
    const createdAt = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs
    if (createdAt < runtimeStartedAt - 5_000) {
      return {
        ok: false,
        error:
          "artifact predates the current runtime and cannot be claimed automatically",
      }
    }
    return { ok: true, path: actual }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "artifact validation failed",
    }
  }
}

export const recordArtifact = (
  state: ArtifactProvenanceState,
  artifact: ArtifactRecord,
): ArtifactProvenanceState => ({
  artifacts: [
    ...state.artifacts.filter(({ path }) => path !== artifact.path),
    artifact,
  ].slice(-512),
})

export const forgetArtifact = (
  state: ArtifactProvenanceState,
  path: string,
): ArtifactProvenanceState => ({
  artifacts: state.artifacts.filter(artifact => artifact.path !== path),
})

export const artifactPaths = (
  state: ArtifactProvenanceState,
): readonly string[] => state.artifacts.map(({ path }) => path)
