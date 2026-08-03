import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

export const ARTIFACT_PROVENANCE_ENTRY = "classified-workflows.artifact-provenance";

export interface ArtifactRecord {
  readonly path: string;
  readonly recordedAt: number;
}

export interface ArtifactProvenanceState {
  readonly artifacts: readonly ArtifactRecord[];
}

export const emptyArtifactProvenanceState: ArtifactProvenanceState = { artifacts: [] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const decodeArtifactProvenanceState = (value: unknown): ArtifactProvenanceState | undefined => {
  if (!isRecord(value) || !Array.isArray(value.artifacts) || value.artifacts.length > 512) return undefined;
  const artifacts: ArtifactRecord[] = [];
  for (const artifact of value.artifacts) {
    if (
      !isRecord(artifact) ||
      typeof artifact.path !== "string" ||
      !isAbsolute(artifact.path) ||
      typeof artifact.recordedAt !== "number" ||
      !Number.isSafeInteger(artifact.recordedAt) ||
      artifact.recordedAt < 0
    ) {
      return undefined;
    }
    artifacts.push({ path: normalize(artifact.path), recordedAt: artifact.recordedAt });
  }
  return { artifacts };
};

export const restoreArtifactProvenance = (entries: readonly unknown[]): ArtifactProvenanceState => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      isRecord(entry) &&
      entry.type === "custom" &&
      entry.customType === ARTIFACT_PROVENANCE_ENTRY &&
      "data" in entry
    ) {
      return decodeArtifactProvenanceState(entry.data) ?? emptyArtifactProvenanceState;
    }
  }
  return emptyArtifactProvenanceState;
};

const isAtOrWithin = (root: string, candidate: string): boolean => {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
};

export const canonicalRepositoryScratchArtifactPath = (
  candidate: string,
  repositoryRoot: string,
): string | undefined => {
  if (!isAbsolute(candidate)) return undefined;
  const scratchRoot = resolve(repositoryRoot, ".tmp");
  const canonical = resolve(candidate);
  const child = relative(scratchRoot, canonical);
  return child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
    ? canonical
    : undefined;
};

export const canonicalScratchArtifactPath = (
  cwd: string,
  candidate: string,
  repositoryRoot = cwd,
): string | undefined => {
  if (!isAtOrWithin(cwd, repositoryRoot)) return undefined;
  return canonicalRepositoryScratchArtifactPath(
    resolve(cwd, candidate),
    repositoryRoot,
  );
};

export const recordArtifact = (
  state: ArtifactProvenanceState,
  artifact: ArtifactRecord,
): ArtifactProvenanceState => ({
  artifacts: [...state.artifacts.filter(({ path }) => path !== artifact.path), artifact].slice(-512),
});

export const forgetArtifact = (state: ArtifactProvenanceState, path: string): ArtifactProvenanceState => ({
  artifacts: state.artifacts.filter((artifact) => artifact.path !== path),
});

export const artifactPaths = (state: ArtifactProvenanceState): readonly string[] =>
  state.artifacts.map(({ path }) => path);
