import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { Effect, Option } from "effect"
import {
  BROWSER_ACTIONS,
  BROWSER_TARGET_ENTRY,
  BrowserControlError,
  browserActivityLabel,
  collectBoundedResponseBytes,
  createSerialActivityUpdater,
  createSerialExecutor,
  debugEndpointReadiness,
  discoverOpenedTarget,
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

const run = <T>(effect: Effect.Effect<T, unknown>): T => Effect.runSync(effect)
const optional = <T>(
  effect: Effect.Effect<Option.Option<T>, unknown>,
): T | undefined => Option.getOrUndefined(run(effect))

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
  const bytes = run(
    collectBoundedResponseBytes(
      [new TextEncoder().encode('{"ok":'), new TextEncoder().encode("true}")],
      64,
    ),
  )
  assert.equal(new TextDecoder().decode(bytes), '{"ok":true}')
  assert.throws(
    () =>
      run(
        collectBoundedResponseBytes(
          [new Uint8Array(40), new Uint8Array(30)],
          64,
        ),
      ),
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

test("page activity updates remain ordered across overlapping operations", async () => {
  const started: boolean[] = []
  const completed: boolean[] = []
  let releaseIdle: (() => void) | undefined
  const idleGate = new Promise<void>(resolve => {
    releaseIdle = resolve
  })
  const update = createSerialActivityUpdater(async active => {
    started.push(active)
    if (!active) await idleGate
    completed.push(active)
  })

  const idle = update(false)
  const active = update(true)
  await Promise.resolve()
  assert.deepEqual(started, [false])
  releaseIdle?.()
  await Promise.all([idle, active])
  assert.deepEqual(started, [false, true])
  assert.deepEqual(completed, [false, true])
})

test("overlapping browser opens execute in invocation order", async () => {
  const started: string[] = []
  const completed: string[] = []
  let releaseFirst: (() => void) | undefined
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve
  })
  const execute = createSerialExecutor(async (name: string) => {
    started.push(name)
    if (name === "first") await firstGate
    completed.push(name)
    return name
  })

  const first = execute("first")
  const second = execute("second")
  await Promise.resolve()
  assert.deepEqual(started, ["first"])
  releaseFirst?.()
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"])
  assert.deepEqual(started, ["first", "second"])
  assert.deepEqual(completed, ["first", "second"])
})

test("serialized browser opens continue after a rejected operation", async () => {
  const executed: string[] = []
  const execute = createSerialExecutor(async (name: string) => {
    executed.push(name)
    return name === "first"
      ? Promise.reject(new Error("first open failed"))
      : name
  })

  const first = execute("first")
  const second = execute("second")
  await assert.rejects(first, /first open failed/)
  assert.equal(await second, "second")
  assert.deepEqual(executed, ["first", "second"])
})

test("browser actions expose no arbitrary script evaluation", () => {
  assert.deepEqual(BROWSER_ACTIONS, ["status", "open", "text", "fetch"])
  assert.equal(BROWSER_ACTIONS.includes("eval" as never), false)
})

test("opened-target discovery retries transient debug startup failures", async () => {
  const url = run(parseLocalPageUrl(recordedTarget.url))
  const target = run(parseDebugTargets([recordedTarget], 9222))[0]
  if (!target) assert.fail("expected one valid debug target")

  let attempts = 0
  let now = 0
  const opened = await Effect.runPromise(
    discoverOpenedTarget(url, new Set(), 1_000, 100, {
      listTargets: () => {
        attempts += 1
        if (attempts === 1)
          return Effect.fail(
            new BrowserControlError({
              code: "unavailable",
              message: "debug endpoint is starting",
            }),
          )
        if (attempts === 2)
          return Effect.fail(
            new BrowserControlError({
              code: "timeout",
              message: "debug endpoint is not ready",
            }),
          )
        return Effect.succeed([target])
      },
      now: () => now,
      sleep: milliseconds =>
        Effect.sync(() => {
          now += milliseconds
        }),
    }),
  )

  assert.equal(attempts, 3)
  assert.equal(opened?.id, target.id)
})

test("opened-target discovery fails closed on protocol errors", async () => {
  const url = run(parseLocalPageUrl(recordedTarget.url))
  let attempts = 0
  const result = await Effect.runPromise(
    Effect.either(
      discoverOpenedTarget(url, new Set(), 1_000, 100, {
        listTargets: () => {
          attempts += 1
          return Effect.fail(
            new BrowserControlError({
              code: "protocol",
              message: "malformed debug response",
            }),
          )
        },
        now: () => 0,
        sleep: () => Effect.void,
      }),
    ),
  )
  assert.equal(result._tag, "Left")
  if (result._tag === "Left") assert.equal(result.left.code, "protocol")
  assert.equal(attempts, 1)
})

test("opened-target discovery preserves late protocol failures", async () => {
  const url = run(parseLocalPageUrl(recordedTarget.url))
  let now = 0
  const result = await Effect.runPromise(
    Effect.either(
      discoverOpenedTarget(url, new Set(), 100, 25, {
        listTargets: () =>
          Effect.flatMap(
            Effect.sync(() => {
              now = 100
            }),
            () =>
              Effect.fail(
                new BrowserControlError({
                  code: "protocol",
                  message: "late malformed debug response",
                }),
              ),
          ),
        now: () => now,
        sleep: () => Effect.void,
      }),
    ),
  )
  assert.equal(result._tag, "Left")
  if (result._tag === "Left") assert.equal(result.left.code, "protocol")
})

test("opened-target discovery ignores stale and post-deadline targets", async () => {
  const url = run(parseLocalPageUrl(recordedTarget.url))
  const target = run(parseDebugTargets([recordedTarget], 9222))[0]
  if (!target) assert.fail("expected one valid debug target")

  let now = 0
  const opened = await Effect.runPromise(
    discoverOpenedTarget(url, new Set([target.id]), 100, 25, {
      listTargets: () =>
        Effect.sync(() => {
          now = 100
          return [target]
        }),
      now: () => now,
      sleep: () => Effect.void,
    }),
  )
  assert.equal(opened, undefined)
})

test("debug endpoint readiness retries only transient failures", () => {
  assert.equal(
    run(
      debugEndpointReadiness(
        Effect.fail(
          new BrowserControlError({
            code: "timeout",
            message: "debug endpoint is starting",
          }),
        ),
      ),
    ),
    false,
  )
  const protocol = run(
    Effect.either(
      debugEndpointReadiness(
        Effect.fail(
          new BrowserControlError({
            code: "protocol",
            message: "malformed debug response",
          }),
        ),
      ),
    ),
  )
  assert.equal(protocol._tag, "Left")
})

test("browser pages use an isolated operator profile through the Brave app identity", () => {
  const url = run(parseLocalPageUrl("http://127.0.0.1:5173/"))
  const request = run(
    launchServicesRequest(
      url,
      "/Users/example/Library/Application Support/Pi/Brave Operator",
      9222,
    ),
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
    run(parseLocalPageUrl("http://127.0.0.1:5173/health")),
    "http://127.0.0.1:5173/health",
  )
  assert.equal(
    run(parseLocalPageUrl("https://localhost/dashboard")),
    "https://localhost/dashboard",
  )
  assert.equal(
    run(parseLocalPageUrl("http://[::1]:3000/")),
    "http://[::1]:3000/",
  )

  for (const input of [
    "https://example.com",
    "file:///tmp/dashboard.html",
    "http://localhost.example.com",
    "http://user:password@127.0.0.1:5173",
  ]) {
    assert.throws(
      () => run(parseLocalPageUrl(input)),
      /loopback|credentials|HTTP/i,
    )
  }
})

test("debug target decoder accepts the documented Chromium response and rejects malformed data", () => {
  assert.deepEqual(run(parseDebugTargets([recordedTarget], 9222)), [
    {
      id: "DAB7",
      title: "Dashboard",
      type: "page",
      url: "http://127.0.0.1:5173/health",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/DAB7",
    },
  ])
  assert.throws(
    () => run(parseDebugTargets({ targets: [recordedTarget] }, 9222)),
    /array/i,
  )
  assert.throws(
    () => run(parseDebugTargets([{ ...recordedTarget, id: 42 }], 9222)),
    /target/i,
  )
  assert.throws(
    () =>
      run(
        parseDebugTargets(
          [
            {
              ...recordedTarget,
              webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/DAB7",
            },
          ],
          9222,
        ),
      ),
    /debugging endpoint/i,
  )
  assert.throws(
    () =>
      run(
        parseDebugTargets(
          [
            {
              ...recordedTarget,
              webSocketDebuggerUrl:
                "ws://user:password@127.0.0.1:9222/devtools/page/DAB7",
            },
          ],
          9222,
        ),
      ),
    /credentials/i,
  )
  assert.throws(
    () =>
      run(
        parseDebugTargets(
          [
            {
              ...recordedTarget,
              url: "http://user:password@127.0.0.1:5173/health",
            },
          ],
          9222,
        ),
      ),
    /credentials/i,
  )
})

test("an existing exact-URL operator target is reused instead of duplicated", () => {
  const [target] = run(parseDebugTargets([recordedTarget], 9222))
  const other = {
    ...target,
    id: "OTHER",
    url: run(parseLocalPageUrl("http://127.0.0.1:5173/other")),
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
  const [target] = run(parseDebugTargets([recordedTarget], 9222))
  assert.equal(run(selectActiveTarget([target], "DAB7")), target)
  assert.throws(() => run(selectActiveTarget([target], undefined)), /opened/i)
  assert.throws(() => run(selectActiveTarget([target], "OTHER")), /opened/i)
})

test("public target details cannot disclose the debugger websocket", () => {
  const [target] = run(parseDebugTargets([recordedTarget], 9222))
  assert.deepEqual(publicTarget(target), {
    id: "DAB7",
    title: "Dashboard",
    type: "page",
    url: "http://127.0.0.1:5173/health",
  })
  assert.equal("webSocketDebuggerUrl" in publicTarget(target), false)
})

test("CDP responses are narrowed at the websocket boundary", () => {
  assert.deepEqual(
    optional(parseCdpResponse('{"id":7,"result":{"value":"ok"}}')),
    {
      kind: "result",
      id: 7,
      result: { value: "ok" },
    },
  )
  assert.deepEqual(
    optional(
      parseCdpResponse(
        '{"id":8,"error":{"message":"bad command","data":"details"}}',
      ),
    ),
    {
      kind: "error",
      id: 8,
      message: "details",
    },
  )
  assert.equal(
    optional(parseCdpResponse('{"method":"Page.loadEventFired"}')),
    undefined,
  )
  assert.throws(
    () => optional(parseCdpResponse('{"id":"7","result":{}}')),
    /CDP/i,
  )
  assert.throws(() => optional(parseCdpResponse("not json")), /CDP/i)
  assert.throws(() => optional(parseCdpResponse('{"id":9}')), /CDP/i)
})

test("Runtime.evaluate results are narrowed without casts", () => {
  assert.deepEqual(
    run(
      parseEvaluationResult({
        result: { type: "object", value: { title: "Dashboard" } },
      }),
    ),
    {
      title: "Dashboard",
    },
  )
  assert.equal(
    run(
      parseEvaluationResult({
        result: { type: "string", description: "fallback" },
      }),
    ),
    "fallback",
  )
  assert.throws(
    () =>
      run(
        parseEvaluationResult({
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "boom" },
          },
        }),
      ),
    /boom/,
  )
  assert.throws(
    () => run(parseEvaluationResult({ result: "wrong" })),
    /Runtime.evaluate/i,
  )
})
