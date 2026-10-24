# Curated from dotconfig help.nu at d68a19c; no deferred commands advertised.
export def show [topic?: string] {
  match $topic {
    null | "" => {
      print (['fj — portable repository and tracker inspection' '' 'USAGE' '  fj                         repository status (But only in managed main)' '  fj issue list [flags]       list issues through gh' '  fj issue view <id>          render an issue' '  fj pr list [flags]          list pull requests through gh' '  fj pr view [id]             render a PR (default: current branch)' '  fj help [issue|pr]          show help' '' 'View flags: --comments (-c), --web (-w; explicitly opens a browser).' 'Caller repository context is preserved. No mutation commands are exposed.'] | str join "\n")
    }
    "issue" => { print "fj issue list [gh flags]\nfj issue view <id> [--comments|-c] [--web|-w]\nUses the caller repository; --web opens a browser." }
    "pr" => { print "fj pr list [gh flags]\nfj pr view [id] [--comments|-c] [--web|-w]\nWithout id, gh resolves the current branch. --web opens a browser." }
    _ => { error make --unspanned {msg: "unknown help topic; use fj help"} }
  }
}
