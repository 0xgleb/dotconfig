import { homedir } from "node:os"
import { join } from "node:path"
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Cause, Effect, Option, Runtime } from "effect"
import { Type } from "typebox"
import { registerRuntimeVersion } from "../shared/runtime-version.ts"
import {
  BROWSER_TARGET_ENTRY,
  browserActivityLabel,
  BrowserControlError,
  collectBoundedResponseBytes,
  createSerialActivityUpdater,
  latestBrowserTargetId,
  launchServicesRequest,
  parseCdpResponse,
  parseDebugTargets,
  parseEvaluationResult,
  parseLocalPageUrl,
  publicTarget,
  selectActiveTarget,
  selectReusableTarget,
  type BrowserAction,
  type CdpResponse,
  type DebugTarget,
  type LocalPageUrl,
} from "./core.ts"

const DEBUG_PORT = 9222
const DASHBOARD_URL = "http://127.0.0.1:5173"
const BROWSER_STATUS_KEY = "browser-control"
const ACTIVITY_INDICATOR_ID = "pi-browser-control-indicator"
const MAX_TEXT_LENGTH = 12_000
const MAX_LOOPBACK_RESPONSE_BYTES = 50 * 1_024
const REQUEST_TIMEOUT_MS = 5_000
const TARGET_DISCOVERY_TIMEOUT_MS = 5_000
const OPERATOR_PROFILE_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "Pi",
  "Brave Operator",
)
const DEBUG_SETUP_MESSAGE =
  "The isolated Brave operator profile opened through macOS LaunchServices, but DevTools inspection is not ready yet."

interface BrowserParams {
  readonly action: BrowserAction
  readonly url?: string
}

interface PendingCall {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

let activeTargetId: string | undefined

const debugBase: () => string = () => `http://127.0.0.1:${DEBUG_PORT}`

const browserFailureFrom = (
  error: unknown,
): BrowserControlError | undefined => {
  if (error instanceof BrowserControlError) return error
  if (!Runtime.isFiberFailure(error)) return undefined
  const failure = Option.getOrUndefined(
    Cause.failureOption(error[Runtime.FiberFailureCauseId]),
  )
  return failure instanceof BrowserControlError ? failure : undefined
}

const failBrowser = (
  code: BrowserControlError["code"],
  message: string,
): Promise<never> =>
  Effect.runPromise(Effect.fail(new BrowserControlError({ code, message })))

const requestJson: (
  path: string,
  init?: RequestInit,
) => Promise<unknown> = async (path, init) => {
  const requestSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const response = await Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        fetch(`${debugBase()}${path}`, {
          ...init,
          signal: requestSignal,
        }),
      catch: () =>
        new BrowserControlError({
          code: requestSignal.aborted ? "timeout" : "unavailable",
          message: requestSignal.aborted
            ? `Brave debug request timed out after ${REQUEST_TIMEOUT_MS}ms.`
            : "Brave debug endpoint request failed",
        }),
    }),
  )
  if (!response.ok)
    return failBrowser(
      "unavailable",
      `Brave debug endpoint returned HTTP ${response.status}`,
    )
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => response.json(),
      catch: () =>
        new BrowserControlError({
          code: requestSignal.aborted ? "timeout" : "protocol",
          message: requestSignal.aborted
            ? `Brave debug response timed out after ${REQUEST_TIMEOUT_MS}ms.`
            : "Brave debug endpoint returned malformed JSON",
        }),
    }),
  )
}

const isDebugEndpointReady: () => Promise<boolean> = async () => {
  try {
    await requestJson("/json/version")
    return true
  } catch {
    return false
  }
}

const listTargets: () => Promise<readonly DebugTarget[]> = async () =>
  Effect.runPromise(
    parseDebugTargets(await requestJson("/json/list"), DEBUG_PORT),
  )

const discoverOpenedTarget: (
  url: LocalPageUrl,
  previousTargetIds: ReadonlySet<string>,
) => Promise<DebugTarget | undefined> = async (url, previousTargetIds) => {
  const deadline = Date.now() + TARGET_DISCOVERY_TIMEOUT_MS
  let matchingTarget: DebugTarget | undefined
  while (Date.now() < deadline) {
    const targets = await listTargets()
    const freshTarget = targets.find(
      target => target.url === url && !previousTargetIds.has(target.id),
    )
    if (freshTarget) return freshTarget
    matchingTarget =
      targets.find(target => target.url === url) ?? matchingTarget
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return matchingTarget
}

const openTarget: (
  pi: ExtensionAPI,
  input: string,
) => Promise<{
  readonly url: LocalPageUrl
  readonly target?: DebugTarget
}> = async (pi, input) => {
  const url = await Effect.runPromise(parseLocalPageUrl(input))
  const debugReady = await isDebugEndpointReady()
  if (debugReady) {
    const existing = selectReusableTarget(
      await listTargets(),
      url,
      activeTargetId,
    )
    if (existing) {
      activeTargetId = existing.id
      return { url, target: existing }
    }
    const opened = (
      await Effect.runPromise(
        parseDebugTargets(
          [
            await requestJson(`/json/new?${encodeURIComponent(url)}`, {
              method: "PUT",
            }),
          ],
          DEBUG_PORT,
        ),
      )
    )[0]
    if (!opened || opened.url !== url)
      return failBrowser(
        "protocol",
        "Brave opened an unexpected operator target.",
      )
    activeTargetId = opened.id
    return { url, target: opened }
  }

  const previousTargetIds = new Set<string>()
  const request = await Effect.runPromise(
    launchServicesRequest(url, OPERATOR_PROFILE_PATH, DEBUG_PORT),
  )
  const result = await pi.exec(request.command, [...request.args], {
    timeout: REQUEST_TIMEOUT_MS,
  })
  if (result.code !== 0)
    return failBrowser(
      "unavailable",
      "macOS LaunchServices could not open the isolated Brave operator profile.",
    )
  const target = await discoverOpenedTarget(url, previousTargetIds)
  activeTargetId = target?.id
  return { url, ...(target ? { target } : {}) }
}

const activeTarget: () => Promise<DebugTarget> = async () => {
  if (!(await isDebugEndpointReady()))
    return failBrowser("unavailable", DEBUG_SETUP_MESSAGE)
  return Effect.runPromise(
    selectActiveTarget(await listTargets(), activeTargetId),
  )
}

class CdpClient {
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()

  private readonly socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener("message", event =>
      this.receive(String(event.data)),
    )
    socket.addEventListener("close", () =>
      this.failAll(new Error("Brave DevTools connection closed.")),
    )
    socket.addEventListener("error", () =>
      this.failAll(new Error("Brave DevTools connection failed.")),
    )
  }

  static connect(webSocketDebuggerUrl: string): Promise<CdpClient> {
    const WebSocketCtor = globalThis.WebSocket
    if (!WebSocketCtor)
      return failBrowser(
        "unavailable",
        "This Node runtime does not expose WebSocket.",
      )

    return new Promise((resolve, reject) => {
      const socket = new WebSocketCtor(webSocketDebuggerUrl)
      const timeout = setTimeout(() => {
        socket.close()
        reject(new Error("Timed out connecting to Brave DevTools."))
      }, REQUEST_TIMEOUT_MS)
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout)
          resolve(new CdpClient(socket))
        },
        { once: true },
      )
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout)
          reject(new Error("Failed to connect to Brave DevTools."))
        },
        { once: true },
      )
    })
  }

  call(
    method: "Runtime.evaluate",
    params: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params })
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for ${method}.`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timeout })
      try {
        this.socket.send(payload)
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(
          error instanceof Error
            ? error
            : new Error("Could not send a CDP command."),
        )
      }
    })
  }

  close(): void {
    this.failAll(new Error("Brave DevTools client closed."))
    this.socket.close()
  }

  private receive(data: string): void {
    void Effect.runPromise(parseCdpResponse(data)).then(
      parsed => {
        const response = Option.getOrUndefined(parsed)
        if (!response) return
        const pending = this.pending.get(response.id)
        if (!pending) return
        clearTimeout(pending.timeout)
        this.pending.delete(response.id)
        if (response.kind === "error")
          pending.reject(
            new BrowserControlError({
              code: "protocol",
              message: response.message,
            }),
          )
        else pending.resolve(response.result)
      },
      error => {
        this.failAll(
          error instanceof Error
            ? error
            : new BrowserControlError({
                code: "protocol",
                message: "Brave returned an invalid CDP response.",
              }),
        )
        this.socket.close()
      },
    )
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

const withPage: <T>(
  callback: (client: CdpClient, target: DebugTarget) => Promise<T>,
) => Promise<T> = async callback => {
  const target = await activeTarget()
  const client = await CdpClient.connect(target.webSocketDebuggerUrl)
  try {
    return await callback(client, target)
  } finally {
    client.close()
  }
}

const resultText: (value: unknown) => string = value => {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2) ?? String(value)
}

const fetchLoopbackText = async (
  input: string,
  signal: AbortSignal | undefined,
): Promise<{
  readonly status: number
  readonly url: LocalPageUrl
  readonly text: string
}> => {
  const url = await Effect.runPromise(parseLocalPageUrl(input))
  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(signal ? [signal] : []),
  ])
  const response = await Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        fetch(url, {
          method: "GET",
          redirect: "manual",
          signal: requestSignal,
        }),
      catch: cause =>
        new BrowserControlError({
          code: signal?.aborted
            ? "cancelled"
            : cause instanceof DOMException && cause.name === "TimeoutError"
              ? "timeout"
              : "unavailable",
          message: signal?.aborted
            ? "Loopback API request was cancelled."
            : cause instanceof DOMException && cause.name === "TimeoutError"
              ? `Loopback API request timed out after ${REQUEST_TIMEOUT_MS}ms.`
              : "Loopback API request failed.",
        }),
    }),
  )
  if (response.status >= 300 && response.status < 400)
    return failBrowser("protocol", "Loopback API redirects are not followed.")
  if (!response.ok)
    return failBrowser(
      "unavailable",
      `Loopback API returned HTTP ${response.status}`,
    )
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType)
    return failBrowser(
      "protocol",
      "Loopback API response content type is required.",
    )
  if (!contentType.startsWith("text/") && !contentType.includes("json"))
    return failBrowser("protocol", "Loopback API returned a non-text response.")
  const reader = response.body?.getReader()
  if (!reader) return { status: response.status, url, text: "" }
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await Effect.runPromise(
        Effect.tryPromise({
          try: () => reader.read(),
          catch: () =>
            new BrowserControlError({
              code: signal?.aborted
                ? "cancelled"
                : requestSignal.aborted
                  ? "timeout"
                  : "unavailable",
              message: signal?.aborted
                ? "Loopback API request was cancelled."
                : requestSignal.aborted
                  ? `Loopback API response timed out after ${REQUEST_TIMEOUT_MS}ms.`
                  : "Loopback API response stream failed.",
            }),
        }),
      )
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_LOOPBACK_RESPONSE_BYTES) {
        await Effect.runPromise(
          Effect.tryPromise({
            try: () => reader.cancel(),
            catch: () =>
              new BrowserControlError({
                code: "unavailable",
                message: "Could not cancel oversized loopback response.",
              }),
          }).pipe(Effect.ignore),
        )
        return failBrowser(
          "response_limit",
          `Loopback response exceeded the ${MAX_LOOPBACK_RESPONSE_BYTES}-byte limit.`,
        )
      }
      chunks.push(value)
    }
  } finally {
    void Effect.runPromise(
      Effect.try({
        try: () => reader.releaseLock(),
        catch: () =>
          new BrowserControlError({
            code: "unavailable",
            message: "Could not release loopback response reader.",
          }),
      }).pipe(Effect.ignore),
    )
  }
  const bytes = await Effect.runPromise(
    collectBoundedResponseBytes(chunks, MAX_LOOPBACK_RESPONSE_BYTES),
  )
  return {
    status: response.status,
    url,
    text: new TextDecoder().decode(bytes),
  }
}

const pageText: () => Promise<string> = async () => {
  return withPage(async client => {
    const result = await client.call("Runtime.evaluate", {
      expression: `(() => {
        const excluded = new Set(['● PI IS USING THIS BROWSER', 'PI OPERATOR · IDLE']);
        const text = (document.body?.innerText || '').split('\\n').filter((line) => !excluded.has(line.trim())).join('\\n');
        return { title: document.title, url: location.href, text: text.slice(0, ${MAX_TEXT_LENGTH}) };
      })()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: REQUEST_TIMEOUT_MS,
    })
    return resultText(await Effect.runPromise(parseEvaluationResult(result)))
  })
}

const activityIndicatorExpression: (
  active: boolean,
) => string = active => `(() => {
  let indicator = document.getElementById('${ACTIVITY_INDICATOR_ID}');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = '${ACTIVITY_INDICATOR_ID}';
    indicator.setAttribute('aria-live', 'polite');
    document.documentElement.appendChild(indicator);
  }
  indicator.textContent = '${active ? "● PI IS USING THIS BROWSER" : "PI OPERATOR · IDLE"}';
  indicator.dataset.activity = '${active ? "active" : "idle"}';
  indicator.style.cssText = [
    'position:fixed', 'top:10px', 'right:10px', 'z-index:2147483647',
    'padding:7px 11px', 'border-radius:6px', 'pointer-events:none',
    'font:700 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace',
    'letter-spacing:.04em', 'box-shadow:0 2px 12px rgba(0,0,0,.45)',
    'color:${active ? "#16001f" : "#d8cae8"}',
    'background:${active ? "#39ffb6" : "#3b274b"}',
    'border:1px solid ${active ? "#aaffdd" : "#74568a"}'
  ].join(';');
  return indicator.dataset.activity;
})()`

const setPageActivityIndicator: (
  active: boolean,
) => Promise<void> = async active => {
  await withPage(async client => {
    const result = await client.call("Runtime.evaluate", {
      expression: activityIndicatorExpression(active),
      awaitPromise: true,
      returnByValue: true,
      timeout: REQUEST_TIMEOUT_MS,
    })
    await Effect.runPromise(parseEvaluationResult(result))
  })
}

let activeBrowserOperations = 0
let activePageOperations = 0

const setPageActivityBestEffort: (
  active: boolean,
) => Promise<void> = async active => {
  try {
    await setPageActivityIndicator(active)
  } catch {
    // The TUI indicator remains authoritative while a page is opening or unavailable.
  }
}

const queuePageActivity = createSerialActivityUpdater(setPageActivityBestEffort)

const withBrowserActivity: <T>(
  ctx: ExtensionContext,
  action: BrowserAction,
  callback: () => Promise<T>,
) => Promise<T> = async (ctx, action, callback) => {
  const pageVisibleActivity = action === "open" || action === "text"
  activeBrowserOperations += 1
  if (pageVisibleActivity) activePageOperations += 1
  ctx.ui.setStatus(BROWSER_STATUS_KEY, browserActivityLabel("active", action))
  if (pageVisibleActivity) await queuePageActivity(true)
  try {
    return await callback()
  } finally {
    activeBrowserOperations = Math.max(0, activeBrowserOperations - 1)
    if (pageVisibleActivity)
      activePageOperations = Math.max(0, activePageOperations - 1)
    if (activeBrowserOperations === 0) {
      if (pageVisibleActivity) await queuePageActivity(false)
      ctx.ui.setStatus(BROWSER_STATUS_KEY, browserActivityLabel("idle"))
    } else if (pageVisibleActivity && activePageOperations === 0)
      await queuePageActivity(false)
  }
}

const browserControl: (pi: ExtensionAPI) => void = pi => {
  registerRuntimeVersion(pi, "browser-control", "2026.09.04.2")
  pi.on("session_start", (_event, ctx) => {
    activeTargetId = latestBrowserTargetId(ctx.sessionManager.getBranch())
    ctx.ui.setStatus(BROWSER_STATUS_KEY, browserActivityLabel("idle"))
    void queuePageActivity(false)
  })

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(BROWSER_STATUS_KEY, undefined)
  })
  pi.registerCommand("browser", {
    description:
      "Open a loopback page in the existing Brave app (/browser [local-url])",
    async handler(args, ctx) {
      await withBrowserActivity(ctx, "open", async () => {
        const url = args.trim() || DASHBOARD_URL
        try {
          const opened = await openTarget(pi, url)
          if (opened.target)
            pi.appendEntry(BROWSER_TARGET_ENTRY, { targetId: opened.target.id })
          await queuePageActivity(true)
          ctx.ui.notify(
            opened.target
              ? `Brave operator page ready: ${opened.target.title || opened.target.url}`
              : DEBUG_SETUP_MESSAGE,
            opened.target ? "info" : "warning",
          )
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error
              ? error.message
              : "Could not open the Brave operator page",
            "error",
          )
        }
      })
    },
  })

  pi.registerTool({
    name: "browser",
    label: "Browser",
    description:
      "Open and read loopback pages in the dedicated Brave operator browser, or issue a bounded direct GET to a loopback API.",
    promptSnippet:
      "Inspect loopback development pages and bounded loopback API responses",
    promptGuidelines: [
      "Use browser only for operator UI inspection, dashboard verification, and loopback development pages.",
      "The browser tool cannot navigate to remote sites, inspect unrelated tabs, run model-supplied JavaScript, follow API redirects, or send API credentials.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("open"),
        Type.Literal("text"),
        Type.Literal("fetch"),
      ]),
      url: Type.Optional(
        Type.String({
          description:
            "Loopback HTTP URL for action=open or action=fetch. Open defaults to the dashboard dev server.",
        }),
      ),
    }),
    async execute(_toolCallId, params: BrowserParams, signal, _onUpdate, ctx) {
      return withBrowserActivity(ctx, params.action, async () => {
        try {
          if (params.action === "status") {
            const ready = await isDebugEndpointReady()
            if (!ready) {
              return {
                content: [{ type: "text", text: DEBUG_SETUP_MESSAGE }],
                details: { ready },
              }
            }
            const targets = await listTargets()
            const target = activeTargetId
              ? targets.find(candidate => candidate.id === activeTargetId)
              : undefined
            const visibleTarget = target ? publicTarget(target) : undefined
            return {
              content: [
                {
                  type: "text",
                  text: visibleTarget
                    ? `${visibleTarget.id} ${visibleTarget.title || "(untitled)"} ${visibleTarget.url}`
                    : "No local page has been opened by this Pi session.",
                },
              ],
              details: { ready, target: visibleTarget },
            }
          }

          if (params.action === "fetch") {
            if (!params.url)
              return failBrowser(
                "invalid_input",
                "Browser fetch requires a loopback URL.",
              )
            const result = await fetchLoopbackText(params.url, signal)
            return {
              content: [
                {
                  type: "text",
                  text:
                    result.text || `(HTTP ${result.status}, empty response)`,
                },
              ],
              details: {
                status: result.status,
                url: result.url,
                bytes: new TextEncoder().encode(result.text).byteLength,
              },
            }
          }

          if (params.action === "open") {
            const opened = await openTarget(pi, params.url || DASHBOARD_URL)
            if (opened.target)
              pi.appendEntry(BROWSER_TARGET_ENTRY, {
                targetId: opened.target.id,
              })
            await queuePageActivity(true)
            const visibleTarget = opened.target
              ? publicTarget(opened.target)
              : undefined
            return {
              content: [
                {
                  type: "text",
                  text: visibleTarget
                    ? `Opened ${visibleTarget.title || visibleTarget.url}`
                    : `Opened ${opened.url} in the existing Brave app. ${DEBUG_SETUP_MESSAGE}`,
                },
              ],
              details: {
                ready: visibleTarget !== undefined,
                url: opened.url,
                target: visibleTarget,
              },
            }
          }

          return {
            content: [{ type: "text", text: await pageText() }],
            details: { status: "ok" },
          }
        } catch (error) {
          const browserFailure = browserFailureFrom(error)
          return Effect.runPromise(
            browserFailure ? Effect.fail(browserFailure) : Effect.die(error),
          )
        }
      })
    },
  })
}

export default browserControl
