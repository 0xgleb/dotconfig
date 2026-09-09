# Typed LSP extension threat model

## Trust boundaries

1. **Model tool arguments → extension schema**: paths, positions, symbols, names, selectors, and preview IDs are untrusted until validated.
2. **Project files/configuration → extension core**: paths may be symlinks, change between preview and apply, or contain malformed text positions.
3. **Language-server process → JSON-RPC decoder**: headers, lengths, IDs, methods, diagnostics, locations, commands, and workspace edits are untrusted external data.
4. **Validated preview → filesystem mutation**: a preview can become stale; parallel tools can race; multi-file writes can fail partway through.
5. **Extension lifecycle → child process**: reload, session replacement, cancellation, timeout, and process exit can leave pending requests or orphan processes.

## Assets

- Source files inside the current trusted workspace.
- Files outside the workspace, including credentials and user configuration.
- The integrity of multi-file refactors: all intended text edits apply exactly once or the original files are restored.
- Pi responsiveness, context budget, and child-process capacity.
- User authority: an LSP server response never authorizes a mutation.

## STRIDE analysis

| Threat                 | Concrete abuse                                                                                                                                  | Control and first regression                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | A server response uses another pending request ID or a late response after timeout.                                                             | Match one bounded pending ID once; ignore unknown/settled IDs; test duplicate and late responses.                                                                     |
| Tampering              | A server edits an outside-root path, symlink escape, overlapping ranges, invalid UTF-16 position, snippet, resource operation, or changed file. | Canonical containment, regular-file check, strict bounded decoder, overlap/range validation, text-edits-only first slice, SHA-256 revalidation; each case starts red. |
| Repudiation            | The tool says a refactor applied although only a prefix was written.                                                                            | Typed applied/rolled-back result, exact file list, injected write-failure test, rollback-failure error; never report success on partial mutation.                     |
| Information disclosure | Diagnostics or errors echo arbitrary file contents, server stderr, environment, or outside paths.                                               | Bounded sanitized messages and workspace-relative paths; no environment logging; output cap regression.                                                               |
| Denial of service      | Oversized `Content-Length`, unbounded diagnostics/edits, hung request, request flood, or orphan process.                                        | Frame, message, pending, file, edit, byte, and output caps; timeout cancellation; lazy pool; shutdown kill; abuse tests for every cap.                                |
| Elevation of privilege | `workspace/applyEdit`, a code-action command, or arbitrary raw request mutates or executes without preview.                                     | Reject server-initiated edits, raw requests, commands, and resource operations. Only digest-bound `apply` can mutate. Test each route.                                |

## Required red tests before implementation

- Outside-root and symlink-escape workspace edits are accepted by the missing validator.
- Overlapping, snippet-formatted, out-of-range, and over-cap edits reach preparation.
- `apply` accepts an unknown or stale preview.
- A second file write failure leaves the first file changed.
- A server-initiated `workspace/applyEdit` reaches the filesystem.
- A code action carrying `command` executes or is treated as applicable.
- An oversized frame or diagnostics list is retained unbounded.
- Shutdown leaves a pending request or child process alive.

Each test must fail because the control is absent, then pass after the narrow implementation.

## Accepted first-slice limitation

Multi-file apply is not process-crash-atomic. No-follow descriptors, digest/identity revalidation, post-write verification, and rollback cover live failure paths, but a process or machine crash between writes can leave a completed prefix. The tool must report only observed live success and must not be used where crash-atomic refactors are required until a durable journal or filesystem transaction is added.

## Dependency and supply-chain boundary

The first slice adds no npm, Rust, N-API, broker, or OMP runtime dependency. It uses upstream Pi APIs, `typebox`, and Node standard-library process, stream, path, filesystem, and crypto modules. Language servers are optional user-installed executables discovered by an exact static profile; the extension does not download or install them.

## Explicit exclusions

- No raw LSP request tool.
- No `workspace/executeCommand`.
- No server-initiated edit application.
- No create/delete/rename resource operation.
- No walk above the current Pi cwd.
- No arbitrary project-supplied command in the first slice.
- No fallback that silently converts a malformed edit into a partial or manual replacement.
