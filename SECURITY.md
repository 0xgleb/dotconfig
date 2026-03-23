# AI User Isolation

## Overview

A separate macOS user (`ai`) isolates AI tools (Claude Code, etc.) from
sensitive data. The `ai` user physically cannot access files owned by `0xgleb`
unless explicitly granted access via ACLs.

## What's protected

The `ai` user has **no access** to:

- `/Users/0xgleb/.ssh/` -- SSH keys, known_hosts
- `/Users/0xgleb/.gnupg/` -- GPG keys
- `/Users/0xgleb/.config/` -- dotfiles, credentials, API tokens
- Any file owned by `0xgleb` without explicit ACL grant
- 1Password CLI sessions (tied to `0xgleb`'s keychain)

## How it works

### User definition

Declared in `darwin.nix` via nix-darwin:

- **User**: `ai` (UID 502)
- **Home**: `/Users/ai/`
- **Shell**: nushell
- **Git identity**: commits as `0xgleb` (same `user.name`), own SSH key

User configs are the single source of truth in `users.nix`.

### Sudoers

`0xgleb` can run commands as `ai` without a password:

```
0xgleb ALL=(ai) NOPASSWD: SETENV: ALL
```

This does **not** grant `ai` any elevated privileges. It only lets `0xgleb`
switch to the `ai` user conveniently.

### Home-manager

Home-manager configs are split for portability:

| File | Purpose |
|------|---------|
| `homes/shared.nix` | Common config (git, direnv, difftastic, zoxide, fzf, carapace) |
| `homes/0xgleb.nix` | Personal config (neovim, doom-emacs, nushell, zsh, etc.) |
| `homes/ai.nix` | Minimal config (nushell, inherits shared) |

## Usage

### Running AI tools as the ai user

```bash
sudo -u ai claude
sudo -u ai claude --chat
```

The command runs in the current working directory. The `ai` user must have ACL
access to that directory.

### Granting repo access

Use macOS ACLs with inheritance so new files/directories are also accessible:

```bash
# Grant full access to a repo
chmod -R +a "ai allow read,write,execute,delete,append,readattr,writeattr,readextattr,writeextattr,readsecurity,list,search,add_file,add_subdirectory,delete_child,file_inherit,directory_inherit" /path/to/repo

# Deny access to a specific directory within a repo
chmod -R +a "ai deny list,search,read,readattr,readextattr,file_inherit,directory_inherit" /path/to/repo/secrets/

# Revoke all access
chmod -R -a "ai allow read,write,execute,delete,append,readattr,writeattr,readextattr,writeextattr,readsecurity,list,search,add_file,add_subdirectory,delete_child,file_inherit,directory_inherit" /path/to/repo
```

### Setting up the ai user's SSH key

After `darwin-rebuild switch`, generate a key for the `ai` user:

```bash
sudo -u ai ssh-keygen -t ed25519 -C "ai@darwwwin" -f /Users/ai/.ssh/id_ed25519
```

Add the public key to GitHub as a deploy key or SSH key depending on your push
policy.

## Future work

- Per-repo access policy config (declarative, applied via activation script)
- Directory-level restrictions within repos
- Per-repo push policy (auto-approve, manual review, deny)
- Audit logging of `ai` user actions
- Network restrictions (limit which hosts the `ai` user can reach)
- Automatic ACL inheritance verification (detect files that lost ACLs)
