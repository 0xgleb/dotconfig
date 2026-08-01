import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTIFACT_PROVENANCE_ENTRY,
  artifactPaths,
  canonicalRepositoryScratchArtifactPath,
  canonicalScratchArtifactPath,
  decodeArtifactProvenanceState,
  emptyArtifactProvenanceState,
  forgetArtifact,
  recordArtifact,
  restoreArtifactProvenance,
} from "./artifact-provenance.ts";

test("artifact provenance accepts only canonical project scratch children", () => {
  const cwd = "/workspace/project";
  assert.equal(canonicalScratchArtifactPath(cwd, ".tmp/report.json"), "/workspace/project/.tmp/report.json");
  assert.equal(canonicalScratchArtifactPath(cwd, ".tmp"), undefined);
  assert.equal(canonicalScratchArtifactPath(cwd, "../project-other/.tmp/report.json"), undefined);
  assert.equal(canonicalScratchArtifactPath(cwd, "src/index.ts"), undefined);
});

test("artifact provenance accepts scratch children beneath an evidenced nested repository", () => {
  assert.equal(
    canonicalScratchArtifactPath(
      "/workspace",
      "/workspace/nested-repo/.tmp/report.json",
      "/workspace/nested-repo",
    ),
    "/workspace/nested-repo/.tmp/report.json",
  );
  assert.equal(
    canonicalScratchArtifactPath(
      "/workspace",
      "/outside/nested-repo/.tmp/report.json",
      "/outside/nested-repo",
    ),
    undefined,
  );
});

test("explicit cross-workspace routing accepts only absolute children of the evidenced repository scratch root", () => {
  assert.equal(
    canonicalRepositoryScratchArtifactPath(
      "/workspace/rainlanguage/raindex/.tmp/reviews/pr-2827",
      "/workspace/rainlanguage/raindex",
    ),
    "/workspace/rainlanguage/raindex/.tmp/reviews/pr-2827",
  );
  assert.equal(
    canonicalRepositoryScratchArtifactPath(
      "/workspace/rainlanguage/raindex/.tmp",
      "/workspace/rainlanguage/raindex",
    ),
    undefined,
  );
  assert.equal(
    canonicalRepositoryScratchArtifactPath(
      "/workspace/other/.tmp/reviews/pr-2827",
      "/workspace/rainlanguage/raindex",
    ),
    undefined,
  );
  assert.equal(
    canonicalRepositoryScratchArtifactPath(
      ".tmp/reviews/pr-2827",
      "/workspace/rainlanguage/raindex",
    ),
    undefined,
  );
});

test("artifact provenance persists defensively and forgets exact paths", () => {
  const recorded = recordArtifact(emptyArtifactProvenanceState, {
    path: "/workspace/project/.tmp/report.json",
    recordedAt: 42,
  });
  assert.deepEqual(artifactPaths(recorded), ["/workspace/project/.tmp/report.json"]);
  assert.deepEqual(
    restoreArtifactProvenance([{ type: "custom", customType: ARTIFACT_PROVENANCE_ENTRY, data: recorded }]),
    recorded,
  );
  assert.deepEqual(forgetArtifact(recorded, "/workspace/project/.tmp/report.json"), emptyArtifactProvenanceState);
  assert.equal(decodeArtifactProvenanceState({ artifacts: [{ path: "relative", recordedAt: 42 }] }), undefined);
});
