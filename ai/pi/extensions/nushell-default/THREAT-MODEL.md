# Nushell-default tool threat model

## Operator questions

1. Did an agent command run through Nushell rather than silently falling back to Bash?
2. Did the override preserve Pi's cancellation, timeout, process-tree cleanup, truncation, and session metadata behavior?
3. Can a model-provided command escape through an added wrapper shell before Nushell parses it?

The tool's typed result and existing Pi tool lifecycle answer these questions; this extension adds no logs or metrics.

## Trust boundaries and assets

- Model-produced command text crosses into the shell parser and is untrusted data.
- Managed executable paths cross from the host generation into extension startup.
- The nearest `.envrc` and `direnv export json` output cross from repository-controlled configuration into the tool subprocess environment. Direnv's own allow decision is the authorization boundary; the extension never reads or bypasses its allow database.
- Command output crosses back into model context and remains subject to Pi's existing truncation and classifier boundaries.
- Assets are repository and host state reachable by commands, command cancellation, bounded output, Pi session metadata confidentiality, the exact working directory, and the exact model-produced command bytes.

## STRIDE

| Threat | Abuse case | Control and regression |
| --- | --- | --- |
| Spoofing | A different executable is presented as Nushell or direnv. | Resolve only bounded managed absolute paths and fail if either required executable is absent. |
| Tampering | Quoting or separators escape an added wrapper, or exported variables rewrite command/cwd/session identity. | Pass Nushell directly as `shellPath`; apply validated exports through `spawnHook`; never rewrite command/cwd; preserve protected `PI_*`, `PWD`, `OLDPWD`, `SHLVL`, and `_` values. |
| Repudiation | Results lose the standard tool lifecycle or silently run without a required allowed environment. | Override the existing `bash` slot with `createBashToolDefinition`; if a discovered `.envrc` cannot produce one valid export, fail the command before execution with a bounded diagnostic. |
| Information disclosure | Unbounded export output or stale session metadata leaks. | Bound export bytes/count/key/value sizes, never render or log exported values, and retain built-in output truncation plus per-call session metadata injection. |
| Denial of service | Direnv evaluation hangs or cancellation/timeout leaves descendants running. | Bound the export subprocess, forward the caller AbortSignal, terminate its process group, and retain built-in command process-tree cleanup. Cache only short-lived validated successful exports. |
| Elevation of privilege | An unallowed `.envrc` executes, stale `DIRENV_*` state skips authorization, or tool renaming bypasses classifier policy. | Clear stale direnv snapshot variables before direct `direnv export json`; rely on direnv's allow decision and fail closed; keep the API name `bash`; skip injection when the explicit command manages direnv or `nix develop` itself. |

No new dependency, network call, credential read, allow-database read, or raw command/environment logging is introduced.
