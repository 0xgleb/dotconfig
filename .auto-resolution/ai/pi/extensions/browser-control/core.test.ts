import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  BROWSER_ACTIONS,
  BROWSER_TARGET_ENTRY,
  browserActivityLabel,
  collectBoundedResponseBytes,
  launchServicesRequest,
  parseCdpResponse,
  parseDebugTargets,
  parseEvaluationResult,
  parseLocalPageUrl,
  latestBrowserTargetId,
  parseBrowserTargetMarker,
  publicTarget,
  selectActiveTarget,
  selectReusableTarget,
} from "./core.ts"

const browserExtension = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
)

const recordedTarget = {
  description: "",
  devtoolsFrontendUrl:
    "/devtools/inspector.html?ws=localhost:9222/devtools/page/DAB7",
  id: "DAB7",
  title: "Dashboard",
  type: "page",
  url: "http://127.0.0.1:5173/health",
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/DAB7",
}

test("browser exposes a direct bounded loopback fetch action", () => {
  assert.deepEqual(BROWSER_ACTIONS, ["status", "open", "text", "fetch"])
  const bytes = collectBoundedResponseBytes(
    [new TextEncoder().encode('{"ok":'), new TextEncoder().encode("true}")],
    64,
  )
  assert.equal(new TextDecoder().decode(bytes), '{"ok":true}')
  assert.throws(
    () =>
      collectBoundedResponseBytes([new Uint8Array(40), new Uint8Array(30)], 64),
    /exceeded.*64-byte/i,
  )
})

test("direct loopback fetch is GET-only, bounded, credential-free, and refuses redirects", () => {
  assert.match(browserExtension, /method: "GET"/)
  assert.match(browserExtension, /redirect: "manual"/)
  assert.match(browserExtension, /MAX_LOOPBACK_RESPONSE_BYTES/)
  assert.match(browserExtension, /Loopback API redirects are not followed/)
  assert.doesNotMatch(browserExtension, /Authorization|Cookie/)
})

test("browser activity labels distinguish scoped active control from an idle operator", () => {
  assert.equal(browserActivityLabel("idle"), "browser:idle · isolated")
  assert.equal(
    browserActivityLabel("active", "text"),
    "browser:active:text · isolated",
  )
})

test("browser actions expose no arbitrary script evaluation", () => {
  assert.deepEqual(BROWSER_ACTIONS, ["status", "open", "text", "fetch"])
  assert.equal(BROWSER_ACTIONS.includes("eval" as never), false)
})

test("browser pages use an isolated operator profile through the Brave app identity", () => {
  const url = parseLocalPageUrl("http://127.0.0.1:5173/")
  const request = launchServicesRequest(
    url,
    "/Users/example/Library/Application Support/Pi/Brave Operator",
    9222,
  )
  assert.deepEqual(request, {
    command: "/usr/bin/open",
    args: [
      "-n",
      "-a",
      "Brave Browser",
      "--args",
      "--user-data-dir=/Users/example/Library/Application Support/Pi/Brave Operator",
      "--remote-debugging-port=9222",
      "--no-first-run",
      "--no-default-browser-check",
      url,
    ],
  })
  assert.equal(request.args.includes("--args"), true)
  assert.equal(
    request.args.some(arg => arg.startsWith("--user-data-dir=")),
    true,
  )
  assert.equal(
    request.args.some(arg => arg === "--remote-debugging-port=9222"),
    true,
  )
})

test("local page URLs accept only loopback HTTP origins without credentials", () => {
  assert.equal(
    parseLocalPageUrl("http://127.0.0.1:5173/health"),
    "http://127.0.0.1:5173/health",
  )
  assert.equal(
    parseLocalPageUrl("https://localhost/dashboard"),
    "https://localhost/dashboard",
  )
  assert.equal(parseLocalPageUrl("http://[::1]:3000/"), "http://[::1]:3000/")

  for (const input of [
    "https://example.com",
    "file:///tmp/dashboard.html",
    "http://localhost.example.com",
    "http://user:password@127.0.0.1:5173",
  ]) {
    assert.throws(() => parseLocalPageUrl(input), /loopback|credentials|HTTP/i)
  }
})

test("debug target decoder accepts the documented Chromium response and rejects malformed data", () => {
  assert.deepEqual(parseDebugTargets([recordedTarget], 9222), [
    {
      id: "DAB7",
      title: "Dashboard",
      type: "page",
      url: "http://127.0.0.1:5173/health",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/DAB7",
    },
  ])
  assert.throws(
    () => parseDebugTargets({ targets: [recordedTarget] }, 9222),
    /array/i,
  )
  assert.throws(
    () => parseDebugTargets([{ ...recordedTarget, id: 42 }], 9222),
    /target/i,
  )
  assert.throws(
    () =>
      parseDebugTargets(
        [
          {
            ...recordedTarget,
            webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/DAB7",
          },
        ],
        9222,
      ),
    /debugging endpoint/i,
  )
})

test("an existing exact-URL operator target is reused instead of duplicated", () => {
  const [target] = parseDebugTargets([recordedTarget], 9222)
  const other = {
    ...target,
    id: "OTHER",
    url: parseLocalPageUrl("http://127.0.0.1:5173/other"),
  }
  assert.equal(
    selectReusableTarget([other, target], target.url, undefined),
    target,
  )
  assert.equal(
    selectReusableTarget(
      [target, { ...target, id: "NEWER" }],
      target.url,
      "NEWER",
    )?.id,
    "NEWER",
  )
  assert.equal(selectReusableTarget([other], target.url, undefined), undefined)
})

test("the explicitly opened local target survives a managed Pi reload", () => {
  const persisted = {
    type: "custom",
    customType: BROWSER_TARGET_ENTRY,
    data: { targetId: "DAB7" },
  }
  assert.deepEqual(parseBrowserTargetMarker(persisted.data), {
    targetId: "DAB7",
  })
  assert.equal(latestBrowserTargetId([persisted]), "DAB7")
  assert.equal(
    latestBrowserTargetId([
      persisted,
      { ...persisted, data: { targetId: "NEWER" } },
    ]),
    "NEWER",
  )
  assert.equal(parseBrowserTargetMarker({ targetId: "" }), undefined)
  assert.equal(
    parseBrowserTargetMarker({ targetId: "x".repeat(513) }),
    undefined,
  )
  assert.equal(parseBrowserTargetMarker({ targetId: 7 }), undefined)
  assert.match(
    browserExtension,
    /activeTargetId = latestBrowserTargetId\(ctx\.sessionManager\.getBranch\(\)\)/,
  )
  assert.match(
    browserExtension,
    /pi\.appendEntry\(BROWSER_TARGET_ENTRY, \{ targetId: opened\.target\.id \}\)/,
  )
})

test("only the explicitly opened local target can become active", () => {
  const [target] = parseDebugTargets([recordedTarget], 9222)
  assert.equal(selectActiveTarget([target], "DAB7"), target)
  assert.throws(() => selectActiveTarget([target], undefined), /opened/i)
  assert.throws(() => selectActiveTarget([target], "OTHER"), /opened/i)
})

test("public target details cannot disclose the debugger websocket", () => {
  const [target] = parseDebugTargets([recordedTarget], 9222)
  assert.deepEqual(publicTarget(target), {
    id: "DAB7",
    title: "Dashboard",
    type: "page",
    url: "http://127.0.0.1:5173/health",
  })
  assert.equal("webSocketDebuggerUrl" in publicTarget(target), false)
})

test("CDP responses are narrowed at the websocket boundary", () => {
  assert.deepEqual(parseCdpResponse('{"id":7,"result":{"value":"ok"}}'), {
    kind: "result",
    id: 7,
    result: { value: "ok" },
  })
  assert.deepEqual(
    parseCdpResponse(
      '{"id":8,"error":{"message":"bad command","data":"details"}}',
    ),
    {
      kind: "error",
      id: 8,
      message: "details",
    },
  )
  assert.equal(parseCdpResponse('{"method":"Page.loadEventFired"}'), undefined)
  assert.throws(() => parseCdpResponse('{"id":"7","result":{}}'), /CDP/i)
  assert.throws(() => parseCdpResponse("not json"), /CDP/i)
})

test("Runtime.evaluate results are narrowed without casts", () => {
  assert.deepEqual(
    parseEvaluationResult({
      result: { type: "object", value: { title: "Dashboard" } },
    }),
    {
      title: "Dashboard",
    },
  )
  assert.equal(
    parseEvaluationResult({
      result: { type: "string", description: "fallback" },
    }),
    "fallback",
  )
  assert.throws(
    () =>
      parseEvaluationResult({
        exceptionDetails: {
          text: "Uncaught",
          exception: { description: "boom" },
        },
      }),
    /boom/,
  )
  assert.throws(
    () => parseEvaluationResult({ result: "wrong" }),
    /Runtime.evaluate/i,
  )
})
