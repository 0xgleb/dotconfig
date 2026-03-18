# Nushell Cheatsheet
# Run: source ~/.config/nushell/cheatsheet.nu (or just read this file)

# ╭─────────────────────────────────────────╮
# │ Navigation                               │
# ╰─────────────────────────────────────────╯
# z <partial>          jump to directory (zoxide, learns from cd usage)
# zi                   interactive zoxide picker
# cd -                 go back to previous directory
# ls | sort-by size    list files sorted by size
# ls **/*.nix          glob listing

# ╭─────────────────────────────────────────╮
# │ History & Search                         │
# ╰─────────────────────────────────────────╯
# ctrl+r               fuzzy history search (atuin)
# history              show history as a table
# history | where command =~ "docker"    search history
# atuin search <query>                   search from CLI

# ╭─────────────────────────────────────────╮
# │ Pipes & Tables                           │
# ╰─────────────────────────────────────────╯
# ls | where size > 1mb                  filter files by size
# ls | sort-by modified -r               newest first
# ps | where name =~ "nvim"             find processes
# ps | where cpu > 10                    high cpu processes
# open file.json                         parse json/yaml/toml/csv automatically
# open file.json | get key.nested        extract nested value
# open file.json | to yaml               convert between formats
# $env | transpose key value             show env vars as table
# sys host                               system info

# ╭─────────────────────────────────────────╮
# │ Strings & Data                           │
# ╰─────────────────────────────────────────╯
# "hello" | str upcase                   string operations
# "hello world" | split row " "          split into list
# [1 2 3] | each { $in * 2 }            map over list
# [1 2 3] | reduce { |it, acc| $acc + $it }   fold
# 1..10 | where { $in mod 2 == 0 }      filter range

# ╭─────────────────────────────────────────╮
# │ Files & Text                             │
# ╰─────────────────────────────────────────╯
# open file.txt                          read file (auto-detects format)
# open file.txt | lines                  read as lines
# "content" | save file.txt              write file
# "more" | save -a file.txt             append to file
# glob **/*.log                          find files by pattern

# ╭─────────────────────────────────────────╮
# │ Logs & Debugging                         │
# ╰─────────────────────────────────────────╯
# open /tmp/sync-notes.out | lines | last 50        tail syncNotes log
# ls /var/log/ | sort-by modified -r                 recent log files
# open ~/Library/Logs/ | sort-by modified -r         macOS app logs
# launchctl list | lines                             running launchd services
# launchctl print gui/(id -u)                        user agent details
# journalctl (nixos only)                            systemd logs
#
# log locations:
#   /tmp/sync-notes.out            syncNotes service
#   ~/Library/Logs/                macOS application logs
#   /var/log/                      system logs
#   /nix/var/log/                  nix build logs

# ╭─────────────────────────────────────────╮
# │ Nix-specific                             │
# ╰─────────────────────────────────────────╯
# which <cmd>                            check if command is from nix store
# $env.PATH | each { |p| {path: $p, nix: ($p | str starts-with "/nix")} }
#                                        audit PATH for non-nix entries
# darwin-rebuild switch --flake ~/.config     rebuild system
# darwin-rebuild build --flake ~/.config      build without applying
# nix run nixpkgs#<pkg>                       one-off tool without installing
# nix-store -q --references /nix/store/<hash>   show package dependencies

# ╭─────────────────────────────────────────╮
# │ Completions (carapace)                   │
# ╰─────────────────────────────────────────╯
# tab                  complete word-by-word (ghost text) or open menu
# carapace ships completions for git, docker, gh, cargo, kubectl, etc.
# they activate automatically — just tab after typing a command + space

# ╭─────────────────────────────────────────╮
# │ Nushell vs Bash/Zsh Translation          │
# ╰─────────────────────────────────────────╯
# bash: echo $VAR          nushell: $env.VAR or echo $env.VAR
# bash: export X=1         nushell: $env.X = "1"
# bash: cmd > /dev/null    nushell: cmd | ignore
# bash: cmd 2>&1           nushell: cmd err>| str join  (or just run it)
# bash: $(cmd)             nushell: (cmd)
# bash: cmd1 | cmd2        nushell: cmd1 | cmd2  (same, but structured data)
# bash: if [ -f x ]; then  nushell: if ("x" | path exists) { }
# bash: for f in *.txt     nushell: for f in (glob *.txt) { }
# bash: cmd &              nushell: not supported (use par-each for parallel work)
# bash: source .env        nushell: open .env | lines | parse "{k}={v}" | transpose -r -d | load-env
