import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
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
} from "./core.ts";

const DEBUG_PORT = 9222;
const DASHBOARD_URL = "http://127.0.0.1:5173";
const MAX_TEXT_LENGTH = 12_000;
const REQUEST_TIMEOUT_MS = 5_000;
const TARGET_DISCOVERY_TIMEOUT_MS = 5_000;
const OPERATOR_PROFILE_PATH = join(homedir(), "Library", "Application Support", "Pi", "Brave Operator");
const DEBUG_SETUP_MESSAGE =
  "The isolated Brave operator profile opened through macOS LaunchServices, but DevTools inspection is not ready yet.";

interface BrowserParams {
  readonly action: BrowserAction;
  readonly url?: string;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

let activeTargetId: string | undefined;

const debugBase: () => string = () => `http://127.0.0.1:${DEBUG_PORT}`;

const requestJson: (path: string, init?: RequestInit) => Promise<unknown> = async (path, init) => {
  const response = await fetch(`${debugBase()}${path}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Brave debug endpoint returned HTTP ${response.status}`);
  return response.json();
};

const isDebugEndpointReady: () => Promise<boolean> = async () => {
  try {
    await requestJson("/json/version");
    return true;
  } catch {
    return false;
  }
};

const listTargets: () => Promise<readonly DebugTarget[]> = async () =>
  parseDebugTargets(await requestJson("/json/list"), DEBUG_PORT);

const discoverOpenedTarget: (
  url: LocalPageUrl,
  previousTargetIds: ReadonlySet<string>,
) => Promise<DebugTarget | undefined> = async (url, previousTargetIds) => {
  const deadline = Date.now() + TARGET_DISCOVERY_TIMEOUT_MS;
  let matchingTarget: DebugTarget | undefined;
  while (Date.now() < deadline) {
    const targets = await listTargets();
    const freshTarget = targets.find((target) => target.url === url && !previousTargetIds.has(target.id));
    if (freshTarget) return freshTarget;
    matchingTarget = targets.find((target) => target.url === url) ?? matchingTarget;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return matchingTarget;
};

const openTarget: (
  pi: ExtensionAPI,
  input: string,
) => Promise<{ readonly url: LocalPageUrl; readonly target?: DebugTarget }> = async (pi, input) => {
  const url = parseLocalPageUrl(input);
  const debugReady = await isDebugEndpointReady();
  if (debugReady) {
    const existing = selectReusableTarget(await listTargets(), url, activeTargetId);
    if (existing) {
      activeTargetId = existing.id;
      return { url, target: existing };
    }
    const opened = parseDebugTargets(
      [await requestJson(`/json/new?${encodeURIComponent(url)}`, { method: "PUT" })],
      DEBUG_PORT,
    )[0];
    if (!opened || opened.url !== url) throw new Error("Brave opened an unexpected operator target.");
    activeTargetId = opened.id;
    return { url, target: opened };
  }

  const previousTargetIds = new Set<string>();
  const request = launchServicesRequest(url, OPERATOR_PROFILE_PATH, DEBUG_PORT);
  const result = await pi.exec(request.command, [...request.args], { timeout: REQUEST_TIMEOUT_MS });
  if (result.code !== 0) throw new Error("macOS LaunchServices could not open the isolated Brave operator profile.");
  const target = await discoverOpenedTarget(url, previousTargetIds);
  activeTargetId = target?.id;
  return { url, ...(target ? { target } : {}) };
};

const activeTarget: () => Promise<DebugTarget> = async () => {
  if (!(await isDebugEndpointReady())) throw new Error(DEBUG_SETUP_MESSAGE);
  return selectActiveTarget(await listTargets(), activeTargetId);
};

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => this.failAll(new Error("Brave DevTools connection closed.")));
    socket.addEventListener("error", () => this.failAll(new Error("Brave DevTools connection failed.")));
  }

  static connect(webSocketDebuggerUrl: string): Promise<CdpClient> {
    const WebSocketCtor = globalThis.WebSocket;
    if (!WebSocketCtor) throw new Error("This Node runtime does not expose WebSocket.");

    return new Promise((resolve, reject) => {
      const socket = new WebSocketCtor(webSocketDebuggerUrl);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out connecting to Brave DevTools."));
      }, REQUEST_TIMEOUT_MS);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve(new CdpClient(socket));
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("Failed to connect to Brave DevTools."));
        },
        { once: true },
      );
    });
  }

  call(method: "Runtime.evaluate", params: Readonly<Record<string, unknown>>): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.socket.send(payload);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Could not send a CDP command."));
      }
    });
  }

  close(): void {
    this.failAll(new Error("Brave DevTools client closed."));
    this.socket.close();
  }

  private receive(data: string): void {
    let response: CdpResponse | undefined;
    try {
      response = parseCdpResponse(data);
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error("Brave returned an invalid CDP response."));
      this.socket.close();
      return;
    }
    if (!response) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    if (response.kind === "error") pending.reject(new Error(response.message));
    else pending.resolve(response.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const withPage: <T>(callback: (client: CdpClient, target: DebugTarget) => Promise<T>) => Promise<T> = async (
  callback,
) => {
  const target = await activeTarget();
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    return await callback(client, target);
  } finally {
    client.close();
  }
};

const resultText: (value: unknown) => string = (value) => {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
};

const pageText: () => Promise<string> = async () => {
  return withPage(async (client) => {
    const result = await client.call("Runtime.evaluate", {
      expression: `(() => ({ title: document.title, url: location.href, text: (document.body?.innerText || '').slice(0, ${MAX_TEXT_LENGTH}) }))()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: REQUEST_TIMEOUT_MS,
    });
    return resultText(parseEvaluationResult(result));
  });
};

const browserControl: (pi: ExtensionAPI) => void = (pi) => {
  pi.registerCommand("browser", {
    description: "Open a loopback page in the existing Brave app (/browser [local-url])",
    async handler(args, ctx) {
      const url = args.trim() || DASHBOARD_URL;
      try {
        const opened = await openTarget(pi, url);
        ctx.ui.notify(
          opened.target ? `Brave operator page ready: ${opened.target.title || opened.target.url}` : DEBUG_SETUP_MESSAGE,
          opened.target ? "info" : "warning",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not open the Brave operator page", "error");
      }
    },
  });

  pi.registerTool({
    name: "browser",
    label: "Browser",
    description: "Open and read loopback pages in the dedicated Brave operator browser.",
    promptSnippet: "Open and inspect a loopback development page in the dedicated Brave operator browser",
    promptGuidelines: [
      "Use browser only for operator UI inspection, dashboard verification, and loopback development pages.",
      "The browser tool cannot navigate to remote sites, inspect unrelated tabs, or run model-supplied JavaScript.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("status"), Type.Literal("open"), Type.Literal("text")]),
      url: Type.Optional(Type.String({ description: "Loopback HTTP URL for action=open. Defaults to the dashboard dev server." })),
    }),
    async execute(_toolCallId, params: BrowserParams) {
      try {
        if (params.action === "status") {
          const ready = await isDebugEndpointReady();
          if (!ready) {
            return { content: [{ type: "text", text: DEBUG_SETUP_MESSAGE }], details: { ready } };
          }
          const targets = await listTargets();
          const target = activeTargetId ? targets.find((candidate) => candidate.id === activeTargetId) : undefined;
          const visibleTarget = target ? publicTarget(target) : undefined;
          return {
            content: [{ type: "text", text: visibleTarget ? `${visibleTarget.id} ${visibleTarget.title || "(untitled)"} ${visibleTarget.url}` : "No local page has been opened by this Pi session." }],
            details: { ready, target: visibleTarget },
          };
        }

        if (params.action === "open") {
          const opened = await openTarget(pi, params.url || DASHBOARD_URL);
          const visibleTarget = opened.target ? publicTarget(opened.target) : undefined;
          return {
            content: [
              {
                type: "text",
                text: visibleTarget
                  ? `Opened ${visibleTarget.title || visibleTarget.url}`
                  : `Opened ${opened.url} in the existing Brave app. ${DEBUG_SETUP_MESSAGE}`,
              },
            ],
            details: { ready: visibleTarget !== undefined, url: opened.url, target: visibleTarget },
          };
        }

        return { content: [{ type: "text", text: await pageText() }], details: { status: "ok" } };
      } catch (error) {
        throw error instanceof Error ? error : new Error("Browser action failed");
      }
    },
  });
};

export default browserControl;
