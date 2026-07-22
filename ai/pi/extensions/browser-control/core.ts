export const BROWSER_ACTIONS = ["status", "open", "text"] as const;

export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

declare const localPageUrlBrand: unique symbol;
export type LocalPageUrl = string & { readonly [localPageUrlBrand]: true };

export interface DebugTarget {
  readonly id: string;
  readonly title: string;
  readonly url: LocalPageUrl;
  readonly type: "page";
  readonly webSocketDebuggerUrl: string;
}

export interface LaunchServicesRequest {
  readonly command: "/usr/bin/open";
  readonly args: readonly ["-a", "Brave Browser", LocalPageUrl];
}

export type PublicDebugTarget = Omit<DebugTarget, "webSocketDebuggerUrl">;

export type CdpResponse =
  | { readonly kind: "result"; readonly id: number; readonly result: unknown }
  | { readonly kind: "error"; readonly id: number; readonly message: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function launchServicesRequest(url: LocalPageUrl): LaunchServicesRequest {
  return { command: "/usr/bin/open", args: ["-a", "Brave Browser", url] };
}

export function parseLocalPageUrl(input: string): LocalPageUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Browser URLs must be absolute loopback HTTP URLs.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser URLs must use HTTP or HTTPS.");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("Browser URLs must use an exact loopback host.");
  }
  if (url.username || url.password) {
    throw new Error("Browser URLs must not contain credentials.");
  }
  return url.href as LocalPageUrl;
}

export function parseDebugTargets(value: unknown, debugPort: number): readonly DebugTarget[] {
  if (!Array.isArray(value)) throw new Error("Brave debug target response must be an array.");
  return value.flatMap((candidate) => {
    const target = parseDebugTarget(candidate, debugPort);
    return target ? [target] : [];
  });
}

export function selectActiveTarget(
  targets: readonly DebugTarget[],
  activeTargetId: string | undefined,
): DebugTarget {
  if (!activeTargetId) throw new Error("No explicitly opened local page is available.");
  const target = targets.find((candidate) => candidate.id === activeTargetId);
  if (!target) throw new Error("The explicitly opened local page is no longer available.");
  return target;
}

export function publicTarget(target: DebugTarget): PublicDebugTarget {
  return {
    id: target.id,
    title: target.title,
    type: target.type,
    url: target.url,
  };
}

export function parseCdpResponse(data: string): CdpResponse | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new Error("Brave returned malformed CDP JSON.");
  }
  if (!isRecord(value)) throw new Error("Brave returned a malformed CDP response.");
  if (!("id" in value)) return undefined;
  if (!Number.isSafeInteger(value.id) || Number(value.id) < 1) {
    throw new Error("Brave returned a CDP response with an invalid id.");
  }
  const id = Number(value.id);
  if ("error" in value) {
    if (!isRecord(value.error)) throw new Error("Brave returned a malformed CDP error.");
    const dataMessage = typeof value.error.data === "string" ? value.error.data : undefined;
    const message = typeof value.error.message === "string" ? value.error.message : undefined;
    return { kind: "error", id, message: dataMessage ?? message ?? "CDP command failed" };
  }
  return { kind: "result", id, result: value.result };
}

export function parseEvaluationResult(value: unknown): unknown {
  if (!isRecord(value)) throw new Error("Brave returned a malformed Runtime.evaluate result.");
  if ("exceptionDetails" in value) {
    if (!isRecord(value.exceptionDetails)) {
      throw new Error("Brave returned malformed Runtime.evaluate exception details.");
    }
    const exception = isRecord(value.exceptionDetails.exception) ? value.exceptionDetails.exception : undefined;
    const description = exception && typeof exception.description === "string" ? exception.description : undefined;
    const text = typeof value.exceptionDetails.text === "string" ? value.exceptionDetails.text : undefined;
    throw new Error(description ?? text ?? "Runtime.evaluate failed.");
  }
  if (!isRecord(value.result) || typeof value.result.type !== "string") {
    throw new Error("Brave returned a malformed Runtime.evaluate result.");
  }
  if ("value" in value.result) return value.result.value;
  return typeof value.result.description === "string" ? value.result.description : undefined;
}

function parseDebugTarget(value: unknown, debugPort: number): DebugTarget | undefined {
  if (!isRecord(value)) throw new Error("Brave returned a malformed debug target.");
  if (value.type !== "page") return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.url !== "string" ||
    typeof value.webSocketDebuggerUrl !== "string"
  ) {
    throw new Error("Brave returned a malformed page target.");
  }

  let url: LocalPageUrl;
  try {
    url = parseLocalPageUrl(value.url);
  } catch {
    return undefined;
  }
  validateDebuggerUrl(value.webSocketDebuggerUrl, value.id, debugPort);
  return {
    id: value.id,
    title: value.title,
    type: value.type,
    url,
    webSocketDebuggerUrl: value.webSocketDebuggerUrl,
  };
}

function validateDebuggerUrl(input: string, targetId: string, debugPort: number): void {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Brave returned an invalid debugging endpoint.");
  }
  if (
    url.protocol !== "ws:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.port !== String(debugPort) ||
    url.pathname !== `/devtools/page/${targetId}`
  ) {
    throw new Error("Brave returned an unexpected debugging endpoint.");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
