import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  describeRuntimeGitSnapshot,
  describeRuntimeProjectContext,
  gitEnvironmentOverrideBlockReason,
  hardenedGitPushCommandForSubject,
  nestedRepositoryRootForPath,
  repositoryRootForPath,
  runtimeClassificationProjectContexts,
  runtimeClassificationProjectContextsMatch,
  runtimeCommandProjectContextForSubject,
  runtimeProjectContext,
  runtimeProjectContextForTarget,
  runtimeTargetProjectContextForSubject,
  unsafeRuntimeCommandLocationBlockReason,
} from "./project-context.ts"

test("target identity ignores sibling churn but detects target replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-target-sibling-"))
  try {
    const target = join(root, "settings.json")
    writeFileSync(target, "{}")
    const before = runtimeProjectContextForTarget(root, target)
    assert.ok(before)
    writeFileSync(join(root, "unrelated.lock"), "lock")
    assert.deepEqual(runtimeProjectContextForTarget(root, target), before)
    const replacement = join(root, "replacement.json")
    writeFileSync(replacement, "{}")
    renameSync(replacement, target)
    assert.notEqual(
      runtimeProjectContextForTarget(root, target)?.targetIdentitySha256,
      before.targetIdentitySha256,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("quoted Git grep patterns are data, not shell operators", () => {
  const command =
    "git grep -n -E 'CancellationPending|RecordFill|ConfirmFill|Record.*Delivery|Fulfilled' f753645aca30afe3b4d251721671a3ac58708c28 -- crates/hedge/src/routing.rs crates/ledger/src/standing_order.rs"
  const subject = { toolName: "bash", input: { command } }
  assert.ok(runtimeCommandProjectContextForSubject(process.cwd(), subject))
  assert.equal(
    unsafeRuntimeCommandLocationBlockReason(process.cwd(), subject),
    undefined,
  )
  for (const unsafe of [
    "git status | cat",
    'git grep "$COMMAND" -- file.ts',
    "git status; pwd",
  ]) {
    assert.equal(
      runtimeCommandProjectContextForSubject(process.cwd(), {
        toolName: "bash",
        input: { command: unsafe },
      }),
      undefined,
    )
  }
})

test("path-qualified Git commands fail closed without executable provenance", () => {
  for (const command of [
    "/usr/bin/git status --short",
    "^/usr/bin/git status --short",
    "/usr/bin/g$''it status",
    "/usr/bin/g\\\nit status",
  ]) {
    const subject = { toolName: "bash", input: { command } }
    assert.equal(
      runtimeCommandProjectContextForSubject(process.cwd(), subject),
      undefined,
    )
    assert.match(
      unsafeRuntimeCommandLocationBlockReason(process.cwd(), subject) ?? "",
      /Git commands require/,
    )
  }
})

test("runtime project context identifies repository roots and descendants", () => {
  assert.deepEqual(
    describeRuntimeProjectContext("/workspace/st0x", "/workspace/st0x"),
    {
      cwd: "/workspace/st0x",
      gitToplevel: "/workspace/st0x",
      cwdRelation: "repository-root",
    },
  )
  assert.deepEqual(
    describeRuntimeProjectContext("/workspace/st0x/crate", "/workspace/st0x"),
    {
      cwd: "/workspace/st0x/crate",
      gitToplevel: "/workspace/st0x",
      cwdRelation: "inside-repository",
    },
  )
})

test("runtime project context binds branch, head, index, and worktree state", () => {
  const head = "a".repeat(40)
  const snapshot = describeRuntimeGitSnapshot(
    [
      `# branch.oid ${head}`,
      "# branch.head feat/pending-position-pipeline",
      "1 M. N... 100644 100644 100644 a b staged.ts",
      "1 .M N... 100644 100644 100644 a b unstaged.ts",
    ].join("\0"),
  )

  assert.deepEqual(
    {
      ...snapshot,
      gitStatusSnapshotSha256: snapshot.gitStatusSnapshotSha256.length,
    },
    {
      gitBranch: "feat/pending-position-pipeline",
      gitHead: head,
      gitCachedPathCount: 1,
      gitStatusSnapshotSha256: 64,
      gitHasUnstagedTrackedChanges: true,
      gitUntrackedFilesExcluded: true,
    },
  )
})

test("runtime Git snapshots reject detached and unborn identity sentinels", () => {
  const detached = describeRuntimeGitSnapshot(
    "# branch.oid 0123456789012345678901234567890123456789\0# branch.head (detached)\0",
  )
  const unborn = describeRuntimeGitSnapshot(
    "# branch.oid (initial)\0# branch.head main\0",
  )
  const newlineHeader = describeRuntimeGitSnapshot(
    "# branch.oid 0123456789012345678901234567890123456789\0# branch.head main\n# branch.head attacker\0",
  )
  const trailingCrLfHeader = describeRuntimeGitSnapshot(
    "# branch.oid 0123456789012345678901234567890123456789\r\n\0# branch.head main\r\n\0",
  )

  assert.equal(detached.gitBranch, undefined)
  assert.equal(detached.gitHead?.length, 40)
  assert.equal(unborn.gitBranch, "main")
  assert.equal(unborn.gitHead, undefined)
  assert.equal(newlineHeader.gitBranch, undefined)
  assert.equal(trailingCrLfHeader.gitHead, undefined)
  assert.equal(trailingCrLfHeader.gitBranch, undefined)
})

test("runtime Git snapshots consume rename paths and preserve newline filenames", () => {
  const head = "b".repeat(40)
  const snapshot = describeRuntimeGitSnapshot(
    [
      `# branch.oid ${head}`,
      "# branch.head main",
      "2 R. N... 100644 100644 100644 a b R100 new.ts",
      "# branch.head attacker\n1 old.ts",
      "1 M. N... 100644 100644 100644 a b line\n# branch.head attacker",
      "? untracked.ts",
    ].join("\0"),
  )

  assert.equal(snapshot.gitBranch, "main")
  assert.equal(snapshot.gitHead, head)
  assert.equal(snapshot.gitCachedPathCount, 2)
  assert.equal(snapshot.gitHasUnstagedTrackedChanges, false)
  assert.equal(snapshot.gitUntrackedFilesExcluded, true)
})

test("runtime project context refreshes one source-fixed Git status snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-git-context-"))
  const git = (...args: ReadonlyArray<string>) =>
    spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  try {
    assert.equal(spawnSync("git", ["init", "-q", "-b", "main", root]).status, 0)
    assert.equal(git("config", "user.name", "Pi Test").status, 0)
    assert.equal(git("config", "user.email", "pi@example.invalid").status, 0)
    assert.equal(git("config", "core.hooksPath", "/dev/null").status, 0)
    const unborn = runtimeProjectContext(root)
    assert.equal(unborn.gitBranch, "main")
    assert.equal(unborn.gitHead, undefined)

    writeFileSync(join(root, "tracked.txt"), "one\n")
    assert.equal(git("add", "tracked.txt").status, 0)
    assert.equal(git("commit", "-q", "-m", "initial").status, 0)
    assert.equal(
      git("remote", "add", "origin", "https://example.invalid/repo.git").status,
      0,
    )

    const clean = runtimeProjectContext(root)
    const target = runtimeProjectContextForTarget(
      "/unrelated/session",
      join(root, "tracked.txt"),
    )
    assert.equal(target?.targetPath, realpathSync(join(root, "tracked.txt")))
    assert.equal(target?.project.gitToplevel, clean.gitToplevel)
    assert.equal(target?.project.gitBranch, "main")
    assert.equal(target?.project.gitHead, clean.gitHead)
    assert.match(target?.targetIdentitySha256 ?? "", /^[0-9a-f]{64}$/)
    const trackedTargetSubject = {
      toolName: "edit",
      input: { path: join(root, "tracked.txt") },
    }
    const beforeTargetReplacement = runtimeClassificationProjectContexts(
      root,
      trackedTargetSubject,
    )
    writeFileSync(join(root, "replacement.txt"), "one\n")
    renameSync(join(root, "replacement.txt"), join(root, "tracked.txt"))
    const afterTargetReplacement = runtimeClassificationProjectContexts(
      root,
      trackedTargetSubject,
    )
    assert.equal(
      afterTargetReplacement.runtimeProjectContext.gitStatusSnapshotSha256,
      beforeTargetReplacement.runtimeProjectContext.gitStatusSnapshotSha256,
    )
    assert.equal(
      runtimeClassificationProjectContextsMatch(
        beforeTargetReplacement,
        afterTargetReplacement,
      ),
      false,
    )
    symlinkSync("tracked.txt", join(root, "linked-target.txt"))
    assert.equal(
      runtimeProjectContextForTarget(root, "linked-target.txt"),
      undefined,
    )
    const commandContext = runtimeCommandProjectContextForSubject(
      "/unrelated/session",
      {
        toolName: "bash",
        input: { command: `cd "${root}"\ngit status` },
      },
    )
    assert.equal(commandContext?.project.gitHead, clean.gitHead)
    assert.match(
      commandContext?.commandCwdIdentitySha256 ?? "",
      /^[0-9a-f]{64}$/,
    )
    assert.equal(commandContext?.command, "git status")
    assert.equal(commandContext?.directoryTransition, true)
    const commandAlias = join(
      tmpdir(),
      `pi-runtime-command-alias-${Date.now()}`,
    )
    symlinkSync(root, commandAlias)
    assert.equal(
      runtimeCommandProjectContextForSubject(root, {
        toolName: "bash",
        input: { command: `cd ${commandAlias}\ngit status` },
      }),
      undefined,
    )
    unlinkSync(commandAlias)
    for (const command of [
      `cd ${join(root, "missing")}\ngit status`,
      `cd "${root}"\ngit -C../other status`,
      `cd "${root}"\ngit -Cfoo status`,
      `cd "${root}"\ngit "-C" /other status`,
      `cd "${root}"\nenv 'GIT_DIR=/other/.git' git status`,
      `cd "${root}"\ngit --git-dir=/other/.git status`,
      `cd "${root}"\ngit --work-tree /other status`,
      `cd "${root}"\nGIT_DIR=/other/.git git status`,
      `cd "${root}"\nenv GIT_INDEX_FILE=/tmp/other git status`,
      `cd "${root}"\ngit -c remote.origin.pushurl=ssh://git@example.invalid/other.git push origin HEAD`,

      "cd .\ngit status",
      "cd ~/repo\ngit status",
      `cd "${root}/*"\ngit status`,
      `cd "${root}\\child"\ngit status`,
      `cd "${root}"\ncd /workspace && git status`,
      `cd ${root} && git status`,
      `cd ${root}; git status`,
      `cd "${root} with space"\ngit status`,
      `pushd ${root}\ngit status`,
      `popd\ngit status`,
      `cd "${root}"\ngit$IFS-C$IFS/workspace status`,
      `cd "${root}"\ngit -C/workspace status`,
      `cd "${root}"\ngit -C"/workspace" status`,
      `cd "${root}"\ngit -C /workspace status`,
      `cd "${root}"\ngit status; cd /workspace`,
    ]) {
      const unsafeSubject = {
        toolName: "bash",
        input: { command },
      }
      assert.equal(
        runtimeCommandProjectContextForSubject(root, unsafeSubject),
        undefined,
      )
      assert.match(
        unsafeRuntimeCommandLocationBlockReason(root, unsafeSubject) ?? "",
        /Git commands require either the session cwd/,
      )
    }
    for (const command of [
      "git -C/tmp/other status",
      'git "-C" /tmp/other status',
      "git -cfoo.bar=baz status",
      "git --git-dir=/tmp/other.git status",
      "GIT_DIR=/tmp/other.git git status",
      "env 'GIT_DIR=/tmp/other.git' git status",
      `cd ${root} && git status`,
      `cd ${root}; git status`,
      `pushd ${root}\ngit status`,
      "popd\ngit status",
    ])
      assert.match(
        unsafeRuntimeCommandLocationBlockReason(root, {
          toolName: "bash",
          input: { command },
        }) ?? "",
        /Git commands require either the session cwd/,
      )
    const targetFromSubject = runtimeTargetProjectContextForSubject(
      "/unrelated/session",
      {
        toolName: "edit",
        input: { path: join(root, "tracked.txt") },
      },
    )
    assert.equal(targetFromSubject?.targetPath, target?.targetPath)
    assert.equal(targetFromSubject?.project.gitHead, clean.gitHead)
    assert.equal(
      runtimeTargetProjectContextForSubject(root, {
        toolName: "bash",
        input: { command: "git status" },
      }),
      undefined,
    )
    assert.equal(clean.gitBranch, "main")
    assert.match(clean.gitHead ?? "", /^[0-9a-f]{40}$/)
    assert.equal(clean.gitCachedPathCount, 0)
    assert.equal(clean.gitHasUnstagedTrackedChanges, false)
    assert.equal(clean.gitUntrackedFilesExcluded, true)
    assert.match(clean.gitStatusSnapshotSha256 ?? "", /^[0-9a-f]{64}$/)
    assert.match(clean.gitCommitHooksSnapshotSha256 ?? "", /^[0-9a-f]{64}$/)
    assert.match(clean.gitPushRemoteSnapshotSha256 ?? "", /^[0-9a-f]{64}$/)
    const pushSubject = {
      toolName: "bash",
      input: { command: `cd "${root}"\ngit push -u origin HEAD` },
    }
    const hardenedPush = hardenedGitPushCommandForSubject(
      root,
      pushSubject,
      clean.gitPushRemoteSnapshotSha256,
    )
    assert.ok(hardenedPush && "command" in hardenedPush)
    assert.match(hardenedPush.command, /^cd ".*"\ngit /)
    assert.match(
      hardenedPush.command,
      /git -c remote\.origin\.url=https:\/\/example\.invalid\/repo\.git -c remote\.origin\.pushurl=https:\/\/example\.invalid\/repo\.git push -u origin HEAD/,
    )
    const whitespacePush = hardenedGitPushCommandForSubject(
      root,
      {
        toolName: "bash",
        input: { command: `cd "${root}"\n git push -u origin HEAD` },
      },
      clean.gitPushRemoteSnapshotSha256,
    )
    assert.ok(whitespacePush && "command" in whitespacePush)
    const originalGitDir = process.env.GIT_DIR
    process.env.GIT_DIR = "/tmp/ambient-other.git"
    try {
      const ambientContexts = runtimeClassificationProjectContexts(
        root,
        pushSubject,
      )
      assert.deepEqual(
        ambientContexts.runtimeCommandProjectContext?.project
          .gitEnvironmentOverrideNames,
        ["GIT_DIR"],
      )
      assert.deepEqual(
        runtimeProjectContext(join(root, "outside", "missing"))
          .gitEnvironmentOverrideNames,
        ["GIT_DIR"],
      )
      assert.match(
        gitEnvironmentOverrideBlockReason(ambientContexts, pushSubject) ?? "",
        /ambient repository or config override variables: GIT_DIR/,
      )
      const rejectedPush = hardenedGitPushCommandForSubject(
        root,
        pushSubject,
        clean.gitPushRemoteSnapshotSha256,
      )
      assert.ok(rejectedPush && "reason" in rejectedPush)
    } finally {
      if (originalGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = originalGitDir
    }
    const beforeRemoteChange = runtimeClassificationProjectContexts(
      root,
      pushSubject,
    )
    assert.equal(
      git(
        "remote",
        "set-url",
        "--push",
        "origin",
        "ssh://git@example.invalid/changed.git",
      ).status,
      0,
    )
    const afterRemoteChange = runtimeClassificationProjectContexts(
      root,
      pushSubject,
    )
    const changedAgainstApproved = hardenedGitPushCommandForSubject(
      root,
      pushSubject,
      beforeRemoteChange.runtimeCommandProjectContext?.project
        .gitPushRemoteSnapshotSha256,
    )
    assert.ok(changedAgainstApproved && "reason" in changedAgainstApproved)
    assert.match(
      changedAgainstApproved.reason,
      /no longer matches the approved/,
    )
    const changedHardenedPush = hardenedGitPushCommandForSubject(
      root,
      pushSubject,
      afterRemoteChange.runtimeCommandProjectContext?.project
        .gitPushRemoteSnapshotSha256,
    )
    assert.ok(changedHardenedPush && "command" in changedHardenedPush)
    assert.match(
      changedHardenedPush.command,
      /remote\.origin\.pushurl=ssh:\/\/git@example\.invalid\/changed\.git/,
    )
    assert.doesNotMatch(hardenedPush.command, /changed\.git/)
    const standalonePushSubject = {
      toolName: "bash",
      input: { command: "git push -u origin HEAD" },
    }
    const standaloneContext = runtimeClassificationProjectContexts(
      root,
      standalonePushSubject,
    )
    assert.equal(
      standaloneContext.runtimeCommandProjectContext?.commandCwd,
      realpathSync(root),
    )
    assert.equal(
      standaloneContext.runtimeCommandProjectContext?.directoryTransition,
      false,
    )
    const hardenedStandalonePush = hardenedGitPushCommandForSubject(
      root,
      standalonePushSubject,
      afterRemoteChange.runtimeProjectContext.gitPushRemoteSnapshotSha256,
    )
    assert.ok(hardenedStandalonePush && "command" in hardenedStandalonePush)
    assert.doesNotMatch(hardenedStandalonePush.command, /^cd /)
    assert.match(
      hardenedStandalonePush.command,
      /remote\.origin\.pushurl=ssh:\/\/git@example\.invalid\/changed\.git/,
    )
    assert.equal(
      git(
        "remote",
        "set-url",
        "--push",
        "origin",
        "ssh://git@example.invalid/standalone-race.git",
      ).status,
      0,
    )
    const changedStandalonePush = hardenedGitPushCommandForSubject(
      root,
      standalonePushSubject,
      afterRemoteChange.runtimeProjectContext.gitPushRemoteSnapshotSha256,
    )
    assert.ok(changedStandalonePush && "reason" in changedStandalonePush)
    assert.match(changedStandalonePush.reason, /no longer matches the approved/)
    const beforeRewrite = runtimeProjectContext(root)
    assert.equal(
      git(
        "config",
        "url.ssh://git@attacker.invalid/.pushInsteadOf",
        "ssh://git@example.invalid/",
      ).status,
      0,
    )
    const afterRewrite = runtimeProjectContext(root)
    assert.notEqual(
      afterRewrite.gitPushRemoteSnapshotSha256,
      beforeRewrite.gitPushRemoteSnapshotSha256,
    )
    const rewriteRace = hardenedGitPushCommandForSubject(
      root,
      standalonePushSubject,
      beforeRewrite.gitPushRemoteSnapshotSha256,
    )
    assert.ok(rewriteRace && "reason" in rewriteRace)
    assert.match(rewriteRace.reason, /no longer matches the approved/)
    const rewriteConfigured = hardenedGitPushCommandForSubject(
      root,
      standalonePushSubject,
      afterRewrite.gitPushRemoteSnapshotSha256,
    )
    assert.ok(rewriteConfigured && "reason" in rewriteConfigured)
    assert.match(rewriteConfigured.reason, /url\.\*\.insteadOf/)
    assert.equal(
      git(
        "config",
        "--unset-all",
        "url.ssh://git@attacker.invalid/.pushInsteadOf",
      ).status,
      0,
    )
    assert.equal(
      afterRemoteChange.runtimeProjectContext.gitStatusSnapshotSha256,
      beforeRemoteChange.runtimeProjectContext.gitStatusSnapshotSha256,
    )
    assert.equal(
      runtimeClassificationProjectContextsMatch(
        beforeRemoteChange,
        afterRemoteChange,
      ),
      false,
    )
    assert.equal(
      git(
        "remote",
        "set-url",
        "--push",
        "origin",
        "https://token@example.invalid/repo.git",
      ).status,
      0,
    )
    const credentialPush = hardenedGitPushCommandForSubject(
      root,
      pushSubject,
      runtimeProjectContext(root).gitPushRemoteSnapshotSha256,
    )
    assert.ok(credentialPush && "reason" in credentialPush)
    assert.match(credentialPush.reason, /credential-free HTTPS or SSH/)

    writeFileSync(join(root, "untracked.txt"), "not committed\n")
    const withUntracked = runtimeProjectContext(root)
    assert.equal(withUntracked.gitHasUnstagedTrackedChanges, false)
    assert.equal(
      withUntracked.gitStatusSnapshotSha256,
      clean.gitStatusSnapshotSha256,
    )

    writeFileSync(join(root, "tracked.txt"), "two\n")
    const unstaged = runtimeProjectContext(root)
    assert.equal(unstaged.gitHasUnstagedTrackedChanges, true)
    assert.notEqual(
      unstaged.gitStatusSnapshotSha256,
      clean.gitStatusSnapshotSha256,
    )

    assert.equal(git("add", "tracked.txt").status, 0)
    const staged = runtimeProjectContext(root)
    assert.equal(staged.gitCachedPathCount, 1)
    assert.equal(staged.gitHasUnstagedTrackedChanges, false)
    assert.notEqual(
      staged.gitStatusSnapshotSha256,
      unstaged.gitStatusSnapshotSha256,
    )

    const stagedSubject = {
      toolName: "bash",
      input: { command: `cd "${root}"\ngit commit -m 'boundary'` },
    }
    const beforeMutation = runtimeClassificationProjectContexts(
      root,
      stagedSubject,
    )
    writeFileSync(join(root, "tracked.txt"), "three\n")
    assert.equal(
      runtimeClassificationProjectContextsMatch(
        beforeMutation,
        runtimeClassificationProjectContexts(root, stagedSubject),
      ),
      false,
    )
    assert.equal(git("checkout", "--", "tracked.txt").status, 0)

    const firstTarget = join(root, "first-target")
    const secondTarget = join(root, "second-target")
    const targetAlias = join(root, "target-alias")
    mkdirSync(firstTarget)
    mkdirSync(secondTarget)
    writeFileSync(join(firstTarget, "target.txt"), "first\n")
    writeFileSync(join(secondTarget, "target.txt"), "second\n")
    symlinkSync(firstTarget, targetAlias)
    const targetSubject = {
      toolName: "edit",
      input: { path: join(targetAlias, "target.txt") },
    }
    const beforeSymlinkSwap = runtimeClassificationProjectContexts(
      root,
      targetSubject,
    )
    unlinkSync(targetAlias)
    symlinkSync(secondTarget, targetAlias)
    assert.equal(
      runtimeClassificationProjectContextsMatch(
        beforeSymlinkSwap,
        runtimeClassificationProjectContexts(root, targetSubject),
      ),
      false,
    )

    assert.equal(git("checkout", "-q", "--detach").status, 0)
    const detached = runtimeProjectContext(root)
    assert.equal(detached.gitBranch, undefined)
    assert.match(detached.gitHead ?? "", /^[0-9a-f]{40}$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Git commit hooks can mutate the index while no-verify bypasses checks", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-git-hook-"))
  const git = (...args: ReadonlyArray<string>) =>
    spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  try {
    assert.equal(spawnSync("git", ["init", "-q", "-b", "main", root]).status, 0)
    assert.equal(git("config", "user.name", "Pi Test").status, 0)
    assert.equal(git("config", "user.email", "pi@example.invalid").status, 0)
    writeFileSync(join(root, "tracked.txt"), "one\n")
    assert.equal(git("add", "tracked.txt").status, 0)
    assert.equal(git("commit", "-q", "-m", "initial").status, 0)
    const commitSubject = {
      toolName: "bash",
      input: { command: `cd "${root}"\ngit commit -m 'hook boundary'` },
    }
    const initialProjectContexts = runtimeClassificationProjectContexts(
      root,
      commitSubject,
    )
    const initialHooksSnapshot =
      initialProjectContexts.runtimeProjectContext.gitCommitHooksSnapshotSha256

    writeFileSync(join(root, "tracked.txt"), "two\n")
    writeFileSync(join(root, "untracked.txt"), "hook-staged\n")
    assert.equal(git("add", "tracked.txt").status, 0)
    const hook = join(root, ".git", "hooks", "pre-commit")
    writeFileSync(hook, "#!/bin/sh\ngit add untracked.txt\n")
    chmodSync(hook, 0o755)
    assert.notEqual(
      runtimeProjectContext(root).gitCommitHooksSnapshotSha256,
      initialHooksSnapshot,
    )
    assert.equal(
      runtimeClassificationProjectContextsMatch(
        initialProjectContexts,
        runtimeClassificationProjectContexts(root, commitSubject),
      ),
      false,
    )
    assert.equal(git("commit", "-q", "-m", "hook stages untracked").status, 0)
    const hookedPaths = git("show", "--pretty=", "--name-only", "HEAD").stdout
    assert.match(hookedPaths, /tracked\.txt/)
    assert.match(hookedPaths, /untracked\.txt/)

    writeFileSync(join(root, "tracked.txt"), "three\n")
    writeFileSync(join(root, "untracked-two.txt"), "must remain untracked\n")
    assert.equal(git("add", "tracked.txt").status, 0)
    writeFileSync(hook, "#!/bin/sh\ngit add untracked-two.txt\n")
    assert.equal(
      git("commit", "-q", "--no-verify", "-m", "bypass staging hook").status,
      0,
    )
    const bypassedPaths = git("show", "--pretty=", "--name-only", "HEAD").stdout
    assert.match(bypassedPaths, /tracked\.txt/)
    assert.doesNotMatch(bypassedPaths, /untracked-two\.txt/)

    unlinkSync(hook)
    const prepareHook = join(root, ".git", "hooks", "prepare-commit-msg")
    writeFileSync(prepareHook, "#!/bin/sh\ngit add untracked-two.txt\n")
    chmodSync(prepareHook, 0o755)
    writeFileSync(join(root, "tracked.txt"), "four\n")
    assert.equal(git("add", "tracked.txt").status, 0)
    assert.equal(git("commit", "-q", "-m", "prepare hook mutates").status, 0)
    const prepareMutation = [
      git("show", "--pretty=", "--name-only", "HEAD").stdout,
      git("diff", "--cached", "--name-only").stdout,
    ].join("\n")
    assert.match(prepareMutation, /untracked-two\.txt/)

    unlinkSync(prepareHook)
    writeFileSync(join(root, "untracked-three.txt"), "commit-msg stages\n")
    const commitMessageHook = join(root, ".git", "hooks", "commit-msg")
    writeFileSync(commitMessageHook, "#!/bin/sh\ngit add untracked-three.txt\n")
    chmodSync(commitMessageHook, 0o755)
    writeFileSync(join(root, "tracked.txt"), "five\n")
    assert.equal(git("add", "tracked.txt").status, 0)
    assert.equal(git("commit", "-q", "-m", "message hook mutates").status, 0)
    const commitMessageMutation = [
      git("show", "--pretty=", "--name-only", "HEAD").stdout,
      git("diff", "--cached", "--name-only").stdout,
    ].join("\n")
    assert.match(commitMessageMutation, /untracked-three\.txt/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("relative hook paths are fingerprinted from the repository root", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-relative-hooks-"))
  const git = (...args: ReadonlyArray<string>) =>
    spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  try {
    assert.equal(spawnSync("git", ["init", "-q", "-b", "main", root]).status, 0)
    assert.equal(git("config", "core.hooksPath", ".hooks").status, 0)
    mkdirSync(join(root, ".hooks"))
    mkdirSync(join(root, "nested"))
    const hook = join(root, ".hooks", "pre-commit")
    writeFileSync(hook, "#!/bin/sh\nexit 0\n")
    chmodSync(hook, 0o755)
    const rootSnapshot = runtimeProjectContext(root)
    const nestedSnapshot = runtimeProjectContext(join(root, "nested"))
    assert.equal(
      nestedSnapshot.gitCommitHooksSnapshotSha256,
      rootSnapshot.gitCommitHooksSnapshotSha256,
    )

    writeFileSync(hook, "#!/bin/sh\ngit add untracked.txt\n")
    const changedCommitHookSnapshot = runtimeProjectContext(
      join(root, "nested"),
    )
    assert.notEqual(
      changedCommitHookSnapshot.gitCommitHooksSnapshotSha256,
      nestedSnapshot.gitCommitHooksSnapshotSha256,
    )
    writeFileSync(join(root, ".hooks", "pre-push"), "#!/bin/sh\nexit 0\n")
    assert.notEqual(
      runtimeProjectContext(join(root, "nested")).gitCommitHooksSnapshotSha256,
      changedCommitHookSnapshot.gitCommitHooksSnapshotSha256,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("runtime project context distinguishes main and linked worktrees", () => {
  assert.deepEqual(
    describeRuntimeProjectContext(
      "/workspace/repo/.worktrees/fix/src",
      "/workspace/repo/.worktrees/fix",
      "/workspace/repo",
    ),
    {
      cwd: "/workspace/repo/.worktrees/fix/src",
      gitToplevel: "/workspace/repo/.worktrees/fix",
      gitMainWorktree: "/workspace/repo",
      isMainWorktree: false,
      cwdRelation: "inside-repository",
    },
  )
  assert.deepEqual(
    describeRuntimeProjectContext(
      "/workspace/repo",
      "/workspace/repo",
      "/workspace/repo",
    ),
    {
      cwd: "/workspace/repo",
      gitToplevel: "/workspace/repo",
      gitMainWorktree: "/workspace/repo",
      isMainWorktree: true,
      cwdRelation: "repository-root",
    },
  )
})

test("runtime project context does not invent a repository boundary", () => {
  assert.deepEqual(describeRuntimeProjectContext("/workspace", undefined), {
    cwd: "/workspace",
    cwdRelation: "outside-repository",
  })
})

test("repository root evidence can identify an explicitly authorized external target", () => {
  const gitToplevelForPath = (path: string): string | undefined =>
    path.startsWith("/workspace/rainlanguage/raindex")
      ? "/workspace/rainlanguage/raindex"
      : undefined
  assert.equal(
    repositoryRootForPath(
      "/workspace/rainlanguage/raindex/.tmp/reviews/pr-2827",
      gitToplevelForPath,
    ),
    "/workspace/rainlanguage/raindex",
  )
})

test("nested repository roots are accepted only beneath the session workspace", () => {
  const gitToplevelForPath = (path: string): string | undefined =>
    path.startsWith("/workspace/nested-repo")
      ? "/workspace/nested-repo"
      : path.startsWith("/outside/nested-repo")
        ? "/outside/nested-repo"
        : undefined
  assert.equal(
    nestedRepositoryRootForPath(
      "/workspace",
      "/workspace/nested-repo/.tmp/report.json",
      gitToplevelForPath,
    ),
    "/workspace/nested-repo",
  )
  assert.equal(
    nestedRepositoryRootForPath(
      "/workspace",
      "/outside/nested-repo/.tmp/report.json",
      gitToplevelForPath,
    ),
    undefined,
  )
})
