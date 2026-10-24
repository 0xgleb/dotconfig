import assert from "node:assert/strict"
import { realpathSync } from "node:fs"
import test from "node:test"
import { runtimeCommandLocationForSubject } from "./project-context.ts"

const cwd = realpathSync(new URL(".", import.meta.url))
const location = (command: string) =>
  runtimeCommandLocationForSubject(cwd, {
    toolName: "bash",
    input: { command },
  })

// Attribution is not admission: these tests invoke no commands and grant no
// permission. Every literal command must preserve the verified directory.
test("native literal Git sequences retain their complete command and verified scope", () => {
  for (const command of [
    "git remote get-url --push --all origin\ngit log --format='%H %s' origin/master..HEAD",
    "^git ls-tree -r HEAD -- docs/a.md\n^git hash-object -- docs/a.md",
  ]) {
    const observed = location(command)
    assert.equal(observed?.commandCwd, cwd)
    assert.equal(observed?.command, command)
    assert.equal(observed?.directoryTransition, false)
  }
})

test("one leading literal cd binds the entire same-directory sequence", () => {
  const command = "git status --short\ngit diff --check"
  const observed = location(`cd "${cwd}"\n${command}`)
  assert.equal(observed?.commandCwd, cwd)
  assert.equal(observed?.command, command)
  assert.equal(observed?.directoryTransition, true)
})

test("later location transitions and selectors never receive verified attribution", () => {
  for (const command of [
    "git status --short\ncd /outside\ngit status --short",
    "git status --short\ngit -C /outside status --short",
    "git status --short\ngit --git-dir=/outside status --short",
    "git status --short\nGIT_DIR=/outside git status --short",
    "git status --short\n(git status --short)",
    "git status --short\nsource ./change-directory.nu\ngit status --short",
    "git status --short\neval 'cd /outside'\ngit status --short",
    "git status --short\n./g?t -C /outside status --short",
    "git status --short\nload-env { GIT_DIR: '/outside' }\ngit status --short",
  ])
    assert.equal(location(command), undefined, command)
})
