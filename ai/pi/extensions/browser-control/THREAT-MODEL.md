# Pi browser control threat model

The `browser` tool treats every model-supplied argument and every DevTools
response as untrusted input. Its capability is limited to opening and reading
loopback HTTP pages in a dedicated Brave operator profile.

## Trust boundaries and assets

- **Model → extension:** action and URL arguments are untrusted. URLs must remain
  on exact loopback hosts and arbitrary JavaScript is not exposed.
- **Extension → macOS LaunchServices:** first launch uses `/usr/bin/open -n -a
  "Brave Browser" --args ...`, preserving Brave's bundle identity while forcing
  a dedicated user-data directory and debugging port. It never routes an
  operator URL through the already-running main profile.
- **Existing operator → extension:** once the dedicated debugging endpoint is
  ready, new pages are created through its `/json/new` endpoint instead of
  launching more Brave instances.
- **Brave DevTools → extension:** HTTP and WebSocket responses are untrusted and
  decoded before use. Debugger endpoint URLs are never returned to the model.
- **Protected assets:** the user's main Brave profile, unrelated tabs and
  cookies, macOS app identity/window grouping, debugger URLs, and non-loopback
  browsing state.

The isolated profile lives under `~/Library/Application Support/Pi/Brave
Operator`, outside the configuration repository and the user's main Brave data.

## STRIDE controls

| Threat | Concrete risk | Control |
| --- | --- | --- |
| Spoofing | Another page or process pretends to be the operator target | Dedicated debug port; only exact loopback targets opened by this extension may become active; target IDs and debugger URLs are validated |
| Tampering | Model arguments or malformed CDP data alter navigation or command handling | URL and every HTTP/WebSocket response cross explicit decoders; CDP methods and JavaScript expressions are fixed in source |
| Repudiation | Hidden launch behavior cannot be distinguished from user activity | Launch request is a single tested LaunchServices argument vector with explicit isolation flags; Pi shows a persistent isolated-browser status and the operator page carries a fixed active/idle badge |
| Information disclosure | Main-profile tabs, cookies, or debugger URLs reach the model | Separate user-data directory; target selection requires the explicitly opened target; public details omit the debugger WebSocket; page text is bounded |
| Denial of service | Browser or DevTools calls hang Pi or spawn repeatedly | Finite timeouts; an existing operator is reused through `/json/new` |
| Elevation of privilege | Model gains arbitrary scripting or remote navigation | Closed actions `status`, `open`, and `text`; URLs are exact loopback HTTP(S); only source-fixed page text and activity-indicator expressions run—no model-supplied script is evaluated |

## Abuse cases encoded by tests

- A prompt attempts a remote site, local file, deceptive `localhost` suffix, or
  URL with embedded credentials.
- Launch omits the new-instance, dedicated user-data, or debug-port flags and
  could therefore enter the main profile.
- A prompt attempts arbitrary page JavaScript or another debugging port.
- A debug endpoint returns malformed target or command-response data.
- A target other than the explicitly opened operator target is selected.
- Tool details disclose a DevTools WebSocket URL.

## Upstream contracts

`/usr/bin/open -n -a "Brave Browser" --args ...` uses macOS LaunchServices to
start a new instance under Brave's registered bundle identity. Chromium's
`--user-data-dir` isolates profile state and `--remote-debugging-port` exposes
the dedicated local debugging endpoint.

The recorded target fixture follows Chromium's documented `/json/list` and
WebSocket contracts:
<https://chromedevtools.github.io/devtools-protocol/>.
