import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Either } from "effect"

import { LspClientError, type LanguageClient, type LspPoint } from "./client.ts"
import { createLspCore, type LanguageClientProvider } from "./core.ts"
import { SERVER_PROFILES } from "./servers.ts"

const typescriptProfile = SERVER_PROFILES.find(
  profile => profile.id === "typescript",
)!

const workspace = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lsp-core-"))
  const file = join(cwd, "source.ts")
  await writeFile(join(cwd, "tsconfig.json"), "{}\n", "utf8")
  await writeFile(file, "const oldName = 1\nconsole.log(oldName)\n", "utf8")
  return { cwd, file }
}

const fakeClient = (
  overrides: Partial<LanguageClient> = {},
): LanguageClient => ({
  profile: typescriptProfile,
  root: "/workspace",
  capabilities: {
    definitionProvider: true,
    referencesProvider: true,
    renameProvider: true,
    codeActionProvider: true,
  },
  definition: () => Effect.succeed([]),
  references: () => Effect.succeed([]),
  diagnostics: () => Effect.succeed([]),
  rename: () => Effect.succeed(null),
  codeActions: () => Effect.succeed([]),
  isClosed: () => false,
  dispose: async () => {},
  ...overrides,
})

const provider = (client: LanguageClient): LanguageClientProvider => ({
  get: () => Effect.succeed(client),
  status: () => [],
})

test("definition resolves the requested symbol and bounds returned locations", async () => {
  const { cwd, file } = await workspace()
  let observed: LspPoint | undefined
  const core = createLspCore({
    clients: provider(
      fakeClient({
        definition: (_file, point) => {
          observed = point
          return Effect.succeed([
            {
              uri: new URL(`file://${file}`).href,
              range: {
                start: { line: 0, character: 6 },
                end: { line: 0, character: 13 },
              },
            },
            {
              uri: "file:///outside/not-returned.ts",
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
            },
          ])
        },
      }),
    ),
  })

  const result = await Effect.runPromise(
    core.execute(
      { action: "definition", file, line: 1, symbol: "oldName" },
      cwd,
    ),
  )
  assert.deepEqual(observed, { line: 0, character: 6 })
  assert.equal(result.details.locations?.length, 1)
  assert.equal(result.details.locations?.[0]?.path, "source.ts")
  assert.match(result.text, /source\.ts:1:7/u)
})

test("rename is preview-first and apply requires the returned preview ID", async () => {
  const { cwd, file } = await workspace()
  const core = createLspCore({
    clients: provider(
      fakeClient({
        rename: () =>
          Effect.succeed({
            changes: {
              [new URL(`file://${file}`).href]: [
                {
                  range: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 13 },
                  },
                  newText: "nextName",
                },
                {
                  range: {
                    start: { line: 1, character: 12 },
                    end: { line: 1, character: 19 },
                  },
                  newText: "nextName",
                },
              ],
            },
          }),
      }),
    ),
  })

  const preview = await Effect.runPromise(
    core.execute(
      {
        action: "rename_preview",
        file,
        line: 1,
        symbol: "oldName",
        newName: "nextName",
      },
      cwd,
    ),
  )
  assert.equal(
    await readFile(file, "utf8"),
    "const oldName = 1\nconsole.log(oldName)\n",
  )
  assert.match(preview.details.preview?.id ?? "", /^lsp-preview-v1:/u)

  const wrong = await Effect.runPromise(
    Effect.either(core.execute({ action: "apply", previewId: "wrong" }, cwd)),
  )
  assert.ok(Either.isLeft(wrong))
  assert.equal(wrong.left.code, "preview_not_found")

  await Effect.runPromise(
    core.execute(
      { action: "apply", previewId: preview.details.preview!.id },
      cwd,
    ),
  )
  assert.equal(
    await readFile(file, "utf8"),
    "const nextName = 1\nconsole.log(nextName)\n",
  )
})

test("apply accepts a preview prepared by a nested managed server root", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lsp-core-nested-"))
  const root = join(cwd, "package")
  const file = join(root, "source.ts")
  await mkdir(root)
  await writeFile(join(root, "tsconfig.json"), "{}\n", "utf8")
  await writeFile(file, "const oldName = 1\n", "utf8")
  const core = createLspCore({
    clients: provider(
      fakeClient({
        root,
        rename: () =>
          Effect.succeed({
            changes: {
              [new URL(`file://${file}`).href]: [
                {
                  range: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 13 },
                  },
                  newText: "nextName",
                },
              ],
            },
          }),
      }),
    ),
  })

  const preview = await Effect.runPromise(
    core.execute(
      {
        action: "rename_preview",
        file,
        line: 1,
        symbol: "oldName",
        newName: "nextName",
      },
      cwd,
    ),
  )
  const previewId = preview.details.preview?.id
  if (!previewId) assert.fail("expected rename preview")

  const otherWorkspace = await mkdtemp(join(tmpdir(), "pi-lsp-core-other-"))
  const wrongWorkspace = await Effect.runPromise(
    Effect.either(core.execute({ action: "apply", previewId }, otherWorkspace)),
  )
  assert.ok(Either.isLeft(wrongWorkspace))
  assert.equal(wrongWorkspace.left.code, "preview_not_found")

  await Effect.runPromise(core.execute({ action: "apply", previewId }, cwd))
  assert.equal(await readFile(file, "utf8"), "const nextName = 1\n")
})

test("rename preview returns a bounded no-op when the server rejects a non-renamable position", async () => {
  const { cwd, file } = await workspace()
  const core = createLspCore({
    clients: provider(
      fakeClient({
        rename: () =>
          Effect.fail(
            new LspClientError({
              code: "request_rejected",
              message: "No references found at position",
              serverCode: -32602,
              serverDiagnostic: "No references found at position",
            }),
          ),
      }),
    ),
  })

  const result = await Effect.runPromise(
    core.execute(
      {
        action: "rename_preview",
        file,
        line: 1,
        symbol: "oldName",
        newName: "nextName",
      },
      cwd,
    ),
  )
  assert.deepEqual(result.details.rejection, {
    code: "server_rejected",
    serverCode: -32602,
    message: "No references found at position",
  })
  assert.equal(result.details.preview, undefined)
  assert.match(result.text, /rename preview unavailable/iu)
  assert.equal(
    await readFile(file, "utf8"),
    "const oldName = 1\nconsole.log(oldName)\n",
  )
})

test("rename preview treats a null workspace edit as a bounded no-op", async () => {
  const { cwd, file } = await workspace()
  const core = createLspCore({ clients: provider(fakeClient()) })

  const result = await Effect.runPromise(
    core.execute(
      {
        action: "rename_preview",
        file,
        line: 1,
        symbol: "oldName",
        newName: "nextName",
      },
      cwd,
    ),
  )
  assert.deepEqual(result.details.rejection, {
    code: "no_edits",
    message: "Language server returned no rename edits",
  })
  assert.equal(result.details.preview, undefined)
  assert.match(result.text, /rename preview unavailable/iu)
})

test("code actions list commands but only preview edit-only actions", async () => {
  const { cwd, file } = await workspace()
  const client = fakeClient({
    codeActions: () =>
      Effect.succeed([
        {
          title: "Run arbitrary command",
          command: { title: "run", command: "dangerous.execute" },
        },
        {
          title: "Replace symbol",
          kind: "quickfix",
          edit: {
            changes: {
              [new URL(`file://${file}`).href]: [
                {
                  range: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 13 },
                  },
                  newText: "nextName",
                },
              ],
            },
          },
        },
      ]),
  })
  const core = createLspCore({ clients: provider(client) })

  const listed = await Effect.runPromise(
    core.execute(
      { action: "code_actions", file, line: 1, symbol: "oldName" },
      cwd,
    ),
  )
  assert.deepEqual(
    listed.details.actions?.map(action => ({
      title: action.title,
      applicable: action.applicable,
    })),
    [
      { title: "Run arbitrary command", applicable: false },
      { title: "Replace symbol", applicable: true },
    ],
  )

  const command = await Effect.runPromise(
    Effect.either(
      core.execute(
        {
          action: "code_action_preview",
          file,
          line: 1,
          symbol: "oldName",
          selector: 0,
        },
        cwd,
      ),
    ),
  )
  assert.ok(Either.isLeft(command))
  assert.equal(command.left.code, "unsupported_code_action")

  const preview = await Effect.runPromise(
    core.execute(
      {
        action: "code_action_preview",
        file,
        line: 1,
        symbol: "oldName",
        selector: 1,
      },
      cwd,
    ),
  )
  assert.equal(preview.details.preview?.files[0]?.path, "source.ts")
})

test("diagnostics report an unpublished snapshot as typed pending, never clean", async () => {
  const { cwd, file } = await workspace()
  const core = createLspCore({
    clients: provider(
      fakeClient({
        diagnostics: () => Effect.succeed(undefined),
      }),
    ),
  })

  const result = await Effect.runPromise(
    core.execute({ action: "diagnostics", file }, cwd),
  )
  assert.deepEqual(result.details.pending, {
    code: "diagnostics_not_published",
    retryable: true,
  })
  assert.equal(Object.hasOwn(result.details, "diagnostics"), false)
  assert.match(result.text, /pending/iu)
  assert.doesNotMatch(result.text, /no diagnostics/iu)
})

test("malformed diagnostic publications remain typed protocol failures", async () => {
  const { cwd, file } = await workspace()
  const core = createLspCore({
    clients: provider(
      fakeClient({
        diagnostics: () =>
          Effect.fail(
            new LspClientError({
              code: "malformed_notification",
              message: "Language server published malformed diagnostics",
            }),
          ),
      }),
    ),
  })

  const result = await Effect.runPromise(
    Effect.either(core.execute({ action: "diagnostics", file }, cwd)),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "malformed_server_response")
})

test("diagnostics reject malformed entries instead of reporting false clean", async () => {
  const { cwd, file } = await workspace()
  const core = createLspCore({
    clients: provider(
      fakeClient({
        diagnostics: () =>
          Effect.succeed([
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              severity: 1,
              message: "broken",
              source: "fake",
            },
            { range: {}, message: 7 },
          ]),
      }),
    ),
  })

  const result = await Effect.runPromise(
    Effect.either(core.execute({ action: "diagnostics", file }, cwd)),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "malformed_server_response")
})
