# Pi browser control threat model

The `browser` tool treats every model-supplied argument and every DevTools
response as untrusted input. Its intended capability is limited to opening and
reading loopback HTTP pages in the user's existing Brave app.

## Trust boundaries and assets

- **Model → extension:** action and URL tool arguments are untrusted. URLs must
  remain on exact loopback hosts and arbitrary JavaScript is not an exposed
  action.
- **Extension → macOS LaunchServices:** the extension may ask `/usr/bin/open` to
  open a validated loopback URL in `Brave Browser`. It never launches Brave's
  app binary, passes `--args`, creates a profile, or requests a new app instance.
- **Brave DevTools → extension:** the optional loopback DevTools HTTP and
  WebSocket responses are untrusted and decoded before use. DevTools endpoint
  URLs are never returned to the model.
- **Protected assets:** macOS Brave app identity/window grouping, the operator's
  chosen profile and cookies, unrelated tabs, DevTools connection URLs, and any
  non-loopback browsing state.

Remote debugging is optional and must be configured manually for the existing
operator profile on port 9222. When unavailable, Pi still opens the page through
LaunchServices but refuses text inspection. Pi does not silently start another
Brave process to obtain debugging access.

## STRIDE controls

| Threat | Concrete risk | Control |
| --- | --- | --- |
| Spoofing | Another page or local process pretends to be the requested target | Only an exact loopback URL opened through this extension may become active; target IDs and debugger URLs are validated |
| Tampering | Model arguments or malformed CDP data alter navigation or command handling | URL and every HTTP/WebSocket response cross explicit decoders; CDP method names and JavaScript expressions are fixed in source |
| Repudiation | Hidden browser launch behavior cannot be distinguished from user activity | Launch behavior is a single inspectable LaunchServices request with no hidden Brave flags |
| Information disclosure | Unrelated tabs, cookies, or DevTools URLs reach the model | Target selection requires the explicitly opened target; public details omit the debugger WebSocket; page text is bounded |
| Denial of service | Browser or DevTools calls hang the Pi session | LaunchServices, HTTP, WebSocket, CDP, and target discovery all have finite timeouts |
| Elevation of privilege | Model gains arbitrary browser scripting or remote navigation | Tool actions are the closed set `status`, `open`, and `text`; URLs are exact loopback HTTP(S); no model-supplied script is evaluated |

## Abuse cases encoded by tests

- A prompt attempts to navigate to a remote site, local file, deceptive
  `localhost` suffix, or URL with embedded credentials.
- Browser launch attempts to bypass LaunchServices, pass Brave flags, create a
  user-data directory, or request remote debugging automatically.
- A prompt attempts to run arbitrary page JavaScript or select another browser
  debugging port.
- A debug endpoint returns malformed target or command-response data.
- A target other than the one explicitly opened by this extension is selected.
- Tool details disclose a DevTools WebSocket URL.

## Upstream contracts

`/usr/bin/open -a "Brave Browser" <url>` follows the macOS LaunchServices CLI
contract and reuses the registered app unless `-n` is supplied; this extension
never supplies `-n` or `--args`.

The recorded target fixture in `core.test.ts` follows Chromium's documented
remote-debugging HTTP endpoint response. Chromium documents `/json/list` and
the WebSocket command transport at
<https://chromedevtools.github.io/devtools-protocol/>. Chrome's remote-debugging
restrictions are why setup is explicit and manual rather than silently attaching
to a default profile:
<https://developer.chrome.com/blog/remote-debugging-port>.
