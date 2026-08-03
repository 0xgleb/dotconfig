# 08. Extension-based transport for Pi browser control

- Status: Proposed
- Date: 2026-08-03
- Issue: https://github.com/0xgleb/dotconfig/issues/47

## Context

Pi's browser control (`ai/pi/extensions/browser-control`) launches the agent
Brave profile with `--remote-debugging-port` and drives it over raw CDP. The
owner recorded two objections (issue #47): the connection mechanism is hacky
compared to Claude-in-Chrome's dedicated browser extension, and action
visibility is a bare text indicator in a page corner rather than a visible
overlay while the agent acts.

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
  WebSocket server with a per-profile token provisioned into the browser
  extension's storage; the extension's service worker dials out to it. No
  remote-debugging flag, no open unauthenticated port.
- The wire protocol is versioned and typed on both ends; actions execute
  through extension APIs (`chrome.tabs`, `chrome.scripting`) instead of CDP,
  and every action/result frame is fail-closed validated.
- Visibility: a content script renders an in-page overlay (highlight and
  action label animation) driven by the same protocol frames, replacing the
  corner text indicator.
- The host refuses to serve when the connected profile is not the operator
  profile, preserving the existing confinement guarantee.

## Alternatives Considered

### Keep raw CDP via --remote-debugging-port
- Pros: already implemented; full CDP capability surface; no extension to
  maintain.
- Cons: unauthenticated localhost control surface any local process can
  reach; depends on a launch flag Chromium is progressively restricting; no
  in-page presence to hang an overlay on; explicitly named as the objection
  in issue #47.
- Rejected because: the owner directed the rebuild, and the mechanism is the
  least safe and least durable of the options.

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
  step that installs and pins it in the operator profile; profile setup is
  the only place the extension is trusted from.
- The action surface becomes whatever the extension APIs express. The
  current actions (`status`, `open`, `text`, `fetch`) all map; future
  CDP-only capabilities (e.g. network interception) would need their own
  decision.
- The typed wire protocol becomes a real boundary with tests on both sides;
  `browser-control/THREAT-MODEL.md` must be rewritten for the new surface
  (token custody, socket origin checks, extension update path).
- Action visibility becomes first-class: the overlay renders from protocol
  frames, so every agent action is visibly attributable in-page.
- Blast radius if wrong: the Pi-side action API is kept stable, so a
  reversal swaps the transport layer and the extension artifact without
  rewriting Pi callers.
