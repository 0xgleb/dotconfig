import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Either } from "effect"

import {
  applyPreparedWorkspaceEdit,
  prepareWorkspaceEdit,
  type WorkspaceEditIo,
} from "./workspace-edit.ts"

const position = (line: number, character: number) => ({ line, character })
const range = (
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
) => ({
  start: position(startLine, startCharacter),
  end: position(endLine, endCharacter),
})

const workspace = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lsp-workspace-"))
  const file = join(cwd, "source.ts")
  await writeFile(file, "const oldName = 1\nconsole.log(oldName)\n", "utf8")
  return { cwd, file }
}

const textEdit = (uri: string, edits: readonly unknown[]) => ({
  changes: { [uri]: edits },
})

const prepare = async (cwd: string, edit: unknown) =>
  Effect.runPromise(prepareWorkspaceEdit({ cwd, edit }))

const failureCode = async (cwd: string, edit: unknown) => {
  const result = await Effect.runPromise(
    Effect.either(prepareWorkspaceEdit({ cwd, edit })),
  )
  assert.ok(Either.isLeft(result))
  return result.left.code
}

test("prepares bounded in-workspace text edits with a digest-bound preview", async () => {
  const { cwd, file } = await workspace()
  const prepared = await prepare(
    cwd,
    textEdit(new URL(`file://${file}`).href, [
      { range: range(0, 6, 0, 13), newText: "nextName" },
      { range: range(1, 12, 1, 19), newText: "nextName" },
    ]),
  )

  assert.match(prepared.previewId, /^lsp-preview-v1:[a-f0-9]{64}$/u)
  assert.equal(prepared.files.length, 1)
  assert.equal(
    prepared.files[0]?.nextText,
    "const nextName = 1\nconsole.log(nextName)\n",
  )
})

test("rejects outside-root and symlink-escape workspace edits", async () => {
  const { cwd } = await workspace()
  const outside = await mkdtemp(join(tmpdir(), "pi-lsp-outside-"))
  const outsideFile = join(outside, "outside.ts")
  await writeFile(outsideFile, "const secret = 1\n", "utf8")
  assert.equal(
    await failureCode(
      cwd,
      textEdit(new URL(`file://${outsideFile}`).href, [
        { range: range(0, 6, 0, 12), newText: "changed" },
      ]),
    ),
    "outside_workspace",
  )

  const link = join(cwd, "linked.ts")
  await symlink(outsideFile, link)
  assert.equal(
    await failureCode(
      cwd,
      textEdit(new URL(`file://${link}`).href, [
        { range: range(0, 6, 0, 12), newText: "changed" },
      ]),
    ),
    "outside_workspace",
  )
})

test("rejects overlapping, snippet, resource, and out-of-range edits", async () => {
  const { cwd, file } = await workspace()
  const uri = new URL(`file://${file}`).href

  assert.equal(
    await failureCode(
      cwd,
      textEdit(uri, [
        { range: range(0, 0, 0, 8), newText: "a" },
        { range: range(0, 4, 0, 10), newText: "b" },
      ]),
    ),
    "overlapping_edits",
  )
  assert.equal(
    await failureCode(
      cwd,
      textEdit(uri, [
        { range: range(0, 0, 0, 0), newText: "$1", insertTextFormat: 2 },
      ]),
    ),
    "unsupported_snippet",
  )
  assert.equal(
    await failureCode(cwd, {
      documentChanges: [{ kind: "delete", uri }],
    }),
    "unsupported_resource_operation",
  )
  assert.equal(
    await failureCode(
      cwd,
      textEdit(uri, [{ range: range(99, 0, 99, 0), newText: "invalid" }]),
    ),
    "invalid_range",
  )
})

test("rejects versioned or repeatedly ordered document changes", async () => {
  const { cwd, file } = await workspace()
  const uri = new URL(`file://${file}`).href
  assert.equal(
    await failureCode(cwd, {
      documentChanges: [
        {
          textDocument: { uri, version: 1 },
          edits: [{ range: range(0, 0, 0, 0), newText: "x" }],
        },
      ],
    }),
    "unsupported_document_version",
  )
  assert.equal(
    await failureCode(cwd, {
      documentChanges: [
        {
          textDocument: { uri, version: null },
          edits: [{ range: range(0, 0, 0, 0), newText: "x" }],
        },
        {
          textDocument: { uri, version: null },
          edits: [{ range: range(0, 1, 0, 1), newText: "y" }],
        },
      ],
    }),
    "unsupported_document_ordering",
  )
})

test("CRLF carriage returns are not addressable LSP characters", async () => {
  const { cwd, file } = await workspace()
  await writeFile(file, "abc\r\ndef\r\n", "utf8")
  assert.equal(
    await failureCode(
      cwd,
      textEdit(new URL(`file://${file}`).href, [
        { range: range(0, 4, 0, 4), newText: "x" },
      ]),
    ),
    "invalid_range",
  )
})

test("rejects source files above the bounded synchronization size", async () => {
  const { cwd, file } = await workspace()
  await writeFile(file, "x".repeat(4 * 1024 * 1024 + 1), "utf8")
  assert.equal(
    await failureCode(
      cwd,
      textEdit(new URL(`file://${file}`).href, [
        { range: range(0, 0, 0, 1), newText: "y" },
      ]),
    ),
    "source_too_large",
  )
})

test("apply requires the exact live preview and rejects stale files", async () => {
  const { cwd, file } = await workspace()
  const prepared = await prepare(
    cwd,
    textEdit(new URL(`file://${file}`).href, [
      { range: range(0, 6, 0, 13), newText: "nextName" },
    ]),
  )

  const unknown = await Effect.runPromise(
    Effect.either(applyPreparedWorkspaceEdit(prepared, "lsp-preview-v1:wrong")),
  )
  assert.ok(Either.isLeft(unknown))
  assert.equal(unknown.left.code, "preview_mismatch")

  await writeFile(file, "const changedElsewhere = 1\n", "utf8")
  const stale = await Effect.runPromise(
    Effect.either(applyPreparedWorkspaceEdit(prepared, prepared.previewId)),
  )
  assert.ok(Either.isLeft(stale))
  assert.equal(stale.left.code, "stale_preview")
})

test("no-follow writes never follow a symlink swapped in after validation", async () => {
  const { cwd, file } = await workspace()
  const outside = join(
    await mkdtemp(join(tmpdir(), "pi-lsp-swap-")),
    "outside.ts",
  )
  await writeFile(outside, "const outside = 1\n", "utf8")
  const prepared = await prepare(
    cwd,
    textEdit(new URL(`file://${file}`).href, [
      { range: range(0, 6, 0, 13), newText: "nextName" },
    ]),
  )
  let swapped = false
  const result = await Effect.runPromise(
    Effect.either(
      applyPreparedWorkspaceEdit(prepared, prepared.previewId, {
        readText: async path => {
          const text = await readFile(path, "utf8")
          if (!swapped) {
            swapped = true
            await rm(path)
            await symlink(outside, path)
          }
          return text
        },
      }),
    ),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "rollback_failed")
  assert.equal(await readFile(outside, "utf8"), "const outside = 1\n")
})

test("a later write failure rolls back the executed prefix", async () => {
  const { cwd, file } = await workspace()
  const second = join(cwd, "second.ts")
  await writeFile(second, "export const oldName = 2\n", "utf8")
  const prepared = await prepare(cwd, {
    changes: {
      [new URL(`file://${file}`).href]: [
        { range: range(0, 6, 0, 13), newText: "nextName" },
      ],
      [new URL(`file://${second}`).href]: [
        { range: range(0, 13, 0, 20), newText: "nextName" },
      ],
    },
  })

  let forwardWrites = 0
  const io: WorkspaceEditIo = {
    readText: path => readFile(path, "utf8"),
    writeText: async (path, text) => {
      const isRollback =
        text === prepared.files.find(item => item.path === path)?.originalText
      if (!isRollback) {
        forwardWrites += 1
        if (forwardWrites === 2) throw new Error("injected write failure")
      }
      await writeFile(path, text, "utf8")
    },
    withMutationQueue: (_path, work) => work(),
  }

  const result = await Effect.runPromise(
    Effect.either(applyPreparedWorkspaceEdit(prepared, prepared.previewId, io)),
  )
  assert.ok(Either.isLeft(result))
  assert.equal(result.left.code, "write_failed")
  assert.equal(
    await readFile(file, "utf8"),
    "const oldName = 1\nconsole.log(oldName)\n",
  )
  assert.equal(await readFile(second, "utf8"), "export const oldName = 2\n")
})
