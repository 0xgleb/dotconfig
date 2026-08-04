# 08. Extension-based transport for Pi browser control

- Status: Proposed
- Date: 2026-08-03
- Issue: https://github.com/0xgleb/dotconfig/issues/47

## Context

Pi's browser control (`ai/pi/extensions/browser-control`) launches the agent
Brave profile with `--remote-debugging-port` and drives it over raw CDP. Two
problems with that arrangement are recorded in issue #47: the connection
mechanism is ad hoc next to a dedicated browser extension of the
Claude-in-Chrome kind, and action visibility is a bare text indicator in a page
corner rather than a visible overlay while the agent acts.

The transport choice is expensive to reverse: it fixes the protocol boundary
between the Pi host and the browser, the security surface exposed on the
machine, how the operator profile is provisioned, and what the in-page
visibility layer can render. The standing constraint from `ai/pi/AGENTS.md`
holds regardless: automation touches only the dedicated agent Brave profile
(local data under `ai/pi/brave-operator-profile/`), never a personal profile.
A raw debugging port is also an unauthenticated local control surface for any
process on the machine, and Chromium keeps tightening flag-based debugging,
so the current mechanism is both the least safe and the least durable option.

## Decision

Rebuild browser control around a dedicated browser extension installed only
in the agent Brave profile, mirroring the Claude-in-Chrome shape:

- A repo-owned MV3 extension (`ai/pi/browser-extension/`) is loaded unpacked
  into the operator profile at provisioning time.
- Transport: the Pi `browser-control` extension runs a loopback-only
  WebSocket server; the browser extension's service worker dials out to it
  and authenticates with a per-provisioning token in its hello frame. No
  remote-debugging flag, no open unauthenticated port.
- The wire protocol is versioned and typed on both ends
  (`browser-control/extension-protocol.ts`); actions execute through
  extension APIs instead of CDP, and every frame is fail-closed validated.
- Visibility: a content script renders an in-page overlay (highlight and
  action label animation) for tab-targeted actions, replacing the corner
  text indicator.
- The host refuses to serve when the connected profile is not the operator
  profile, preserving the existing confinement guarantee.

### Trust boundary and token custody

- The artifact, the operator profile directory, and the Pi host share one
  local trust root: provisioning installs the extension from the repo
  checkout and mints the token into the profile in the same step, so host
  and artifact always come from the same commit. A local attacker who can
  rewrite `ai/pi/browser-extension/` or the profile directory is already
  inside the machine boundary — the same class as tampering with the Pi
  extension itself — and is scoped in `browser-control/THREAT-MODEL.md`,
  which this work rewrites. The record does not pretend the handshake
  attests more than that.
- The token lives only in the service worker's `chrome.storage.session`
  with access restricted to trusted extension contexts — never
  `storage.local`, never `storage.sync`, never readable by content scripts.
  The overlay content script receives only overlay frames over runtime
  messaging; it can never read the token or emit act results.
- The host accepts a connection only when all of these hold: the socket is
  loopback, the HTTP `Origin` is the provisioned extension's
  `chrome-extension://` identity, the hello token matches the current
  provisioning, and the hello `profilePath` names the operator profile.
  Token possession is treated as possession of the provisioned profile,
  nothing stronger; re-provisioning rotates the token.

### Protocol compatibility

- Exactly one protocol version is supported at a time; an unknown version,
  kind, field, or bound violation rejects the whole frame (shipped and
  tested in `extension-protocol.ts`). There is no cross-version
  negotiation: host and artifact ship from the same repo commit and
  re-provisioning re-pins both, so a version bump is a deliberate breaking
  change, not a runtime compatibility case.
- Every act frame carries a request id and is answered by exactly one
  result frame; a result for an already-settled or unknown request id is
  dropped without effect, which is also the replay posture. Payload bounds
  (text size, tab list length, label and error lengths) are constants of
  the protocol module.

### Action contract

| Action | Execution | Target | Extension permission | Bounds and failure |
| --- | --- | --- | --- | --- |
| `status` | extension, `chrome.tabs.query` | none (profile-wide) | `tabs` | bounded tab list; failure -> failed result |
| `open` | extension, `chrome.tabs.create`/`update` | the opened tab | `tabs` | loopback-validated URL; overlay start/finish |
| `text` | extension, `chrome.scripting.executeScript` | active operator tab | `scripting` + loopback host permissions | bounded text; overlay start/finish |
| `fetch` | Pi host, direct loopback GET (unchanged code path) | none | none (no extension involvement) | GET-only, bounded, redirect-refusing, as today |

- `host_permissions` are exactly the loopback origins the current CDP path
  already accepts (`http://127.0.0.1/*`, `http://localhost/*`,
  `https://localhost/*`, `http://[::1]/*`) — never `<all_urls>`; the only
  other permissions are `tabs`, `scripting`, and `storage`.
- The protocol reserves a `fetch` act frame so the host may later delegate
  fetches to the extension without a protocol change, but this decision
  keeps `fetch` host-side.

## Alternatives Considered

### Keep raw CDP via --remote-debugging-port
- Pros: already implemented; full CDP capability surface; no extension to
  maintain.
- Cons: unauthenticated localhost control surface any local process can
  reach; depends on a launch flag Chromium is progressively restricting; no
  in-page presence to hang an overlay on; it is the mechanism issue #47 was
  filed against.
- Rejected because: it is the least safe and least durable of the options, and
  it cannot deliver the in-page visibility the same issue asks for.

### Native messaging host
- Pros: Chrome-sanctioned transport with no listening socket; process
  lifetime tied to the extension.
- Cons: requires per-browser, per-profile host-manifest registration managed
  outside the profile directory; spawns a separate host process with an
  awkward lifecycle next to the long-lived Pi extension; per-message size
  limits complicate page-text transfer.
- Rejected because: registration and process-lifecycle burden buys nothing
  over a token-authenticated loopback WebSocket the Pi extension already has
  the runtime to serve.

### Playwright/puppeteer automation layer
- Pros: rich, well-tested automation API; handles waiting and navigation
  semantics.
- Cons: still drives the browser over CDP underneath, inheriting the same
  flag and port objections; heavy dependency inside the Pi extension
  runtime; owns the whole browser rather than cooperating with a live
  profile session.
- Rejected because: it repackages the rejected transport instead of
  replacing it.

### Overlay-only patch on the current CDP transport
- Pros: smallest diff to fix visibility.
- Cons: leaves the transport objection untouched; overlay injection via CDP
  script evaluation is exactly the kind of bolt-on the issue calls hacky.
- Rejected because: it addresses one of the two recorded problems and
  entrenches the other.

## Consequences

- The repo gains a versioned browser-extension artifact and a provisioning
  step that installs it and mints the token in one operation; profile
  setup is the only place the extension and token are trusted from.
- The action surface becomes whatever the extension APIs express, under the
  permission matrix above. Future CDP-only capabilities (e.g. network
  interception) would need their own decision.
- Tab-targeted actions (`open`, `text`) become visibly attributable through
  the in-page overlay; `status` and host-side `fetch` have no page target
  and keep the session activity label as their visibility. The overlay
  never sees the token, so the visibility layer cannot widen the secret
  boundary.
- `browser-control/THREAT-MODEL.md` must be rewritten for the new surface:
  token custody and rotation on re-provisioning, socket origin checks, the
  shared local trust root, and the extension update path.
- Blast radius if wrong: the Pi-side action API (`status`, `open`, `text`,
  `fetch`) is the stable surface, so a reversal swaps the transport layer
  and the extension artifact without rewriting Pi callers; the single
  supported protocol version means a reversal never has to bridge mixed
  host/extension generations.
