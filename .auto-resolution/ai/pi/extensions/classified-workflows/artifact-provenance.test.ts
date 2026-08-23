import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
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
  validateExistingArtifact,
} from "./artifact-provenance.ts"

const extensionSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
)

test("artifact provenance accepts only canonical project scratch children", () => {
  const cwd = "/workspace/project"
  assert.equal(
    canonicalScratchArtifactPath(cwd, ".tmp/report.json"),
    "/workspace/project/.tmp/report.json",
  )
  assert.equal(canonicalScratchArtifactPath(cwd, ".tmp"), undefined)
  assert.equal(
    canonicalScratchArtifactPath(cwd, "../project-other/.tmp/report.json"),
    undefined,
  )
  assert.equal(canonicalScratchArtifactPath(cwd, "src/index.ts"), undefined)
})

test("artifact provenance accepts scratch children beneath an evidenced nested repository", () => {
  assert.equal(
    canonicalScratchArtifactPath(
      "/workspace",
      "/workspace/nested-repo/.tmp/report.json",
      "/workspace/nested-repo",
    ),
    "/workspace/nested-repo/.tmp/report.json",
  )
  assert.equal(
    canonicalScratchArtifactPath(
      "/workspace",
      "/outside/nested-repo/.tmp/report.json",
      "/outside/nested-repo",
    ),
    undefined,
  )
})

test("explicit cross-workspace routing accepts only absolute children of the evidenced repository scratch root", () => {
  assert.equal(
    canonicalRepositoryScratchArtifactPath(
      "/workspace/rainlanguage/raindex/.tmp/reviews/pr-2827",
      "/workspace/rainlanguage/raindex",
    ),
    "/workspace/rainlanguage/raindex/.tmp/reviews/pr-2827",
  )
  assert.equal(
    canonicalRepositoryScratchArtifactPath(
      "/workspace/rainlanguage/raindex/.tmp",
      "/workspace/rainlanguage/raindex",
    ),
    undefined,
  )
  assert.equal(
    canonicalRepositoryScratchArtifactPath(
      "/workspace/other/.tmp/reviews/pr-2827",
      "/workspace/rainlanguage/raindex",
    ),
    undefined,
  )
  assert.equal(
    canonicalRepositoryScratchArtifactPath(
      ".tmp/reviews/pr-2827",
      "/workspace/rainlanguage/raindex",
    ),
    undefined,
  )
})

test("typed artifact directory creation rejects symlink ancestors before mutation", async () => {
  const artifactModule = (await import("./artifact-provenance.ts")) as Record<
    string,
    unknown
  >
  const validate = artifactModule.validateArtifactDirectoryCreationPath
  const create = artifactModule.createArtifactDirectory
  assert.equal(
    typeof validate,
    "function",
    "typed creation validator must exist",
  )
  assert.equal(
    typeof create,
    "function",
    "typed create-and-record path operation must exist",
  )
  if (typeof validate !== "function" || typeof create !== "function") return

  const root = mkdtempSync(join(tmpdir(), "pi-artifact-create-"))
  try {
    const repositoryRoot = join(root, "repo")
    const scratchRoot = join(repositoryRoot, ".tmp")
    const outside = join(root, "outside")
    mkdirSync(scratchRoot, { recursive: true })
    mkdirSync(outside)
    symlinkSync(outside, join(scratchRoot, "escape"))

    const reviewDirectory = join(scratchRoot, "reviews", "pr-1")
    assert.deepEqual(validate(reviewDirectory, repositoryRoot), {
      ok: true,
      path: reviewDirectory,
    })
    assert.deepEqual(create(reviewDirectory, repositoryRoot), {
      ok: true,
      path: reviewDirectory,
    })
    assert.equal(existsSync(reviewDirectory), true)

    const escapedDirectory = join(scratchRoot, "escape", "pr-1")
    assert.deepEqual(validate(escapedDirectory, repositoryRoot), {
      ok: false,
      error: "artifact creation ancestors must not be symbolic links",
    })
    assert.deepEqual(create(escapedDirectory, repositoryRoot), {
      ok: false,
      error: "artifact creation ancestors must not be symbolic links",
    })
    assert.equal(existsSync(join(outside, "pr-1")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("existing artifact validation is synchronous and rejects stale or symlinked paths", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-artifact-validate-"))
  try {
    const repositoryRoot = join(root, "repo")
    const scratchRoot = join(repositoryRoot, ".tmp")
    const artifact = join(scratchRoot, "current")
    const outside = join(root, "outside")
    mkdirSync(artifact, { recursive: true })
    mkdirSync(outside)

    assert.deepEqual(validateExistingArtifact(artifact, repositoryRoot, 0), {
      ok: true,
      path: realpathSync(artifact),
    })
    assert.deepEqual(
      validateExistingArtifact(artifact, repositoryRoot, Date.now() + 10_000),
      {
        ok: false,
        error:
          "artifact predates the current runtime and cannot be claimed automatically",
      },
    )

    const link = join(scratchRoot, "link")
    symlinkSync(outside, link)
    assert.deepEqual(validateExistingArtifact(link, repositoryRoot, 0), {
      ok: false,
      error: "artifact must not be a symbolic link",
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("artifact tool checks cancellation after async queue admission and persists synchronously", () => {
  const start = extensionSource.indexOf('name: "artifact_provenance"')
  const end = extensionSource.indexOf('name: "workflow_audit"', start)
  assert.ok(start >= 0 && end > start)
  const artifactTool = extensionSource.slice(start, end)

  assert.match(
    artifactTool,
    /async execute\(_toolCallId, request, signal, _onUpdate, ctx\)/,
  )
  assert.match(
    artifactTool,
    /withFileMutationQueue[\s\S]*if \(signal\.aborted\) return cancelledResult\(\)[\s\S]*createArtifactDirectory/,
  )
  assert.match(
    artifactTool,
    /if \(signal\.aborted\) return cancelledResult\(\)[\s\S]*validateExistingArtifact[\s\S]*pi\.appendEntry/,
  )
  assert.doesNotMatch(artifactTool, /Effect\.runPromise/)
})

test("artifact provenance persists defensively and forgets exact paths", () => {
  const recorded = recordArtifact(emptyArtifactProvenanceState, {
    path: "/workspace/project/.tmp/report.json",
    recordedAt: 42,
  })
  assert.deepEqual(artifactPaths(recorded), [
    "/workspace/project/.tmp/report.json",
  ])
  assert.deepEqual(
    restoreArtifactProvenance([
      { type: "custom", customType: ARTIFACT_PROVENANCE_ENTRY, data: recorded },
    ]),
    recorded,
  )
  assert.deepEqual(
    forgetArtifact(recorded, "/workspace/project/.tmp/report.json"),
    emptyArtifactProvenanceState,
  )
  assert.equal(
    decodeArtifactProvenanceState({
      artifacts: [{ path: "relative", recordedAt: 42 }],
    }),
    undefined,
  )
})
