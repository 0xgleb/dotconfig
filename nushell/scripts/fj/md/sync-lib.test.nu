use std/assert

source sync-lib.nu

# --- undot ---

def "test undot strips leading dots from segments" [] {
  assert equal (undot ".local/prompts/foo.md") "local/prompts/foo.md"
}

def "test undot strips dots from multiple segments" [] {
  assert equal (undot ".config/.hidden/file.md") "config/hidden/file.md"
}

def "test undot leaves non-dotted paths unchanged" [] {
  assert equal (undot "docs/cqrs.md") "docs/cqrs.md"
}

def "test undot handles single file" [] {
  assert equal (undot ".gitignore") "gitignore"
}

def "test undot preserves dots mid-segment" [] {
  assert equal (undot "st0x.liquidity/README.md") "st0x.liquidity/README.md"
}

# --- note-file mapping (.local stripping + undot) ---

def note-file [file: string] {
  $file | str replace '.local/' '' | undot $in
}

def "test note-file strips .local and undots" [] {
  assert equal (note-file ".local/prompts/01-setup.md") "prompts/01-setup.md"
}

def "test note-file passes through normal paths" [] {
  assert equal (note-file "docs/cqrs.md") "docs/cqrs.md"
}

def "test note-file handles .local with nested dirs" [] {
  assert equal (note-file ".local/prompts/deep/file.md") "prompts/deep/file.md"
}

# --- repo-for-path ---

def test-targets [] {
  [
    { name: "liquidity", path: "/org/st0x.liquidity" }
    { name: "issuance", path: "/org/st0x.issuance" }
    { name: "liquidity/worktrees/untouchable", path: "/org/st0x.liquidity/.worktrees/feat/untouchable" }
  ]
}

def "test repo-for-path matches repo file" [] {
  let result = (repo-for-path "/org/st0x.liquidity/docs/cqrs.md" (test-targets) "/org/notes")
  assert equal $result "liquidity"
}

def "test repo-for-path matches worktree over main repo" [] {
  let result = (repo-for-path "/org/st0x.liquidity/.worktrees/feat/untouchable/docs/cqrs.md" (test-targets) "/org/notes")
  assert equal $result "liquidity/worktrees/untouchable"
}

def "test repo-for-path matches notes path to repo" [] {
  let result = (repo-for-path "/org/notes/liquidity/docs/cqrs.md" (test-targets) "/org/notes")
  assert equal $result "liquidity"
}

def "test repo-for-path matches notes path to worktree" [] {
  let result = (repo-for-path "/org/notes/liquidity/worktrees/untouchable/docs/cqrs.md" (test-targets) "/org/notes")
  assert equal $result "liquidity/worktrees/untouchable"
}

def "test repo-for-path returns null for unknown path" [] {
  let result = (repo-for-path "/somewhere/else/file.md" (test-targets) "/org/notes")
  assert equal $result null
}

# --- atomic-cp ---

def "test atomic-cp copies file correctly" [] {
  with-temp-dir {|dir|
    let src = $"($dir)/src.md"
    let dst = $"($dir)/dst.md"
    "hello world" | save $src
    atomic-cp $src $dst
    assert equal (open --raw $dst | str trim) "hello world"
  }
}

def "test atomic-cp does not leave tmp file on success" [] {
  with-temp-dir {|dir|
    let src = $"($dir)/src.md"
    let dst = $"($dir)/dst.md"
    "content" | save $src
    atomic-cp $src $dst
    assert (not ($"($dst).md-sync-tmp" | path exists))
  }
}

# --- guard-empty-overwrite ---

def "test guard-empty-overwrite allows non-empty to overwrite" [] {
  with-temp-dir {|dir|
    let newer = $"($dir)/newer.md"
    let older = $"($dir)/older.md"
    "new content" | save $newer
    "old content" | save $older
    guard-empty-overwrite $newer $older
  }
}

def "test guard-empty-overwrite rejects empty overwrite" [] {
  with-temp-dir {|dir|
    let newer = $"($dir)/newer.md"
    let older = $"($dir)/older.md"
    "" | save $newer
    "real content" | save $older
    try {
      guard-empty-overwrite $newer $older
      assert false "should have errored"
    } catch {|error|
      assert ($error.msg | str contains "refusing to overwrite")
    }
  }
}

# --- sync-file (integration with temp dirs) ---

def with-temp-dir [block: closure] {
  let dir = (mktemp -d)
  try {
    do $block $dir
  } catch {|error|
    rm -rf $dir
    error make { msg: $error.msg }
  }
  rm -rf $dir
}

def "test sync-file copies new file" [] {
  with-temp-dir {|dir|
    let src = $"($dir)/src.md"
    let dst = $"($dir)/dst.md"
    "hello" | save $src
    sync-file $src $dst "test-repo" "src.md"
    assert equal (open --raw $dst | str trim) "hello"
  }
}

def "test sync-file repo-to-notes when src is newer" [] {
  with-temp-dir {|dir|
    let src = $"($dir)/src.md"
    let dst = $"($dir)/dst.md"
    "old content" | save $dst
    sleep 100ms
    "new content" | save $src
    sync-file $src $dst "test-repo" "src.md"
    assert equal (open --raw $dst | str trim) "new content"
  }
}

def "test sync-file notes-to-repo when dst is newer" [] {
  with-temp-dir {|dir|
    let src = $"($dir)/src.md"
    let dst = $"($dir)/dst.md"
    "old content" | save $src
    sleep 100ms
    "new content" | save $dst
    sync-file $src $dst "test-repo" "src.md"
    assert equal (open --raw $src | str trim) "new content"
  }
}

def "test sync-file rejects empty overwriting non-empty" [] {
  with-temp-dir {|dir|
    let src = $"($dir)/src.md"
    let dst = $"($dir)/dst.md"
    "real content here" | save $dst
    sleep 100ms
    "" | save $src
    let original = (open --raw $dst)
    try {
      sync-file $src $dst "test-repo" "src.md"
      assert false "should have errored"
    } catch {|error|
      assert ($error.msg | str contains "refusing to overwrite")
    }
    assert equal (open --raw $dst) $original
  }
}

def "test sync-file no-op when files are identical" [] {
  with-temp-dir {|dir|
    let src = $"($dir)/src.md"
    let dst = $"($dir)/dst.md"
    "same" | save $src
    "same" | save $dst
    let src_mod_before = (ls -l $src | first | get modified)
    sleep 100ms
    sync-file $src $dst "test-repo" "src.md"
    let src_mod_after = (ls -l $src | first | get modified)
    assert equal $src_mod_before $src_mod_after
  }
}

# --- md-files (integration with temp git repo) ---

def "test md-files finds committed md files" [] {
  with-temp-dir {|dir|
    git -C $dir init
    "# readme" | save $"($dir)/README.md"
    "code" | save $"($dir)/main.rs"
    git -C $dir add -A
    git -C $dir commit -m "init"
    let files = (md-files $dir)
    assert ($files | any {|file| $file == "README.md" })
    assert (not ($files | any {|file| $file == "main.rs" }))
  }
}

def "test md-files finds .local files" [] {
  with-temp-dir {|dir|
    git -C $dir init
    "# readme" | save $"($dir)/README.md"
    git -C $dir add -A
    git -C $dir commit -m "init"
    mkdir $"($dir)/.local/prompts"
    "prompt content" | save $"($dir)/.local/prompts/01-setup.md"
    let files = (md-files $dir)
    assert ($files | any {|file| $file == "README.md" })
    assert ($files | any {|file| $file == ".local/prompts/01-setup.md" })
  }
}

# --- full sync-repo integration ---

def "test sync-repo syncs committed files to notes" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    let notes = $"($dir)/notes"
    mkdir $repo
    mkdir $notes
    git -C $repo init
    mkdir $"($repo)/docs"
    "# arch" | save $"($repo)/docs/architecture.md"
    "# readme" | save $"($repo)/README.md"
    git -C $repo add -A
    git -C $repo commit -m "init"
    sync-repo $repo "test-repo" $notes
    assert ($"($notes)/test-repo/README.md" | path exists)
    assert ($"($notes)/test-repo/docs/architecture.md" | path exists)
  }
}

def "test sync-repo maps .local files stripping prefix" [] {
  with-temp-dir {|dir|
    let repo = $"($dir)/repo"
    let notes = $"($dir)/notes"
    mkdir $repo
    mkdir $notes
    git -C $repo init
    "# readme" | save $"($repo)/README.md"
    git -C $repo add -A
    git -C $repo commit -m "init"
    mkdir $"($repo)/.local/prompts"
    "prompt" | save $"($repo)/.local/prompts/01-setup.md"
    sync-repo $repo "test-repo" $notes
    assert ($"($notes)/test-repo/prompts/01-setup.md" | path exists)
    assert (not ($"($notes)/test-repo/.local" | path exists))
  }
}

# --- test runner ---

def main [] {
  print "Running md-sync tests..."
  let tests = (scope commands
    | where ($it.type == "custom") and ($it.name | str starts-with "test ")
    | get name)

  let test_commands = ($tests
    | each {|test_name| $"print '  ok ($test_name)'; ($test_name)" }
    | str join "; ")

  nu --commands $"source ($env.CURRENT_FILE); ($test_commands)"
  print $"(ansi green)All ($tests | length) tests passed(ansi reset)"
}
