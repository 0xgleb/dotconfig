# Typed LSP extension design

## Goal

Give upstream Pi typed language-server navigation and safe refactors without depending on Oh My Pi. The first slice supports status, definition, references, file diagnostics, rename preview/apply, code-action list/preview/apply, and clean shutdown.

## Verified constraints

- Pi extensions can register strict custom tools, render typed `details`, use `withFileMutationQueue`, and clean up session resources on `session_shutdown`.
- Tool calls execute in parallel, so every write window must join Pi's file-mutation queue.
- Language-server output is untrusted external input.
- OMP's LSP subsystem is 24 TypeScript files/9,920 lines and coupled to its SDK, broker, overlays, and edit/write tools. It is reference material, not a suitable dependency.
- OMP rename applies by default and its general workspace-edit path can expose a partially executed prefix. This extension must use preview-first, digest-bound mutation and rollback.
- The first slice may use only optional server executables already on `PATH`. It adds no npm or native dependency.

## Design A: port OMP's subsystem

### Caller

```ts
lsp({
  action: "rename",
  file: "src/a.ts",
  line: 12,
  symbol: "old",
  newName: "next",
})
```

### Shape

Port OMP discovery, JSON-RPC client, shared overlays, workspace-edit engine, startup discovery, deferred diagnostics, renderer, and server profiles. Keep OMP's single broad action schema.

### Ownership

The imported subsystem would own server discovery, process lifecycle, document synchronization, edit/write integration, diagnostics, and rendering.

### Benefits

- Broad language and operation coverage.
- Mature regression corpus.
- Existing write-through integration.

### Costs and failure modes

- Pulls a large fork-specific subsystem across unstable internal boundaries.
- Encourages an `@oh-my-pi/*` dependency or a large copied fork.
- Couples LSP safety to OMP's editor overlays and broker lifecycle.
- Preserves unsafe-for-us defaults such as apply-by-default rename.
- Makes upstream Pi upgrades harder to reason about.

### Falsification

Choose this only if a minimal client independently reproduces repeated protocol/lifecycle bugs that OMP already solves and the required port remains smaller than maintaining those fixes locally.

## Design B: small Pi-native client

### Caller

```ts
lsp({ action: "references", file: "src/a.ts", line: 12, symbol: "old" })
lsp({
  action: "rename_preview",
  file: "src/a.ts",
  line: 12,
  symbol: "old",
  newName: "next",
})
lsp({ action: "apply", previewId: "lsp-preview-v1:…" })
```

### Domain types

- `ServerProfile`: command, arguments, file extensions, root markers, language-ID resolver.
- `WorkspaceRoot`: canonical root contained by the current Pi cwd.
- `LspPosition`: validated zero-based line/character derived from one-based tool input.
- `ValidatedWorkspaceEdit`: text edits only, canonical in-workspace regular files, bounded counts and replacement bytes, non-overlapping ranges, no snippets or resource operations.
- `PreparedWorkspaceEdit`: validated edits plus SHA-256 of every source file and a deterministic preview ID.
- `LspFailure`: tagged expected failures for unsupported file/server/capability, malformed protocol data, timeout, server exit, invalid edit, stale preview, write failure, and rollback failure.

Invalid states are rejected at the boundary. A raw `WorkspaceEdit`, path, range, or preview ID never reaches mutation code.

### Module map

- `protocol.ts`: bounded LSP types and decoders; no I/O.
- `json-rpc.ts`: stdio framing, request IDs, cancellation, process exit, bounded pending map, server-request rejection.
- `servers.ts`: small verified server-profile table and root selection.
- `position.ts`: path containment and symbol-to-position resolution.
- `workspace-edit.ts`: decode, validate, preview, stale-check, queued apply, rollback.
- `client-pool.ts`: lazy one-client-per-profile/root cache; shutdown owns every process.
- `core.ts`: action dispatch and typed result shaping.
- `index.ts`: Pi schema, rendering, runtime registration, and session lifecycle.

Dependencies point from Pi/tool glue toward the protocol and validation core. The validator knows nothing about Pi or the TUI.

### State and lifecycle

1. The first file action selects a static server profile and nearest root marker without walking above `ctx.cwd`.
2. The client pool lazily spawns one stdio process per profile/root.
3. Initialization advertises text-document synchronization and workspace-edit support, but server-initiated `workspace/applyEdit` is always rejected with a typed response. Mutations only enter through a tool preview.
4. `didOpen`/`didChange` synchronize current disk text before each request.
5. Read actions return bounded typed locations or diagnostics. Diagnostics wait through a bounded ordinary analysis window; if the server still has not published a snapshot, the tool returns an explicit retryable pending state with no diagnostics field rather than reporting false clean or misclassifying absence as malformed protocol data.
6. Mutating actions store a prepared preview in the current extension instance. Reload invalidates it.
7. `apply` requires the exact preview ID, reacquires canonical file queues in sorted order, rechecks every digest and file identity, computes every output before writing, uses no-follow file descriptors, verifies each write, and rolls back the executed prefix if a write fails.
8. `session_shutdown` aborts pending requests and terminates every owned process. No process starts in the extension factory.

The first slice is not process-crash-atomic across multiple files. An ordinary write failure rolls back, but a process or machine crash between file writes can leave a completed prefix. Do not claim stronger atomicity; add a durable journal or filesystem transaction before using this boundary where crash-atomic refactors are required.

### Compatibility and migration

- Add one discoverable `lsp` custom tool to the managed extension package.
- Do not override Pi's built-in read/edit/write tools.
- No persisted schema or external config in the first slice.
- Unsupported files and absent binaries return typed errors and leave existing manual tools available.
- Later server profiles or project configuration can extend the stable `ServerProfile` boundary.

### Proof surface

- protocol framing: fragmented and combined frames, malformed headers, oversized messages, exit with pending requests;
- path/range/edit validation: outside-root URI, symlink escape, overlap, out-of-range positions, snippets, resource operations, count/byte caps;
- mutation: preview required, stale digest rejection, sorted queues, all outputs computed before first write, rollback after an injected write failure;
- lifecycle: lazy spawn, reuse, shutdown, timeout cancellation, delayed initial diagnostics, server-initiated edit rejection;
- behavior: fake server definition/references/diagnostics, typed pending diagnostics without false-clean claims, rename preview/apply, code-action preview/apply, unsupported capability;
- TUI: narrow/wide bounded rendering and collapsed/expanded preview.

### Falsification

Revisit the design if two independent server families require the same missing overlay, configuration, or transport behavior and the local workaround leaks protocol knowledge into callers. Do not add a broker or general raw-request escape hatch before that evidence exists.

## Choice

Use Design B. It keeps the mutation invariant in one deep module, has no OMP/native dependency, matches Pi's extension lifecycle, and makes preview/apply authority explicit. Design A loses on locality, dependency direction, and rollback safety.

## First vertical slices

1. Pure path, position, edit decoder, preview digest, and abuse tests.
2. JSON-RPC client with a fake server and lifecycle tests.
3. Status, definition, references, and diagnostics.
4. Rename preview plus digest-bound apply.
5. Code-action list/preview/apply for edit-only actions; reject commands.
6. Tool renderer, package registration, focused regression run, and live reload.
